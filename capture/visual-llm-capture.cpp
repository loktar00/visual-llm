// visual-llm-capture — record MoE routing from llama.cpp as visual-llm JSONL
// recordings (see ../SCHEMA.md). Two modes:
//
//   CLI      one/many generations from -p / --prompts-file, one .jsonl each
//   --server an OpenAI-compatible HTTP server (/v1/chat/completions,
//            /v1/completions, /v1/models) that writes one recording per
//            request into --capture-dir. Drop-in as a llama-swap upstream so a
//            "tracking" model records routing for every prompt you send it.
//
// How capture works: llama.cpp's eval callback (llama_context_params.cb_eval)
// fires for every graph tensor. MoE graphs name their routing tensors
//   ffn_moe_topk-<layer>      selected expert indices  (I32)
//   ffn_moe_weights[_norm]-<l> gate weights of selected (F32)
//   ffn_moe_logits-<layer>    router logits (n_expert snooped; masked here)
// We copy those few bytes off-device per layer and, after each decode, emit a
// `token` line plus one `moe` line per MoE layer per position. Prompt positions
// are captured too. Layers are re-indexed to consecutive MoE-layer indices.
//
// --mask forces experts off (router ablation ≡ inference-time pruning): masked
// experts' logits are set to -1e30 before softmax/top-k, so the router can't
// pick them and the gate renormalizes over survivors. Weights untouched.

#include "llama.h"
#include "ggml.h"
#include "ggml-backend.h"
#include "chat.h" // llama-common: jinja chat templating (same engine as llama-server --jinja)

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <dirent.h>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <vector>

#include "cpp-httplib/httplib.h"
#include "nlohmann/json.hpp"
// note: chat.h already provides a global `json` alias (nlohmann); reuse it

// ---------------------------------------------------------------- capture ---

struct layer_step {
    std::vector<int32_t> topk;    // [k * n_tokens]
    std::vector<float>   weights; // [k * n_tokens]
    int k = 0, n_tokens = 0;
};

struct capture_state {
    std::map<int, layer_step> layers; // true layer id -> this step's data
    int n_expert = 0;                 // snooped from ffn_moe_logits shape

    // reap simulation (router ablation)
    bool mask_active = false;
    std::map<int, int> true2viz;
    std::vector<std::vector<uint8_t>> mask; // [viz][expert] -> 1 = masked
};

static bool name_layer(const char * name, const char * prefix, int * il) {
    const size_t n = strlen(prefix);
    if (strncmp(name, prefix, n) != 0 || name[n] != '-') return false;
    *il = atoi(name + n + 1);
    return true;
}

static bool cb_eval(struct ggml_tensor * t, bool ask, void * user_data) {
    auto * cap = (capture_state *) user_data;
    int il = -1;

    if (ask) {
        if (name_layer(t->name, "ffn_moe_logits", &il)) {
            if (cap->n_expert == 0) cap->n_expert = (int) t->ne[0];
            return cap->mask_active; // need the data only to modify it
        }
        return name_layer(t->name, "ffn_moe_topk", &il) ||
               name_layer(t->name, "ffn_moe_weights_norm", &il) ||
               name_layer(t->name, "ffn_moe_weights", &il);
    }

    if (cap->mask_active && name_layer(t->name, "ffn_moe_logits", &il)) {
        if (t->type != GGML_TYPE_F32) return true;
        const auto vit = cap->true2viz.find(il);
        if (vit == cap->true2viz.end()) return true;
        const std::vector<uint8_t> & m = cap->mask[vit->second];
        if (m.empty()) return true;
        const int ne_ = (int) t->ne[0];
        const int n   = (int) t->ne[1];
        std::vector<float> logits((size_t) ne_ * n);
        ggml_backend_tensor_get(t, logits.data(), 0, sizeof(float) * ne_ * n);
        for (int i = 0; i < n; i++)
            for (int e = 0; e < ne_ && e < (int) m.size(); e++)
                if (m[e]) logits[(size_t) i * ne_ + e] = -1e30f;
        ggml_backend_tensor_set(t, logits.data(), 0, sizeof(float) * ne_ * n);
        return true;
    }

    if (name_layer(t->name, "ffn_moe_topk", &il)) {
        if (t->type != GGML_TYPE_I32) return true;
        const int k = (int) t->ne[0], n = (int) t->ne[1];
        auto & L = cap->layers[il];
        L.k = k; L.n_tokens = n;
        L.topk.resize((size_t) k * n);
        ggml_backend_tensor_get(t, L.topk.data(), 0, sizeof(int32_t) * k * n);
        return true;
    }
    // "_norm" is built later and overwrites the plain weights — what we want
    if (name_layer(t->name, "ffn_moe_weights_norm", &il) ||
        name_layer(t->name, "ffn_moe_weights", &il)) {
        if (t->type != GGML_TYPE_F32) return true;
        const int k = (int) t->ne[1], n = (int) t->ne[2];
        auto & L = cap->layers[il];
        L.weights.resize((size_t) k * n);
        ggml_backend_tensor_get(t, L.weights.data(), 0, sizeof(float) * k * n);
        return true;
    }
    return true;
}

// ------------------------------------------------------------------- util ---

static std::string json_escape(const std::string & s) {
    std::string out; out.reserve(s.size() + 8);
    for (const unsigned char c : s) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) { char b[8]; snprintf(b, sizeof(b), "\\u%04x", c); out += b; }
                else out += (char) c;
        }
    }
    return out;
}

static std::string slugify(const std::string & s) {
    std::string out;
    for (char c : s) out += (isalnum((unsigned char) c) || c == '-' || c == '_') ? c : '-';
    if (out.empty()) out = "model";
    if (out.size() > 40) out.resize(40);
    return out;
}

// ------------------------------------------------------------- generation ---

struct gen_params { int n_predict = 200, top_k = 40; float top_p = 0.95f, temp = 0.8f; uint32_t seed = 42; };

