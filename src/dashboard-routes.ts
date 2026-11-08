// The dashboard's route table, shared by the browser (served as /routes.js) and the server tests.
// Pure and import-free so the compiled file runs in a page unchanged.

export type Route =
  | { view: "sessions" }
  | { view: "session"; id: string }
  | { view: "workflows" }
  | { view: "workflow"; name: string }
  | { view: "plan" }
  /** the day's task pipelines as bars; `day` = YYYY-MM-DD, today when absent */
  | { view: "timeline"; day?: string }
  /** tokens and USD per finished task pipeline of a day range, from the ledger */
  | { view: "cost" }
  /** the machine-wide thread pool: budget, leases, waiters */
  | { view: "pool" }
  /** the live workflow map; `lane` = a session whose lane is scrolled to and highlighted */
  | { view: "map"; lane?: string };

export type RouteView = Route["view"];

/** The tab a view lives under. */
export function routeTab(
  route: Route,
): "sessions" | "workflows" | "plan" | "timeline" | "pool" | "cost" | "map" {
  switch (route.view) {
    case "session":
    case "sessions":
      return "sessions";
    case "workflow":
    case "workflows":
      return "workflows";
    case "plan":
      return "plan";
    case "timeline":
      return "timeline";
    case "pool":
      return "pool";
    case "cost":
      return "cost";
    case "map":
      return "map";
  }
}

function segment(raw: string): string | null {
  try {
    const s = decodeURIComponent(raw);
    return s === "" ? null : s;
  } catch {
    return null;
  }
}

/** The view a URL path shows; `/` is the sessions view; null for a path no view owns. */
export function parseRoute(pathname: string): Route | null {
  const parts = pathname.split("/");
  if (parts[0] !== "") return null;
  const rest = parts.slice(1);
  if (rest.at(-1) === "") rest.pop();
  if (rest.length === 0) return { view: "sessions" };
  const [head, arg] = rest;
  if (rest.length === 1) {
    if (head === "sessions") return { view: "sessions" };
    if (head === "workflows") return { view: "workflows" };
    if (head === "plan") return { view: "plan" };
    if (head === "timeline") return { view: "timeline" };
    if (head === "pool") return { view: "pool" };
    if (head === "cost") return { view: "cost" };
    if (head === "map") return { view: "map" };
    return null;
  }
  if (rest.length !== 2) return null;
  const value = segment(arg);
  if (value === null) return null;
  if (head === "session") return { view: "session", id: value };
  if (head === "workflow") return { view: "workflow", name: value };
  if (head === "timeline")
    return /^\d{4}-\d{2}-\d{2}$/.test(value) ? { view: "timeline", day: value } : null;
  if (head === "map") return { view: "map", lane: value };
  return null;
}

/** The canonical path of a view: the inverse of parseRoute. */
export function routePath(route: Route): string {
  switch (route.view) {
    case "sessions":
      return "/sessions";
    case "session":
      return `/session/${encodeURIComponent(route.id)}`;
    case "workflows":
      return "/workflows";
    case "workflow":
      return `/workflow/${encodeURIComponent(route.name)}`;
    case "plan":
      return "/plan";
    case "timeline":
      return route.day === undefined ? "/timeline" : `/timeline/${route.day}`;
    case "pool":
      return "/pool";
    case "cost":
      return "/cost";
    case "map":
      return route.lane === undefined ? "/map" : `/map/${encodeURIComponent(route.lane)}`;
  }
}
