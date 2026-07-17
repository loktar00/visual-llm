set(TARGET visual-llm-capture)
add_executable(${TARGET} visual-llm-capture.cpp)
install(TARGETS ${TARGET} RUNTIME)
# server mode links the same vendored cpp-httplib target llama-server uses
# (cpp-httplib 0.49 ships as a compiled lib here, not header-only), plus
# llama-common for jinja chat templating (--jinja parity with llama-server)
target_link_libraries(${TARGET} PRIVATE llama-common llama ggml cpp-httplib ${CMAKE_THREAD_LIBS_INIT})
target_include_directories(${TARGET} PRIVATE ${CMAKE_SOURCE_DIR}/vendor)
target_compile_features(${TARGET} PRIVATE cxx_std_17)