struct gen_result {
    std::vector<std::string> lines; // token+moe JSONL event lines
    std::string text;               // generated assistant text
    int n_tokens = 0, n_prompt = 0, n_gen = 0, top_k_seen = 0;
    std::string error;
};

struct Generator {
    llama_model *      model = nullptr;
    llama_context *    ctx   = nullptr;
    const llama_vocab* vocab = nullptr;
    capture_state      cap;
    std::vector<int>   moe_layers;   // sorted true-layer ids -> viz index
    std::string        removed;      // removed_experts json fragment (mask)
    std::string        name;         // model name for meta / served id
    int  n_batch = 512;
    gen_params def;                  // server request defaults

    // jinja chat templating (llama-server parity)
    common_chat_templates_ptr tmpls;
    bool use_jinja = false;
    bool think_enabled = true;
    std::map<std::string, std::string> tkwargs; // values are JSON-encoded, as in llama-server

    std::vector<llama_token> tokenize(const std::string & text, bool add_special) {
        int n = -llama_tokenize(vocab, text.c_str(), (int) text.size(), nullptr, 0, add_special, true);
        std::vector<llama_token> t((size_t) std::max(0, n));
        if (n > 0) llama_tokenize(vocab, text.c_str(), (int) text.size(), t.data(), n, add_special, true);
        return t;
    }
    std::string piece(llama_token tok) {
        char b[256];
        int len = llama_token_to_piece(vocab, tok, b, sizeof(b), 0, true);
        return len > 0 ? std::string(b, len) : std::string();
    }

    // OpenAI messages -> prompt string. With --jinja this is the same engine
    // llama-server uses (honors --chat-template-kwargs like enable_thinking /
    // preserve_thinking); otherwise the basic built-in templates.
    std::string apply_chat_template(const std::vector<std::pair<std::string,std::string>> & msgs) {
        if (use_jinja && tmpls) {
            common_chat_templates_inputs in;
            for (auto & m : msgs) {
                common_chat_msg cm;
                cm.role = m.first;
                cm.content = m.second;
                in.messages.push_back(std::move(cm));
            }
            in.add_generation_prompt = true;
            in.use_jinja = true;
            in.enable_thinking = think_enabled;
            in.chat_template_kwargs = tkwargs;
            try {
                return common_chat_templates_apply(tmpls.get(), in).prompt;
            } catch (const std::exception & e) {
                fprintf(stderr, "jinja template failed (%s) — falling back to builtin\n", e.what());
            }
        }
        std::vector<llama_chat_message> chat;
        chat.reserve(msgs.size());
        for (auto & m : msgs) chat.push_back(llama_chat_message{ m.first.c_str(), m.second.c_str() });
        const char * tmpl = llama_model_chat_template(model, nullptr);
        if (tmpl) {
            std::vector<char> buf(8192);
            int need = llama_chat_apply_template(tmpl, chat.data(), chat.size(), true, buf.data(), (int) buf.size());
            if (need > (int) buf.size()) { buf.resize(need + 1); need = llama_chat_apply_template(tmpl, chat.data(), chat.size(), true, buf.data(), (int) buf.size()); }
            if (need >= 0) return std::string(buf.data(), need);
        }
        std::string out; // chatml fallback
        for (auto & m : msgs) out += "<|im_start|>" + m.first + "\n" + m.second + "<|im_end|>\n";
        out += "<|im_start|>assistant\n";
        return out;
    }

    bool init(const struct args_t & args); // defined after args_t

    // (Re)apply a reap mask. Returns the number of experts masked. Never lets
    // a layer lose every expert (that would NaN the router softmax). Callers
    // in server mode must hold the generation mutex.
    int apply_mask_pairs(const std::vector<std::pair<int,int>> & pairs) {
        for (auto & m : cap.mask) std::fill(m.begin(), m.end(), 0);
        int applied = 0;
        for (const auto & p : pairs) {
            if (p.first < 0 || p.first >= (int) cap.mask.size() || p.second < 0 || p.second >= cap.n_expert) {
                fprintf(stderr, "mask pair out of range, skipped: %d %d\n", p.first, p.second);
                continue;
            }
            if (!cap.mask[p.first][p.second]) { cap.mask[p.first][p.second] = 1; applied++; }
        }
        for (size_t li = 0; li < cap.mask.size(); li++) {
            int masked = 0;
            for (const auto v : cap.mask[li]) masked += v;
            if (masked >= cap.n_expert) {
                fprintf(stderr, "layer %d: mask covers all experts — unmasking\n", (int) li);
                std::fill(cap.mask[li].begin(), cap.mask[li].end(), 0);
                applied -= masked;
            }
        }
        cap.mask_active = applied > 0;
        removed.clear();
        if (cap.mask_active) {
            removed = ",\"removed_experts\":[";
            bool first = true;
            for (size_t li = 0; li < cap.mask.size(); li++)
                for (int e = 0; e < (int) cap.mask[li].size(); e++)
                    if (cap.mask[li][e]) {
                        char pr[32];
                        snprintf(pr, sizeof(pr), "%s[%d,%d]", first ? "" : ",", (int) li, e);
                        removed += pr;
                        first = false;
                    }
            removed += "]";
        }
        return applied;
    }

