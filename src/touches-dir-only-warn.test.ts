import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { addQueueLine } from "./queue.js";

async function add(header: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tdow-"));
  const file = path.join(dir, "queue.yaml");
  fs.writeFileSync(file, `${header}\ntasks: []\n`);
  fs.mkdirSync(path.join(dir, "src", "pkg"), { recursive: true });
  return addQueueLine(file, { id: "A", difficulty: 3, repo: dir, touches: ["src/pkg"], text: "a" });
}

describe("touchesWarnings: directory entry", () => {
  it("under overlap: files a directory entry is warned", async () => {
    const r = await add("batch_size: 2\noverlap: files");
    expect(r.warnings?.join("\n")).toMatch(/src\/pkg is a directory/);
  });
  it("under overlap: paths or the default there is none", async () => {
    expect((await add("batch_size: 2\noverlap: paths")).warnings).toBeUndefined();
    expect((await add("batch_size: 2")).warnings).toBeUndefined();
  });
});
