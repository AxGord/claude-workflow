import type { StateDefinition, WorkflowDefinition } from "./types.js";

/** One column of a workflow's band on the live map. */
export interface Station {
  readonly name: string;
  /** an exec state: a script, drawn as a square */
  readonly script: boolean;
  readonly terminal: boolean;
}

/** The moves a state makes when all goes well; error, timeout, exhaustion and fallback routes are not on the main path. */
function happyTargets(s: StateDefinition): string[] {
  return [
    ...Object.values(s.transitions ?? {}),
    s.on_success,
    s.on_complete,
    s.cases?.["0"],
  ].filter((t): t is string => t !== undefined);
}

/** Every move a state can make, the happy ones first. */
export function allTargets(s: StateDefinition): string[] {
  return [
    ...happyTargets(s),
    ...Object.values(s.cases ?? {}),
    s.default,
    s.on_timeout,
    s.on_error,
    s.on_exhausted,
    s.on_fail,
  ].filter((t): t is string => t !== undefined);
}

/** Breadth-first distance from `from` along `next`; a state is first reached by the earliest-declared route. */
function distances(
  wf: WorkflowDefinition,
  next: (s: StateDefinition) => string[],
): Map<string, { dist: number; prev: string | undefined }> {
  const seen = new Map<string, { dist: number; prev: string | undefined }>([
    [wf.initial, { dist: 0, prev: undefined }],
  ]);
  const queue = [wf.initial];
  for (let i = 0; i < queue.length; i++) {
    const from = queue[i];
    const state = wf.states[from];
    if (!state) continue;
    const { dist } = seen.get(from) as { dist: number };
    for (const to of next(state)) {
      if (seen.has(to) || !wf.states[to]) continue;
      seen.set(to, { dist: dist + 1, prev: from });
      queue.push(to);
    }
  }
  return seen;
}

/** The terminals whose `station: true` counts: exactly one non-failing terminal; any other mark is ignored. */
function stationMarkedEnds(wf: WorkflowDefinition): string[] {
  const marked = Object.entries(wf.states)
    .filter(([, s]) => s.terminal && s.outcome !== "fail" && s.station === true)
    .map(([name]) => name);
  return marked.length === 1 ? marked : [];
}

/** One line per misplaced `station: true` on a terminal: on a failure terminal, or on more than one terminal. */
export function stationWarnings(wf: WorkflowDefinition): string[] {
  const marks = Object.entries(wf.states).filter(([, s]) => s.terminal && s.station === true);
  const failing = marks.filter(([, s]) => s.outcome === "fail").map(([name]) => name);
  const warnings: string[] = [];
  if (failing.length > 0)
    warnings.push(
      `workflow ${wf.name}: station: true on a failure terminal (${failing.join(", ")}) is ignored`,
    );
  const good = marks.filter(([, s]) => s.outcome !== "fail");
  if (good.length > 1)
    warnings.push(
      `workflow ${wf.name}: station: true on several terminals (${good.map(([n]) => n).join(", ")}) is ignored`,
    );
  return warnings;
}

/**
 * The columns of a workflow's band: the shortest path from `initial` to its success terminal, over
 * the happy moves (all moves when that terminal is out of their reach). The success terminal is a
 * terminal marked `station: true`, else the farthest terminal whose outcome is not `fail` (the early
 * exits — released, closed — are shorter). A state's `station: false` leaves it out, `station: true`
 * adds it when reachable; stations come in order of their distance from `initial`.
 */
export function computeStations(wf: WorkflowDefinition): Station[] {
  const happy = distances(wf, happyTargets);
  const all = distances(wf, allTargets);
  const farthest = (
    reach: Map<string, { dist: number }>,
    names: readonly string[],
  ): string | undefined => {
    let best: string | undefined;
    for (const name of names.filter(n => reach.has(n)))
      if (best === undefined || (reach.get(name)?.dist ?? 0) > (reach.get(best)?.dist ?? 0))
        best = name;
    return best;
  };
  const ends = Object.entries(wf.states).filter(([, s]) => s.terminal && s.outcome !== "fail");
  const marked = stationMarkedEnds(wf);
  const unmarked = ends.map(([name]) => name);
  // a marked terminal is the end whenever any move reaches it; the happy moves route to it when they can
  let reach = happy;
  let target: string | undefined;
  if (farthest(all, marked) !== undefined) {
    target = farthest(happy, marked);
    if (target === undefined) {
      reach = all;
      target = farthest(all, marked);
    }
  } else {
    target = farthest(happy, unmarked);
    if (target === undefined) {
      reach = all;
      target = farthest(all, unmarked);
    }
  }
  if (target === undefined) return [];

  const onPath = new Set<string>();
  for (let at: string | undefined = target; at !== undefined; at = reach.get(at)?.prev)
    onPath.add(at);
  const distance = (name: string): number => (reach.get(name) ?? all.get(name))?.dist ?? 0;
  const order = Object.keys(wf.states);
  return order
    .filter(name => {
      const station = wf.states[name].station;
      const isEnd = wf.states[name].terminal === true;
      if (station === true && (!isEnd || marked.includes(name))) return all.has(name);
      return station !== false && onPath.has(name);
    })
    .sort((a, b) => distance(a) - distance(b))
    .map(name => ({
      name,
      script: wf.states[name].type === "exec",
      terminal: wf.states[name].terminal === true,
    }));
}

/**
 * A move into `target` that only closes the run: the state is terminal, or no route leads back to it
 * and one leads on to a terminal. The `max_transitions` cap refuses every other move, so a run at its
 * cap can still end cleanly (`stop` -> `report` -> `finish`) but not take another turn of its loop.
 */
export function isClosingMove(wf: WorkflowDefinition, target: string): boolean {
  const start = wf.states[target];
  if (!start) return false;
  if (start.terminal === true) return true;
  const seen = new Set<string>();
  const queue = allTargets(start);
  let terminal = false;
  for (let i = 0; i < queue.length; i++) {
    const name = queue[i];
    if (name === target) return false;
    if (seen.has(name)) continue;
    seen.add(name);
    const state = wf.states[name];
    if (!state) continue;
    if (state.terminal === true) terminal = true;
    queue.push(...allTargets(state));
  }
  return terminal;
}
