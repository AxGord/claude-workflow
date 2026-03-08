import { describe, it, expect } from "vitest";
import { render } from "./template.js";

describe("render", () => {
  it("substitutes simple {{key}}", () => {
    expect(render("Hello {{name}}", { name: "world" })).toBe("Hello world");
  });

  it("substitutes dot-path {{context.cwd}}", () => {
    expect(render("Dir: {{context.cwd}}", { context: { cwd: "/tmp" } })).toBe("Dir: /tmp");
  });

  it("replaces undefined with empty string", () => {
    expect(render("Value: {{missing}}", {})).toBe("Value: ");
  });

  it("replaces null with empty string", () => {
    expect(render("Value: {{key}}", { key: null })).toBe("Value: ");
  });

  it("JSON.stringifies objects", () => {
    expect(render("Data: {{obj}}", { obj: { a: 1 } })).toBe('Data: {"a":1}');
  });

  it("converts numbers to string", () => {
    expect(render("Count: {{n}}", { n: 42 })).toBe("Count: 42");
  });

  it("does not recurse into substituted values", () => {
    expect(render("{{key}}", { key: "{{other}}", other: "nope" })).toBe("{{other}}");
  });

  it("returns string unchanged when no placeholders", () => {
    expect(render("no placeholders here", { key: "val" })).toBe("no placeholders here");
  });

  it("handles multiple placeholders", () => {
    expect(render("{{a}} and {{b}}", { a: "X", b: "Y" })).toBe("X and Y");
  });

  it("handles deeply nested dot-path", () => {
    expect(render("{{a.b.c}}", { a: { b: { c: "deep" } } })).toBe("deep");
  });
});
