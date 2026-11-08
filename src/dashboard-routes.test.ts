import { describe, expect, it } from "vitest";
import { parseRoute, routePath, routeTab, type Route } from "./dashboard-routes.js";

const TABLE: [string, Route][] = [
  ["/", { view: "sessions" }],
  ["/sessions", { view: "sessions" }],
  ["/session/abc-1", { view: "session", id: "abc-1" }],
  ["/workflows", { view: "workflows" }],
  ["/workflow/engine-task", { view: "workflow", name: "engine-task" }],
  ["/workflow/a%20b%2Fc", { view: "workflow", name: "a b/c" }],
  ["/plan", { view: "plan" }],
  ["/plan/", { view: "plan" }],
  ["/timeline", { view: "timeline" }],
  ["/timeline/2026-11-08", { view: "timeline", day: "2026-11-08" }],
  ["/pool", { view: "pool" }],
  ["/cost", { view: "cost" }],
  ["/map", { view: "map" }],
  ["/map/abc-1", { view: "map", lane: "abc-1" }],
];

describe("dashboard route table", () => {
  it.each(TABLE)("%s is its view", (p, route) => {
    expect(parseRoute(p)).toEqual(route);
  });

  it.each([
    "/session",
    "/session/",
    "/session/a/b",
    "/workflow",
    "/nope",
    "//",
    "/plan/x",
    "/map/a/b",
    "/timeline/today",
    "/timeline/2026-11-08/x",
    "session/a",
    "/session/%E0%A4%A",
  ])("%s belongs to no view", p => {
    expect(parseRoute(p)).toBeNull();
  });

  it("routePath is the canonical inverse of parseRoute", () => {
    for (const [, route] of TABLE) expect(parseRoute(routePath(route))).toEqual(route);
    expect(routePath({ view: "session", id: "a/b" })).toBe("/session/a%2Fb");
    expect(routePath({ view: "sessions" })).toBe("/sessions");
  });

  it("every view lives under one of the seven tabs", () => {
    expect(TABLE.map(([, r]) => routeTab(r))).toEqual([
      "sessions",
      "sessions",
      "sessions",
      "workflows",
      "workflows",
      "workflows",
      "plan",
      "plan",
      "timeline",
      "timeline",
      "pool",
      "cost",
      "map",
      "map",
    ]);
  });
});