    gen_result generate(const std::vector<llama_token> & prompt_toks, const gen_params & gp,
                        const std::function<void(const std::string &)> & on_text) {
        gen_result R;
        R.n_prompt = (int) prompt_toks.size();
        if (R.n_prompt == 0) { R.error = "empty prompt"; return R; }

        llama_sampler * smpl = llama_sampler_chain_init(llama_sampler_chain_default_params());
        if (gp.top_k > 0) llama_sampler_chain_add(smpl, llama_sampler_init_top_k(gp.top_k));
        llama_sampler_chain_add(smpl, llama_sampler_init_top_p(gp.top_p, 1));
        llama_sampler_chain_add(smpl, llama_sampler_init_temp(gp.temp));
        llama_sampler_chain_add(smpl, llama_sampler_init_dist(gp.seed));

        llama_memory_clear(llama_get_memory(ctx), true);
        cap.layers.clear();

        int t_index = 0, top_k_seen = 0;
        char buf[512];
        auto flush = [&](const std::vector<llama_token> & toks, int first) {
            int n_tok = 0;
            for (const auto & kv : cap.layers) { n_tok = kv.second.n_tokens; break; }
            for (int i = 0; i < n_tok; i++) {
                const llama_token tok = toks[first + i];
                snprintf(buf, sizeof(buf), "{\"type\":\"token\",\"t\":%d,\"id\":%d,\"text\":\"%s\",\"pos\":%d}",
                         t_index, (int) tok, json_escape(piece(tok)).c_str(), t_index);
                R.lines.emplace_back(buf);
                for (size_t li = 0; li < moe_layers.size(); li++) {
                    const auto it = cap.layers.find(moe_layers[li]);
                    if (it == cap.layers.end()) continue;
                    const layer_step & L = it->second;
                    if ((int) L.topk.size() < (i + 1) * L.k || (int) L.weights.size() < (i + 1) * L.k) continue;
                    top_k_seen = L.k;
                    std::string ex = "[", ws = "[";
                    for (int e = 0; e < L.k; e++) {
                        char n1[32], n2[48];
                        snprintf(n1, sizeof(n1), "%s%d", e ? "," : "", L.topk[(size_t) i * L.k + e]);
                        snprintf(n2, sizeof(n2), "%s%.4f", e ? "," : "", L.weights[(size_t) i * L.k + e]);
                        ex += n1; ws += n2;
                    }
                    ex += "]"; ws += "]";
                    snprintf(buf, sizeof(buf), "{\"type\":\"moe\",\"t\":%d,\"layer\":%d,\"experts\":%s,\"weights\":%s}",
                             t_index, (int) li, ex.c_str(), ws.c_str());
                    R.lines.emplace_back(buf);
                }
                t_index++;
            }
            cap.layers.clear();
        };

        std::vector<llama_token> ptoks = prompt_toks; // batch_get_one wants non-const
        for (int i0 = 0; i0 < R.n_prompt; i0 += n_batch) {
            const int chunk = std::min(n_batch, R.n_prompt - i0);
            llama_batch b = llama_batch_get_one(ptoks.data() + i0, chunk);
            if (llama_decode(ctx, b) != 0) { R.error = "prefill decode failed"; llama_sampler_free(smpl); return R; }
            flush(ptoks, i0);
        }
        std::vector<llama_token> gen(1);
        for (int i = 0; i < gp.n_predict; i++) {
            const llama_token tok = llama_sampler_sample(smpl, ctx, -1);
            if (llama_vocab_is_eog(vocab, tok)) break;
            std::string p = piece(tok);
            R.text += p;
            if (on_text) on_text(p);
            gen[0] = tok;
            llama_batch b = llama_batch_get_one(gen.data(), 1);
            if (llama_decode(ctx, b) != 0) { R.error = "decode failed"; break; }
            flush(gen, 0);
            R.n_gen++;
        }
        R.n_tokens = t_index; R.top_k_seen = top_k_seen;
        llama_sampler_free(smpl);
        return R;
    }

    bool write_recording(const std::string & path, const std::string & prompt, const gen_result & r) {
        FILE * f = fopen(path.c_str(), "wb");
        if (!f) { fprintf(stderr, "cannot open %s\n", path.c_str()); return false; }
        time_t now = time(nullptr); char stamp[32];
        strftime(stamp, sizeof(stamp), "%Y-%m-%dT%H:%M:%SZ", gmtime(&now));
        std::string p = prompt.size() > 600 ? prompt.substr(0, 600) : prompt;
        int tk = r.top_k_seen > 0 ? r.top_k_seen : def.top_k;
        fprintf(f,
            "{\"type\":\"meta\",\"version\":1,\"model\":{\"name\":\"%s%s\",\"n_layers\":%d,"
            "\"n_experts\":%d,\"top_k\":%d,\"d_model\":0},\"prompt\":\"%s\",\"created\":\"%s\"%s}\n",
            json_escape(name).c_str(), cap.mask_active ? " (reap-sim)" : "",
            (int) moe_layers.size(), cap.n_expert, tk, json_escape(p).c_str(), stamp, removed.c_str());
        for (const auto & l : r.lines) { fputs(l.c_str(), f); fputc('\n', f); }
        fprintf(f, "{\"type\":\"done\",\"n_tokens\":%d}\n", r.n_tokens);
        fclose(f);
        return true;
    }
};

// -------------------------------------------------------------------- args --

struct args_t {
    std::string model;
    std::string prompt = "Once upon a time";
    std::string prompts_file;
    std::string prompts_dir; // --prompts-dir: one prompt per .txt/.md file
    std::string out = "capture.jsonl";
    std::string mask_path;
    std::vector<std::pair<int,int>> mask_pairs;
    // server
    bool        server = false;
    std::string host = "0.0.0.0";
    int         port = 8081;
    std::string capture_dir = "captures";
    std::string alias;        // served model id (default: model general.name)
    bool        jinja = false;
    std::string chat_kwargs;  // --chat-template-kwargs '{"enable_thinking": false}'
    std::string reap_script = "reap_gguf.py"; // --reap-script: path for POST /reap
    // generation / model
    int   n_predict = 200, n_ctx = 4096, ngl = 99, threads = 0, top_k = 40;
    int   n_cpu_moe = 0;    // --n-cpu-moe N: first N blocks' expert tensors in RAM
    std::string ot_cpu;     // --ot-cpu <regex>: tensors matching regex pinned to RAM
                            // (spread the offloaded blocks evenly to balance GPUs)
    float top_p = 0.95f, temp = 0.8f;
    uint32_t seed = 42;
};

static void load_mask_file(const std::string & path, std::vector<std::pair<int,int>> & pairs) {
    FILE * f = fopen(path.c_str(), "rb");
    if (!f) { fprintf(stderr, "cannot open mask file: %s\n", path.c_str()); exit(1); }
    char line[256];
    while (fgets(line, sizeof(line), f)) {
        if (line[0] == '#') continue;
        int l = -1, e = -1;
        if (sscanf(line, "%d %d", &l, &e) == 2 && l >= 0 && e >= 0) pairs.push_back({l, e});
    }
    fclose(f);
}

