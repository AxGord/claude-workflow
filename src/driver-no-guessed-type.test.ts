import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
const bullet = (file: string): string => {
  const text = readFileSync(resolve(root, file), "utf8");
  const i = text.indexOf('"Spawn ONE worker/reviewer"');
  expect(i).toBeGreaterThan(-1);
  const rest = text.slice(i);
  const end = rest.search(/\n- /u.test(rest.slice(1)) ? /\n- /u : /$/u);
  return rest.slice(0, end > 0 ? end : undefined);
};

describe("driver spawn bullet forbids guessed subagent_type", () => {
  for (const f of ["templates/drivers/task-driver.md", "agents/driver.md"]) {
    it(f, () => {
      const b = bullet(f);
      expect(b).toContain("subagent_type");
      expect(b).toMatch(/omit/u);
      expect(b).toMatch(/Never choose a type by the role/u);
    });
  }
});
