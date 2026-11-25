import { describe, expect, it } from "vitest";
import { waitTail } from "./queue-wait.js";

describe("waitTail", () => {
  it("words a line it may not run beside by the other line's id and how", () => {
    expect(waitTail("overlaps A (touches x ~ x)", { how: "overlap", id: "A" })).toBe(
      "waits: A (overlap)",
    );
    expect(waitTail("held for exclusive A", { how: "hold", id: "A" })).toBe("waits: A (exclusive)");
    expect(waitTail("breaking A runs alone", { how: "runs-alone", id: "A" })).toBe(
      "waits: A (breaking)",
    );
    expect(waitTail("breaking: window not empty (A)", { how: "window-not-empty", id: "A" })).toBe(
      "breaking",
    );
  });

  it("keeps the picker's own words for the rest", () => {
    expect(waitTail("after: X (running)")).toBe("after: X (running)");
    expect(waitTail("parked")).toBe("parked");
    expect(waitTail("parent-run (model —)")).toBe("parent-run");
    expect(waitTail("paused (batch_size 0)")).toBe("paused");
    expect(waitTail("window full")).toBe("window full");
  });
});