static args_t parse_args(int argc, char ** argv) {
    args_t a;
    for (int i = 1; i < argc; i++) {
        auto next = [&](const char * flag) -> const char * {
            if (i + 1 >= argc) { fprintf(stderr, "missing value for %s\n", flag); exit(1); }
            return argv[++i];
        };
        std::string k = argv[i];
        if      (k == "-m")             a.model     = next("-m");
        else if (k == "-p")             a.prompt    = next("-p");
        else if (k == "--prompts-file") a.prompts_file = next("--prompts-file");
        else if (k == "--prompts-dir")  a.prompts_dir  = next("--prompts-dir");
        else if (k == "-o")             a.out       = next("-o");
        else if (k == "-n")             a.n_predict = atoi(next("-n"));
        else if (k == "-c")             a.n_ctx     = atoi(next("-c"));
        else if (k == "-ngl")           a.ngl       = atoi(next("-ngl"));
        else if (k == "--n-cpu-moe")    a.n_cpu_moe = atoi(next("--n-cpu-moe"));
        else if (k == "--ot-cpu")       a.ot_cpu    = next("--ot-cpu");
        else if (k == "-t")             a.threads   = atoi(next("-t"));
        else if (k == "--temp")         a.temp      = (float) atof(next("--temp"));
        else if (k == "--top-k")        a.top_k     = atoi(next("--top-k"));
        else if (k == "--top-p")        a.top_p     = (float) atof(next("--top-p"));
        else if (k == "--seed")         a.seed      = (uint32_t) atoll(next("--seed"));
        else if (k == "--mask")         a.mask_path = next("--mask");
        else if (k == "--server")       a.server    = true;
        else if (k == "--port")         a.port      = atoi(next("--port"));
        else if (k == "--host")         a.host      = next("--host");
        else if (k == "--capture-dir")  a.capture_dir = next("--capture-dir");
        else if (k == "--alias")        a.alias     = next("--alias");
        else if (k == "--jinja")        a.jinja     = true;
        else if (k == "--chat-template-kwargs") a.chat_kwargs = next("--chat-template-kwargs");
        else if (k == "--reap-script")  a.reap_script = next("--reap-script");
        else if (k == "--mask-pairs") {
            const char * s = next("--mask-pairs");
            int l, e;
            while (sscanf(s, "%d:%d", &l, &e) == 2) {
                a.mask_pairs.push_back({l, e});
                s = strchr(s, ','); if (!s) break; s++;
            }
        }
        else { fprintf(stderr, "unknown arg: %s\n", k.c_str()); exit(1); }
    }
    if (a.model.empty()) {
        fprintf(stderr,
            "usage:\n"
            "  cli    : visual-llm-capture -m model.gguf [-p prompt | --prompts-file f] [-n N] [-o out.jsonl] [--mask m.txt]\n"
            "  server : visual-llm-capture -m model.gguf --server --port 8081 --capture-dir /mnt/share/captures\n");
        exit(1);
    }
    return a;
}

bool Generator::init(const args_t & args) {
    llama_model_params mparams = llama_model_default_params();
    mparams.n_gpu_layers = args.ngl;
    // --n-cpu-moe: pin the first N blocks' fused expert tensors to system RAM
    // (llama-server parity) so models larger than total VRAM can run — the
    // routing capture only needs the tiny ffn_moe_* probe tensors, which stay
    // wherever the graph puts them.
    static std::string      moe_pat;
    static std::vector<llama_model_tensor_buft_override> moe_overrides;
    if (!args.ot_cpu.empty() || args.n_cpu_moe > 0) {
        if (!args.ot_cpu.empty()) {
            moe_pat = args.ot_cpu;
        } else {
            std::string alt;
            for (int i = 0; i < args.n_cpu_moe; i++) alt += (i ? "|" : "") + std::to_string(i);
            moe_pat = "blk\\.(" + alt + ")\\.ffn_(up|down|gate)_exps";
        }
        moe_overrides = { { moe_pat.c_str(), ggml_backend_cpu_buffer_type() },
                          { nullptr, nullptr } };
        mparams.tensor_buft_overrides = moe_overrides.data();
        fprintf(stderr, "cpu-offload pattern: %s\n", moe_pat.c_str());
    }
    model = llama_model_load_from_file(args.model.c_str(), mparams);
    if (!model) { fprintf(stderr, "failed to load model: %s\n", args.model.c_str()); return false; }
    vocab = llama_model_get_vocab(model);

    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx   = args.n_ctx;
    cparams.n_batch = 512;
    const int nth = args.threads > 0 ? args.threads : std::max(1u, std::thread::hardware_concurrency() / 2);
    cparams.n_threads = cparams.n_threads_batch = nth;
    cparams.cb_eval = cb_eval;
    cparams.cb_eval_user_data = &cap;
    ctx = llama_init_from_model(model, cparams);
    if (!ctx) { fprintf(stderr, "failed to create context\n"); return false; }
    n_batch = 512;
    def.n_predict = args.n_predict; def.top_k = args.top_k;
    def.top_p = args.top_p; def.temp = args.temp; def.seed = args.seed;

    // warmup: discover MoE layer set (consecutive viz indices), then reset
    {
        std::string first = args.prompts_file.empty() ? args.prompt : std::string("hello");
        std::vector<llama_token> w = tokenize(first, true);
        llama_token t0 = w.empty() ? llama_vocab_bos(vocab) : w[0];
        llama_batch b = llama_batch_get_one(&t0, 1);
        if (llama_decode(ctx, b) != 0) { fprintf(stderr, "warmup decode failed\n"); return false; }
        for (const auto & kv : cap.layers) moe_layers.push_back(kv.first);
        if (moe_layers.empty()) { fprintf(stderr, "no ffn_moe_* tensors — not a MoE model?\n"); return false; }
        cap.layers.clear();
        llama_memory_clear(llama_get_memory(ctx), true);
        fprintf(stderr, "model: %d MoE layers, %d experts\n", (int) moe_layers.size(), cap.n_expert);
    }

    // mask structures always exist so the mask can also be set at runtime
    // via the server's POST /mask (interactive reap from the frontend)
    cap.mask.assign(moe_layers.size(), {});
    for (size_t li = 0; li < moe_layers.size(); li++) {
        cap.true2viz[moe_layers[li]] = (int) li;
        cap.mask[li].assign(cap.n_expert, 0);
    }
    std::vector<std::pair<int,int>> mask_pairs = args.mask_pairs;
    if (!args.mask_path.empty()) load_mask_file(args.mask_path, mask_pairs);
    if (!mask_pairs.empty()) {
        const int applied = apply_mask_pairs(mask_pairs);
        fprintf(stderr, "reap simulation: %d experts masked (router ablation)\n", applied);
    }

    char nm[128] = {0};
    if (llama_model_meta_val_str(model, "general.name", nm, sizeof(nm)) < 0)
        snprintf(nm, sizeof(nm), "%s", args.model.c_str());
    name = args.alias.empty() ? std::string(nm) : args.alias;

    // jinja templating, llama-server style: kwarg values stored JSON-encoded
    use_jinja = args.jinja;
    if (use_jinja) {
        tmpls = common_chat_templates_init(model, "");
        if (!args.chat_kwargs.empty()) {
            try {
                json kw = json::parse(args.chat_kwargs);
                for (auto it = kw.begin(); it != kw.end(); ++it) {
                    tkwargs[it.key()] = it.value().dump();
                    if (it.key() == "enable_thinking") think_enabled = it.value() == true;
                }
            } catch (const std::exception & e) {
                fprintf(stderr, "bad --chat-template-kwargs json: %s\n", e.what());
                return false;
            }
        }
        fprintf(stderr, "jinja templating on (%zu kwargs)\n", tkwargs.size());
    }
    return true;
}

