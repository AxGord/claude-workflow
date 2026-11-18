---
name: build-cmake
description: CMake build system gotchas
---

# CMake — Verified Gotchas

## find_package Search Order

**No mode specified = tries MODULE first, then CONFIG** (commonly reversed!):
- First looks for `FindFoo.cmake` in CMAKE_MODULE_PATH (MODULE)
- Then falls back to `FooConfig.cmake` (CONFIG)
- `find_package(Foo)` might find wrong file — always specify CONFIG or MODULE explicitly

```cmake
# CONFIG: CMAKE_PREFIX_PATH entries are PREFIXES — CMake searches
# <prefix>/lib/cmake/Foo/, <prefix>/share/cmake/Foo/, etc.
# for FooConfig.cmake or foo-config.cmake (not the prefix dir itself)
set(CMAKE_PREFIX_PATH "/opt/mylib")

# CONFIG: Foo_DIR points at the EXACT dir containing FooConfig.cmake
set(Foo_DIR "/opt/mylib/lib/cmake/Foo")

# MODULE: CMAKE_MODULE_PATH dirs are searched DIRECTLY for FindFoo.cmake — NOT the same!
set(CMAKE_MODULE_PATH "/opt/cmake-modules")
```

## CMP0077: Normal Variables Override Options (add_subdirectory)

```cmake
# Parent project configures a vendored subproject:
set(FOO_ENABLE_TESTS OFF)   # normal variable — must be set BEFORE the option() executes
add_subdirectory(foo)       # foo's CMakeLists.txt contains: option(FOO_ENABLE_TESTS "..." ON)
```

- CMP0077 **OLD**: `option()` discards the pre-set normal variable and creates the cache entry → the parent's `OFF` is lost.
- CMP0077 **NEW**: `option()` becomes a no-op when a normal variable of that name exists → the parent's `OFF` wins.

The policy is controlled by the **subproject**: `cmake_minimum_required(VERSION 3.13...)` there, or `cmake_policy(SET CMP0077 NEW)` before its `option()` calls. The parent can force it for all subprojects with `set(CMAKE_POLICY_DEFAULT_CMP0077 NEW)` before `add_subdirectory`.

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
FetchContent_Declare(Foo
    URL      https://github.com/org/foo/archive/refs/tags/v1.0.tar.gz
    URL_HASH SHA256=<tarball-sha256>  # pin integrity — without it the download is unverified
)
```

## OpenCV: legacy ENABLE_AVX* toggles silently override CPU_BASELINE

Building OpenCV with `-DENABLE_AVX=ON -DENABLE_AVX2=ON` (legacy toggles) appends those features to `CPU_BASELINE_REQUIRE` (FORCE cache) — they **win over** an explicit `-DCPU_BASELINE=SSE2`, and the `IMPLIES` chain drags in the whole ladder (AVX2 ⇒ FMA3+FP16+AVX ⇒ SSE4_2 ⇒ …). The built lib then hard-aborts at runtime on any CPU missing a required feature ("FATAL ERROR: This OpenCV build doesn't support current CPU/HW configuration"), instead of falling back.

- The deprecation notice is `message(STATUS ...)` — invisible under `-DCMAKE_MESSAGE_LOG_LEVEL=WARNING`.
- Build-info tell: `strings libopencv_core.so | grep -A3 Baseline:` shows `requested: SSE2` but `required: AVX AVX2`.
- Fix: drop the legacy toggles entirely; use `CPU_BASELINE` (portable floor) + `CPU_DISPATCH` (per-ISA hot kernels selected at runtime — fast CPUs lose nothing).
- Spelling quirk: the legacy option is `ENABLE_SSE42`; `-DENABLE_SSE4_2=ON` is silently ignored (unknown var).
