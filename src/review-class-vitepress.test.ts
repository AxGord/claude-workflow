import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(__dirname, "../scripts/review-class.sh");

function classOf(file: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rc-"));
  const git = (...a: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        ...a,
      ],
      {
        cwd: dir,
        stdio: "pipe",
      },
    );
  git("init", "-q");
  writeFileSync(join(dir, "seed"), "x");
  git("add", ".");
  git("commit", "-qm", "seed");
  const base = git("rev-parse", "HEAD").toString().trim();
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), "x");
  git("add", ".");
  git("commit", "-qm", "change");
  return execFileSync("sh", [script, base, "HEAD"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
}

describe("review-class docs/.vitepress", () => {
  it("config.ts under docs/.vitepress is code", () => {
    expect(classOf("docs/.vitepress/config.ts")).toBe("code");
  });
  it("vue theme component under docs/.vitepress is code", () => {
    expect(classOf("docs/.vitepress/theme/Foo.vue")).toBe("code");
  });
  it("a script under docs is code", () => {
    expect(classOf("docs/scripts/build.js")).toBe("code");
  });
  it("prose md under docs stays light", () => {
    expect(classOf("docs/guide.md")).toBe("light");
  });
  it("a nested prose md under docs/.vitepress is still code (the directory is code)", () => {
    expect(classOf("docs/.vitepress/notes.md")).toBe("code");
  });
});
