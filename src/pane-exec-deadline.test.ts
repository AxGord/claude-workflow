import { expect, test } from "vitest";
import { execDeadlineMs } from "../hooks/pane-view.js";
import { POOL_WAIT_CEILING_FACTOR } from "./types.js";

// The plan pane (hooks/pane-view.ts, import-free) holds its own copy of the engine's deadline stretch.
test("the pane's exec deadline stretches by the pool wait up to the engine's ceiling factor", () => {
  expect(execDeadlineMs(1000, 10 ** 9)).toBe(1000 * POOL_WAIT_CEILING_FACTOR);
  expect(execDeadlineMs(1000, 500)).toBe(1500);
});
