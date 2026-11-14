import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "vitest";

const root = resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  devDependencies: Record<string, string>;
};
const major = (v: string) => Number(v.split(".")[0]);

test("build, dev and check compile with the TypeScript 7 compiler", () => {
  const tsc7 = "node node_modules/typescript7/bin/tsc";
  expect(pkg.devDependencies.typescript7).toMatch(/^npm:typescript@\^7\./);
  expect(pkg.scripts.build).toBe(tsc7);
  expect(pkg.scripts.dev).toBe(`${tsc7} --watch`);
  expect(pkg.scripts.check.startsWith(`${tsc7} --noEmit`)).toBe(true);
  const out = execFileSync(
    "node",
    [resolve(root, "node_modules/typescript7/bin/tsc"), "--version"],
    {
      encoding: "utf8",
    },
  );
  expect(out).toContain("Version 7.");
});

test("`typescript` stays 5.x: typescript-eslint, the transpile tests and tsserver need its JS API", () => {
  const ts = require("typescript") as { version: string; transpileModule: unknown };
  expect(major(ts.version)).toBe(5);
  expect(typeof ts.transpileModule).toBe("function");
  expect(pkg.devDependencies.typescript).toMatch(/^\^5\./);
});

test("no src test runs a bare tsc: `.bin/tsc` is the 5.x compiler and would overwrite build/ made with 7", () => {
  const bare = /["\x27`]tsc["\x27`]|\bnpx tsc\b|\bnpx\b[^\n]*["\x27]tsc["\x27]/;
  const offenders = readdirSync(resolve(root, "src"))
    .filter(f => f.endsWith(".test.ts") && f !== "typescript7-toolchain.test.ts")
    .filter(f => bare.test(readFileSync(resolve(root, "src", f), "utf8")));
  expect(offenders).toEqual([]);
});
