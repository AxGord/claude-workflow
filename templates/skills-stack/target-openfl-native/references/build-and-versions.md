# OpenFL/Lime Native — Build & Version Reference

## Versions (November 2025)

**OpenFL 9.5.0**: new scale9Grid (`-Dopenfl_legacy_scale9grid` for old), device orientation APIs, BevelFilter.
**Lime 8.3.0**: NDK r28c (16KB alignment), SDK 35 (JDK 17+), SDL 2.30.12, HashLink 1.14, Apple Silicon since 8.2.0.

### Breaking changes (8.1.x → 8.3.0)
- ARMv7 removed from iOS/Android defaults (8.1.2)
- 32-bit iOS removed (8.2.0)
- NDLL folder renamed "ndll" → "lib" (7.4.0)
- Linux x86_32 binaries removed from Haxelib (8.3.0)

## Useful defines

```
-Dopenfl-disable-hdpi              Disable HiDPI
-Dopenfl_legacy_scale9grid         Old scale9Grid
-Dcairo                            Force Cairo renderer
```

## CI/CD gotchas

**Android**: NDK r28c required, SDK 35 → JDK 17+, 16KB alignment, set architectures explicitly.
**iOS**: `-nosign` for CI, device install iOS 16+ fixed in 8.2.3.
**Windows**: MSVC auto-detection may fail → set `HXCPP_VARS`. Static linking fixed 8.2.3.

hxcpp defines, cross-compilation, build.xml and type mapping: see `target-hxcpp`.
