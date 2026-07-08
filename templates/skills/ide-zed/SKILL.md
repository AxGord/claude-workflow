---
name: ide-zed
description: Zed IDE integration rules
---

# Zed IDE Integration

1. **`Read` can't read binary files** (PNG, etc.) — Zed bug #48133 (open, P2). Use display tree for state, not screenshots.
2. **Stale Playwright processes accumulate** → `pkill -f playwright 2>/dev/null` if browser behaves unexpectedly.
3. **clangd relative `-I` paths in `.clangd` resolve from the source file's directory, not the project root** (when no `compile_commands.json` exists). Files in subdirectories (e.g. `project/common/foo.cpp`) will fail to find includes specified as `-I./some-dir` in `.clangd` `CompileFlags.Add`.

   WRONG — `.clangd`:
   ```yaml
   CompileFlags:
     Add: [-I./native, -I./project/common]
   ```

   RIGHT — `compile_flags.txt` in the project root:
   ```
   -I./native
   -I./project/common
   ```
   clangd uses the `compile_flags.txt` parent directory as CWD, so paths resolve correctly from the root. Keep `.clangd` for non-path flags (warnings, diagnostics, `If`/`PathMatch` overrides) only.
