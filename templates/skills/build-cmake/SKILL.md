---
name: build-cmake
description: CMake build system gotchas
---

# CMake — Verified Gotchas

## find_package Search Order

**No mode specified = tries MODULE first, then CONFIG** (Sonnet reverses this!):
- First looks for `FindFoo.cmake` in CMAKE_MODULE_PATH (MODULE)
- Then falls back to `FooConfig.cmake` (CONFIG)
- `find_package(Foo)` might find wrong file — always specify CONFIG or MODULE explicitly

```cmake
set(CMAKE_PREFIX_PATH "/opt/mylib")  # Finds FooConfig.cmake
set(CMAKE_MODULE_PATH "/opt/mylib")  # Finds FindFoo.cmake — NOT the same!
```

## CMP0077: Normal Variables Override Options

```cmake
option(FOO_ENABLE_TESTS "..." OFF)
set(FOO_ENABLE_TESTS ON)  # Pre-3.13: ignored! 3.13+ with CMP0077 NEW: overrides option
cmake_policy(SET CMP0077 NEW)  # Let NORMAL variables (not cache) override options
```

Key: this is about **normal** variables overriding `option()` cache entries — not cache-to-cache override.

## Ubuntu apt catch2 = v2, NOT v3

`apt install catch2` on Ubuntu 22.04 (and earlier) installs Catch2 **v2.x**. `find_package(Catch2 3 REQUIRED)` will fail. Use FetchContent fallback:

```cmake
find_package(Catch2 3 QUIET)
if(NOT Catch2_FOUND)
    include(FetchContent)
    FetchContent_Declare(Catch2
        GIT_REPOSITORY https://github.com/catchorg/Catch2.git
        GIT_TAG        v3.5.2
        GIT_SHALLOW    TRUE
    )
    FetchContent_MakeAvailable(Catch2)
    list(APPEND CMAKE_MODULE_PATH ${catch2_SOURCE_DIR}/extras)
endif()
```

## FetchContent in Docker: URL, not GIT_REPOSITORY

`FetchContent_Declare` with `GIT_REPOSITORY` requires `git` installed. Docker build images often lack git. Use `URL` with a tarball instead — CMake downloads it via its own HTTP client:

```cmake
# BAD in Docker (needs git):
FetchContent_Declare(Foo GIT_REPOSITORY https://github.com/org/foo.git GIT_TAG v1.0)

# GOOD (no git needed):
FetchContent_Declare(Foo URL https://github.com/org/foo/archive/refs/tags/v1.0.tar.gz)
```
