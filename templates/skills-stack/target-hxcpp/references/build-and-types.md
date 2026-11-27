# hxcpp — Build, Defines & Type Mapping

## Useful defines

```
-DHXCPP_DEBUG_LINK                 Symbols without full debug
-DHXCPP_CHECK_POINTER              NULL → exception
-DHXCPP_STACK_TRACE                Function names in traces
-DHXCPP_M64                        Force 64-bit
**Windows**: MSVC auto-detection may fail → set `HXCPP_VARS`. Static linking fixed 8.2.3.
```

## Cross-compilation

hxcpp selects the toolchain via defines (`-D ...`). Haxe's `-cpp <dir>` only sets the C++ output directory — it is not a cross-compilation flag.

| From → To | Define |
|-----------|--------|
| macOS → Linux | `-D linux` (needs a Linux cross-toolchain, e.g. via Homebrew) |
| Linux → Windows | `-D windows` (selects the MinGW-w64 cross toolchain) |
| Windows: MSVC → MinGW | `-D mingw` |

## hxcpp build.xml

Multiple `<target id="haxe">` blocks **merge silently** — conflicts between libraries. Use `overwrite="true"` to replace.

```xml
<files id="haxe">
  <compilerflag value="-I/path/to/include"/>
</files>
<target id="haxe">
  <lib name="-lsystemlib"/>
</target>
```

## Type mapping (non-obvious only)

| Haxe | C++ | Gotcha |
|------|-----|--------|
| `String` | `::String` (custom) | NOT std::string. `.c_str()` for C APIs. GC-managed — don't store pointers in C++ |
| `Array<T>` | `::hx::ObjectPtr<Array_obj<T>>` | GC object. Can't pass as `T*`. Copy to `cpp.NativeArray` |
| `Dynamic` | Container struct | Heavy wrapper, boxes everything |
| `Null<Float>` | Heap GC object | 50x slower than Float |
| `MyClass` | `::hx::ObjectPtr<MyClass_obj>` | Typedef hides pointer wrapper, `_obj` suffix is the real class |
