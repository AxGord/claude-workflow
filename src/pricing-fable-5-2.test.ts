import { describe, expect, it } from "vitest";
import { turnUsd } from "./calibration.js";

const none = { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 };
const M = 1e6;

describe("turnUsd Fable 5.2 and Sonnet 5.5 cache rates", () => {
  it("claude-fable-5-2 input is $8/MTok", () => {
    expect(turnUsd("claude-fable-5-2", { ...none, input: M })).toBeCloseTo(8, 5);
  });
  it("claude-fable-5-2 output is $40/MTok", () => {
    expect(turnUsd("claude-fable-5-2", { ...none, output: M })).toBeCloseTo(40, 5);
  });
  it("claude-fable-5-2 cache read is $0.20/MTok", () => {
    expect(turnUsd("claude-fable-5-2", { ...none, cache_read: M })).toBeCloseTo(0.2, 5);
  });
  it("claude-fable-5-2 5m cache write is $10/MTok", () => {
    expect(turnUsd("claude-fable-5-2", { ...none, cache_write_5m: M })).toBeCloseTo(10, 5);
  });
  it("bare fable alias prices at the 5.2 rates", () => {
    expect(turnUsd("fable", { ...none, input: M, output: M })).toBeCloseTo(48, 5);
    expect(turnUsd("fable", { ...none, cache_read: M })).toBeCloseTo(0.2, 5);
  });
  it("claude-sonnet-5-5 cache read is $0.10/MTok", () => {
    expect(turnUsd("claude-sonnet-5-5", { ...none, cache_read: M })).toBeCloseTo(0.1, 5);
  });
});