// ------------------------------------------------------------------ server --

static std::string sse_chunk(const std::string & id, long created, const std::string & model,
                             const json & delta, const char * finish) {
    json j = {
        {"id", id}, {"object", "chat.completion.chunk"}, {"created", created}, {"model", model},
        {"choices", json::array({ json{{"index", 0}, {"delta", delta}, {"finish_reason", finish ? json(finish) : json(nullptr)}} })}
    };
    return "data: " + j.dump() + "\n\n";
}

static float jnum(const json & b, const char * k, float d) {
    if (b.contains(k) && b[k].is_number()) return b[k].get<float>();
    return d;
}

static int run_server(Generator & G, const args_t & args) {
    mkdir(args.capture_dir.c_str(), 0777); // best-effort; parent must exist
    const std::string slug = slugify(G.name);
    std::mutex gmx;
    std::atomic<int> counter{0};

    auto cap_path = [&](int n) {
        time_t t = time(nullptr); char st[32];
        strftime(st, sizeof(st), "%Y%m%d-%H%M%S", localtime(&t));
        char b[1024];
        snprintf(b, sizeof(b), "%s/%s-%s-%04d.jsonl", args.capture_dir.c_str(), slug.c_str(), st, n);
        return std::string(b);
    };

    httplib::Server svr;
    svr.set_read_timeout(600, 0);
    svr.set_write_timeout(600, 0); // long prefills must not trip the socket timeout

    // CORS: the visual-llm frontend (file:// or any origin) talks to us directly
    svr.set_default_headers({
        {"Access-Control-Allow-Origin", "*"},
        {"Access-Control-Allow-Methods", "GET, POST, OPTIONS"},
        {"Access-Control-Allow-Headers", "Content-Type, Authorization"},
    });
    svr.Options(R"(/.*)", [](const httplib::Request &, httplib::Response & res) { res.status = 204; });

    // recording browser for the frontend: list + fetch (one subdir level deep,
    // so corpus runs like captures/canvas/run-*.jsonl are browsable too)
    svr.Get("/captures", [&](const httplib::Request &, httplib::Response & res) {
        struct entry { std::string name; long long bytes; long long mtime; };
        std::vector<entry> list;
        std::function<void(const std::string &)> scan = [&](const std::string & sub) {
            const std::string dir = sub.empty() ? args.capture_dir : args.capture_dir + "/" + sub;
            if (DIR * d = opendir(dir.c_str())) {
                while (dirent * ent = readdir(d)) {
                    std::string fn = ent->d_name;
                    if (fn == "." || fn == "..") continue;
                    const std::string rel = sub.empty() ? fn : sub + "/" + fn;
                    struct stat st {};
                    if (stat((args.capture_dir + "/" + rel).c_str(), &st) != 0) continue;
                    if (S_ISDIR(st.st_mode)) {
                        if (sub.empty()) scan(rel); // one level only
                        continue;
                    }
                    if (fn.size() < 7 || fn.substr(fn.size() - 6) != ".jsonl") continue;
                    list.push_back({rel, (long long) st.st_size, (long long) st.st_mtime});
                }
                closedir(d);
            }
        };
        scan("");
        std::sort(list.begin(), list.end(), [](const entry & a, const entry & b) { return a.mtime > b.mtime; });
        json arr = json::array();
        for (const auto & e : list) arr.push_back({{"name", e.name}, {"bytes", e.bytes}, {"mtime", e.mtime}});
        struct stat mst {};
        const long long model_bytes = stat(args.model.c_str(), &mst) == 0 ? (long long) mst.st_size : 0;
        res.set_content(json{{"model", G.name}, {"model_bytes", model_bytes}, {"captures", arr}}.dump(), "application/json");
    });
    // runtime reap mask: GET returns current pairs, POST {"pairs":[[l,e],...]}
    // replaces the mask (empty list clears). Applies from the next request on;
    // captures made under a mask carry it as removed_experts.
    svr.Get("/mask", [&](const httplib::Request &, httplib::Response & res) {
        std::lock_guard<std::mutex> lk(gmx);
        json pairs = json::array();
        for (size_t li = 0; li < G.cap.mask.size(); li++)
            for (int e = 0; e < (int) G.cap.mask[li].size(); e++)
                if (G.cap.mask[li][e]) pairs.push_back({(int) li, e});
        res.set_content(json{{"active", G.cap.mask_active}, {"pairs", pairs}}.dump(), "application/json");
    });
    svr.Post("/mask", [&](const httplib::Request & req, httplib::Response & res) {
        json body;
        try { body = json::parse(req.body); }
        catch (...) { res.status = 400; res.set_content("{\"error\":\"bad json\"}", "application/json"); return; }
        std::vector<std::pair<int,int>> pairs;
        if (body.contains("pairs") && body["pairs"].is_array())
            for (auto & p : body["pairs"])
                if (p.is_array() && p.size() >= 2) pairs.push_back({p[0].get<int>(), p[1].get<int>()});
        std::lock_guard<std::mutex> lk(gmx);
        const int applied = G.apply_mask_pairs(pairs);
        fprintf(stderr, "mask updated via API: %d experts masked\n", applied);
        res.set_content(json{{"applied", applied}, {"active", G.cap.mask_active}}.dump(), "application/json");
    });

    // ---- physical reap: run reap_gguf.py on the loaded model, async ----
    struct reap_job_t {
        std::atomic<bool> running{false};
        std::mutex mx;
        std::string log;
        std::string output;
        int exit_code = -1;
    };
    static reap_job_t reap_job;
    auto shq = [](const std::string & s) { // single-quote for sh
        std::string out = "'";
        for (char c : s) out += (c == '\'') ? std::string("'\\''") : std::string(1, c);
        return out + "'";
    };

    svr.Post("/reap", [&, shq](const httplib::Request & req, httplib::Response & res) {
        json body;
        try { body = json::parse(req.body); }
        catch (...) { res.status = 400; res.set_content("{\"error\":\"bad json\"}", "application/json"); return; }
        if (reap_job.running) {
            res.status = 409;
            res.set_content("{\"error\":\"a reap is already running\"}", "application/json");
            return;
        }
        if (args.model.find("-of-00") != std::string::npos) {
            res.status = 400;
            res.set_content(json{{"error", "this model is a sharded gguf — merge it first "
                                           "(llama-gguf-split --merge), then serve the merged file"}}.dump(), "application/json");
            return;
        }
        // mask source: explicit pairs from the UI, or "set" — a capture
        // subdirectory whose recordings are aggregated server-side by
        // make_mask.py (the one-click corpus reap)
        const std::string set = body.value("set", std::string());
        std::vector<std::pair<int,int>> pairs;
        if (body.contains("pairs") && body["pairs"].is_array())
            for (auto & p : body["pairs"])
                if (p.is_array() && p.size() >= 2) pairs.push_back({p[0].get<int>(), p[1].get<int>()});
        const std::string maskp = args.capture_dir + "/reap-mask-ui.txt";
        std::string mask_cmd;
        if (!set.empty()) {
            if (set.find("..") != std::string::npos || set.find('/') != std::string::npos ||
                set.find('\\') != std::string::npos) {
                res.status = 400; res.set_content("{\"error\":\"bad set name\"}", "application/json"); return;
            }
            const std::string setdir = args.capture_dir + "/" + set;
            struct stat st {};
            if (stat(setdir.c_str(), &st) != 0 || !S_ISDIR(st.st_mode)) {
                res.status = 400; res.set_content("{\"error\":\"no such capture set\"}", "application/json"); return;
            }
            double frac = 0.25;
            if (body.contains("frac") && body["frac"].is_number()) frac = body["frac"].get<double>();
            if (!(frac > 0.0 && frac < 1.0)) frac = 0.25;
            char fs[32]; snprintf(fs, sizeof(fs), "%.4f", frac);
            // make_mask.py lives beside the reap script; it globs the pattern itself
            std::string mask_script = args.reap_script;
            const size_t sl = mask_script.find_last_of("/\\");
            mask_script = (sl == std::string::npos) ? "make_mask.py"
                                                    : mask_script.substr(0, sl + 1) + "make_mask.py";
            mask_cmd = "python3 " + shq(mask_script) + " " + shq(setdir + "/*.jsonl") +
                       " --frac " + fs + " --exact -o " + shq(maskp) + " 2>&1 && ";
        } else if (pairs.empty()) {
            res.status = 400;
            res.set_content("{\"error\":\"no mask pairs\"}", "application/json");
            return;
        } else {
            FILE * mf = fopen(maskp.c_str(), "wb");
            if (!mf) { res.status = 500; res.set_content("{\"error\":\"cannot write mask file\"}", "application/json"); return; }
            fprintf(mf, "# visual-llm reap mask — set from the UI\n");
            for (const auto & p : pairs) fprintf(mf, "%d %d\n", p.first, p.second);
            fclose(mf);
        }

        // output beside the model: <stem>-REAPED[-n].gguf, never overwriting
        std::string out = args.model;
        const size_t dot = out.rfind(".gguf");
        if (dot != std::string::npos) out = out.substr(0, dot);
        std::string path = out + "-REAPED.gguf";
        for (int i = 2; i < 100; i++) {
            struct stat st {};
            if (stat(path.c_str(), &st) != 0) break;
            path = out + "-REAPED-" + std::to_string(i) + ".gguf";
        }
        const std::string cmd = mask_cmd + "python3 " + shq(args.reap_script) + " " + shq(args.model) + " " +
                                shq(path) + " --mask " + shq(maskp) + " 2>&1";
        reap_job.running = true;
        {
            std::lock_guard<std::mutex> lk(reap_job.mx);
            reap_job.log.clear();
            reap_job.output = path;
            reap_job.exit_code = -1;
        }
        std::thread([cmd]() {
            FILE * p = popen(cmd.c_str(), "r");
            char line[512];
            while (p && fgets(line, sizeof(line), p)) {
                std::lock_guard<std::mutex> lk(reap_job.mx);
                reap_job.log += line;
                if (reap_job.log.size() > 16384) reap_job.log.erase(0, reap_job.log.size() - 16384);
            }
            const int rc = p ? pclose(p) : -1;
            std::lock_guard<std::mutex> lk(reap_job.mx);
            reap_job.exit_code = (rc >= 256) ? rc / 256 : rc; // WEXITSTATUS-ish, portable enough
            reap_job.running = false;
        }).detach();
        if (set.empty()) fprintf(stderr, "reap started -> %s (%zu pairs)\n", path.c_str(), pairs.size());
        else             fprintf(stderr, "reap started -> %s (corpus set '%s')\n", path.c_str(), set.c_str());
        res.set_content(json{{"started", true}, {"output", path}}.dump(), "application/json");
    });
    svr.Get("/reap", [&](const httplib::Request &, httplib::Response & res) {
        std::lock_guard<std::mutex> lk(reap_job.mx);
        res.set_content(json{
            {"running", reap_job.running.load()},
            {"exit_code", reap_job.exit_code},
            {"output", reap_job.output},
            {"log", reap_job.log},
        }.dump(), "application/json");
    });

    svr.Get(R"(/captures/(.+))", [&](const httplib::Request & req, httplib::Response & res) {
        const std::string fn = req.matches[1];
        // allow at most one subdir level; forbid traversal and absolute paths
        if (fn.find("..") != std::string::npos || fn.find('\\') != std::string::npos ||
            fn.empty() || fn[0] == '/' || std::count(fn.begin(), fn.end(), '/') > 1) {
            res.status = 400;
            return;
        }
        FILE * f = fopen((args.capture_dir + "/" + fn).c_str(), "rb");
        if (!f) { res.status = 404; res.set_content("{\"error\":\"not found\"}", "application/json"); return; }
        std::string body;
        char rbuf[65536];
        size_t n;
        while ((n = fread(rbuf, 1, sizeof(rbuf), f)) > 0) body.append(rbuf, n);
        fclose(f);
        res.set_content(body, "application/x-ndjson");
    });

    json models = {{"object", "list"}, {"data", json::array({
        json{{"id", G.name}, {"object", "model"}, {"created", 0}, {"owned_by", "visual-llm-capture"}} })}};
    auto models_str = models.dump();
    svr.Get("/v1/models", [&, models_str](const httplib::Request &, httplib::Response & res) {
        res.set_content(models_str, "application/json");
    });
    svr.Get("/health", [](const httplib::Request &, httplib::Response & res) {
        res.set_content("{\"status\":\"ok\"}", "application/json");
    });

    // shared: parse gen params + prompt, then generate (streaming or not)
    auto handle = [&](const httplib::Request & req, httplib::Response & res, bool chat) {
        json body;
        try { body = json::parse(req.body); }
        catch (...) { res.status = 400; res.set_content("{\"error\":\"bad json\"}", "application/json"); return; }

        gen_params gp = G.def;
        gp.temp  = jnum(body, "temperature", gp.temp);
        gp.top_p = jnum(body, "top_p", gp.top_p);
        if (body.contains("top_k") && body["top_k"].is_number()) gp.top_k = body["top_k"].get<int>();
        if (body.contains("max_tokens") && body["max_tokens"].is_number()) gp.n_predict = body["max_tokens"].get<int>();
        if (body.contains("seed") && body["seed"].is_number()) gp.seed = (uint32_t) body["seed"].get<long long>();
        bool stream = body.value("stream", false);

        std::string prompt_text;
        std::vector<llama_token> ptoks;
        if (chat) {
            std::vector<std::pair<std::string,std::string>> msgs;
            if (body.contains("messages") && body["messages"].is_array())
                for (auto & m : body["messages"]) {
                    std::string role = m.value("role", "user"), content;
                    if (m.contains("content")) {
                        if (m["content"].is_string()) content = m["content"].get<std::string>();
                        else if (m["content"].is_array())
                            for (auto & part : m["content"]) if (part.value("type", "") == "text") content += part.value("text", "");
                    }
                    msgs.push_back({role, content});
                }
            prompt_text = G.apply_chat_template(msgs);
            ptoks = G.tokenize(prompt_text, false);
        } else {
            prompt_text = body.value("prompt", "");
            ptoks = G.tokenize(prompt_text, true);
        }
        if (ptoks.empty()) { res.status = 400; res.set_content("{\"error\":\"empty prompt\"}", "application/json"); return; }

        const int id_n = counter++;
        const std::string id = (chat ? "chatcmpl-" : "cmpl-") + std::to_string(id_n);
        const long created = (long) time(nullptr);
        const std::string path = cap_path(id_n);
        const std::string mdl = G.name;

        if (stream) {
            res.set_chunked_content_provider("text/event-stream",
                [=, &G, &gmx](size_t, httplib::DataSink & sink) {
                    std::lock_guard<std::mutex> lk(gmx);
                    if (chat) { auto c = sse_chunk(id, created, mdl, json{{"role", "assistant"}}, nullptr); sink.write(c.data(), c.size()); }
                    gen_result r = G.generate(ptoks, gp, [&](const std::string & pc) {
                        json delta = chat ? json{{"content", pc}} : json{{"text", pc}};
                        auto c = sse_chunk(id, created, mdl, delta, nullptr);
                        sink.write(c.data(), c.size());
                    });
                    auto fin = sse_chunk(id, created, mdl, json::object(), r.error.empty() ? "stop" : "error");
                    sink.write(fin.data(), fin.size());
                    const char * done = "data: [DONE]\n\n";
                    sink.write(done, strlen(done));
                    G.write_recording(path, prompt_text, r);
                    fprintf(stderr, "capture: %s (%d tok%s)\n", path.c_str(), r.n_tokens, r.error.empty() ? "" : ", ERROR");
                    sink.done();
                    return true;
                });
            return;
        }

        std::lock_guard<std::mutex> lk(gmx);
        gen_result r = G.generate(ptoks, gp, nullptr);
        G.write_recording(path, prompt_text, r);
        fprintf(stderr, "capture: %s (%d tok%s)\n", path.c_str(), r.n_tokens, r.error.empty() ? "" : ", ERROR");
        if (!r.error.empty()) { res.status = 500; res.set_content(json{{"error", r.error}}.dump(), "application/json"); return; }
        json choice = chat
            ? json{{"index", 0}, {"message", {{"role", "assistant"}, {"content", r.text}}}, {"finish_reason", "stop"}}
            : json{{"index", 0}, {"text", r.text}, {"finish_reason", "stop"}};
        json resp = {
            {"id", id}, {"object", chat ? "chat.completion" : "text_completion"},
            {"created", created}, {"model", mdl}, {"choices", json::array({choice})},
            {"usage", {{"prompt_tokens", r.n_prompt}, {"completion_tokens", r.n_gen}, {"total_tokens", r.n_prompt + r.n_gen}}}
        };
        res.set_content(resp.dump(), "application/json");
    };

    svr.Post("/v1/chat/completions", [&](const httplib::Request & req, httplib::Response & res) { handle(req, res, true); });
    svr.Post("/v1/completions",      [&](const httplib::Request & req, httplib::Response & res) { handle(req, res, false); });

    fprintf(stderr, "visual-llm-capture server on %s:%d — model '%s' — captures -> %s\n",
            args.host.c_str(), args.port, G.name.c_str(), args.capture_dir.c_str());
    if (!svr.listen(args.host.c_str(), args.port)) { fprintf(stderr, "failed to bind %s:%d\n", args.host.c_str(), args.port); return 1; }
    return 0;
}

