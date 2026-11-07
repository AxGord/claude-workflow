// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Only src/**/*.ts is linted (the rest is JS/shell/HTML, not covered by tsconfig). hooks/ and types/ hold the
  // Claude Code hooks module (plan pane) and its state contract, checked against Claude Code's own types.
  { ignores: ["**/*.js", "**/*.mjs", "vitest.config.ts", "build/", "node_modules/", "dashboard/", "scripts/", "hooks/", "types/", "templates/"] },
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        // tsconfig.json excludes tests (build), so type info comes from tsconfig.eslint.json.
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",
    },
  },
);
