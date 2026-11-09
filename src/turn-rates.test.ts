import { describe, expect, it } from "vitest";
import { turnUsd } from "./calibration.js";

const u = { input: 1e6, output: 1e6, cache_read: 1e6, cache_write_5m: 1e6, cache_write_1h: 0 };
describe("turnUsd current list rates", () => {
  it("claude-opus-5-5 is $4/$20", () => {
    expect(turnUsd("claude-opus-5-5", { ...u, cache_read: 0, cache_write_5m: 0 })).toBeCloseTo(
      24,
      5,
    );
  });
  it("claude-haiku-5-5 is $.10/$.50", () => {
    expect(turnUsd("claude-haiku-5-5", { ...u, cache_read: 0, cache_write_5m: 0 })).toBeCloseTo(
      0.6,
      5,
    );
  });
  it("claude-opus-4-8 is $5/$25", () => {
    expect(turnUsd("claude-opus-4-8", { ...u, cache_read: 0, cache_write_5m: 0 })).toBeCloseTo(
      30,
      5,
    );
  });
});

describe("turnUsd model-id rates", () => {
  const only = (i: number, o: number) => ({
    input: i,
    output: o,
    cache_read: 0,
    cache_write_5m: 0,
    cache_write_1h: 0,
  });
  it("sonnet-5-5 $2/$10, sonnet-4-6 $3/$15", () => {
    expect(turnUsd("claude-sonnet-5-5", only(1e6, 1e6))).toBeCloseTo(12, 5);
    expect(turnUsd("claude-sonnet-4-6", only(1e6, 1e6))).toBeCloseTo(18, 5);
  });
  it("haiku-4-5 $1/$5, older opus-4-1 $15/$75", () => {
    expect(turnUsd("claude-haiku-4-5", only(1e6, 1e6))).toBeCloseTo(6, 5);
    expect(turnUsd("claude-opus-4-1", only(1e6, 1e6))).toBeCloseTo(90, 5);
  });
  it("cache multiples and family fallback", () => {
    expect(
      turnUsd("claude-opus-5-5", {
        input: 0,
        output: 0,
        cache_read: 1e6,
        cache_write_5m: 1e6,
        cache_write_1h: 1e6,
      }),
    ).toBeCloseTo(0.2 + 5 + 8, 5);
    expect(turnUsd("claude-opus-9-9", only(1e6, 0))).toBeCloseTo(4, 5);
  });
  it("an unknown model stays unmeasured", () => {
    expect(turnUsd("gpt-5", only(1, 1))).toBeUndefined();
  });
});

describe("turnUsd fable cache reads", () => {
  const read = { input: 0, output: 0, cache_read: 1e6, cache_write_5m: 0, cache_write_1h: 0 };
  it("claude-fable-5-1 reads at $0.25, claude-fable-5 at $1, the family at $0.25", () => {
    expect(turnUsd("claude-fable-5-1", read)).toBeCloseTo(0.25, 5);
    expect(turnUsd("claude-fable-5", read)).toBeCloseTo(1, 5);
    expect(turnUsd("claude-fable-9", read)).toBeCloseTo(0.25, 5);
  });
});
