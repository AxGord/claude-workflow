import { describe, expect, it } from "vitest";
import { convertLine, markdownToYaml } from "./queue-convert.js";
import { parseQueue } from "./queue.js";

describe("legacy queue conversion keeps the sweep: key", () => {
  it("convertLine puts sweep in the fields, not in the brief text", () => {
    const t = convertLine(
      "- [ ] SW-1 | difficulty: 2 | sweep: npm run lint -- --fix | touches: src/a.ts | Run the sweep. |",
    );
    expect(t?.fields.sweep).toBe("npm run lint -- --fix");
    expect(t?.fields.text).toBe("Run the sweep.");
  });

  it("a converted queue reads back with the task's sweep command", () => {
    const md =
      "batch_size: 2\n\n## Tasks\n- [ ] SW-1 | difficulty: 2 | sweep: npm run lint -- --fix | touches: src/a.ts | Run the sweep. |\n";
    const yaml = markdownToYaml(md, "old.md");
    const line = parseQueue(yaml, "converted.yaml").lines[0];
    expect(line.meta.sweep).toBe("npm run lint -- --fix");
    expect(line.text).not.toContain("sweep:");
  });
});