// ---------------------------------------------------------------- cli mode --

// read a whole prompt file; strips YAML frontmatter (--- ... ---) from .md
static std::string read_prompt_file(const std::string & path) {
    FILE * f = fopen(path.c_str(), "rb");
    if (!f) return "";
    std::string s;
    char buf[8192];
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) s.append(buf, n);
    fclose(f);
    if (s.rfind("---", 0) == 0) {
        const size_t end = s.find("\n---", 3);
        if (end != std::string::npos) {
            const size_t nl = s.find('\n', end + 1);
            s = (nl != std::string::npos) ? s.substr(nl + 1) : "";
        }
    }
    size_t a = s.find_first_not_of(" \t\r\n");
    size_t b = s.find_last_not_of(" \t\r\n");
    return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}

static int run_cli(Generator & G, const args_t & args) {
    std::vector<std::pair<std::string, std::string>> prompts; // {name, text}
    if (!args.prompts_dir.empty()) {
        std::vector<std::string> files;
        if (DIR * d = opendir(args.prompts_dir.c_str())) {
            while (dirent * ent = readdir(d)) {
                const std::string fn = ent->d_name;
                if (fn.size() > 3 && (fn.substr(fn.size() - 3) == ".md" || fn.substr(fn.size() - 4) == ".txt"))
                    files.push_back(fn);
            }
            closedir(d);
        } else { fprintf(stderr, "cannot open prompts dir: %s\n", args.prompts_dir.c_str()); return 1; }
        std::sort(files.begin(), files.end());
        for (const auto & fn : files) {
            const std::string text = read_prompt_file(args.prompts_dir + "/" + fn);
            if (text.empty()) { fprintf(stderr, "skipping empty prompt: %s\n", fn.c_str()); continue; }
            std::string stem = fn.substr(0, fn.rfind('.'));
            prompts.push_back({stem, text});
        }
        if (prompts.empty()) { fprintf(stderr, "no .md/.txt prompts in %s\n", args.prompts_dir.c_str()); return 1; }
    } else if (!args.prompts_file.empty()) {
        FILE * pf = fopen(args.prompts_file.c_str(), "rb");
        if (!pf) { fprintf(stderr, "cannot open prompts file: %s\n", args.prompts_file.c_str()); return 1; }
        char pl[4096];
        int idx = 0;
        while (fgets(pl, sizeof(pl), pf)) {
            std::string s(pl);
            while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
            if (s.empty() || s[0] == '#') continue;
            char nm[16];
            snprintf(nm, sizeof(nm), "%03d", idx++);
            prompts.push_back({nm, s});
        }
        fclose(pf);
        if (prompts.empty()) { fprintf(stderr, "prompts file has no prompts\n"); return 1; }
    } else prompts.push_back({"", args.prompt});

    for (size_t pi = 0; pi < prompts.size(); pi++) {
        std::vector<llama_token> ptoks = G.tokenize(prompts[pi].second, true);
        if (ptoks.empty()) continue;
        fprintf(stderr, "\n[%d/%d] %s%s%d prompt tokens\n", (int) pi + 1, (int) prompts.size(),
                prompts[pi].first.c_str(), prompts[pi].first.empty() ? "" : ": ", (int) ptoks.size());
        gen_result r = G.generate(ptoks, G.def, [](const std::string & p) { fputs(p.c_str(), stderr); fflush(stderr); });
        fputs("\n", stderr);
        if (!r.error.empty()) { fprintf(stderr, "generation error: %s\n", r.error.c_str()); return 1; }

        std::string path = args.out;
        if (!prompts[pi].first.empty()) {
            std::string base = path;
            const size_t dot = base.rfind(".jsonl");
            if (dot != std::string::npos) base = base.substr(0, dot);
            path = base + "-" + prompts[pi].first + ".jsonl";
        }
        G.write_recording(path, prompts[pi].second, r);
        fprintf(stderr, "wrote %s: %d tokens\n", path.c_str(), r.n_tokens);
    }
    fprintf(stderr, "\ndone: %d recording(s), %d MoE layers, %d experts\n",
            (int) prompts.size(), (int) G.moe_layers.size(), G.cap.n_expert);
    return 0;
}

int main(int argc, char ** argv) {
    const args_t args = parse_args(argc, argv);
    llama_backend_init();

    Generator G;
    if (!G.init(args)) return 1;

    int rc = args.server ? run_server(G, args) : run_cli(G, args);

    llama_free(G.ctx);
    llama_model_free(G.model);
    llama_backend_free();
    return rc;
}
