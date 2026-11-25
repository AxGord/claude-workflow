/**
 * The short tail a Next row of the plan pane draws: what keeps a pending line from starting, in the picker's own words
 * cut to one phrase. A pure module (no node imports) so the replay builds the same tail the live pane reads.
 */

/** How a line may not run beside another, as `planPick` records it. */
export type WaitAgainst = {
  readonly how: "overlap" | "hold" | "runs-alone" | "window-not-empty";
  readonly id: string;
};

/**
 * The tail for a pending line the picker refused with `why`: `waits: <id> (overlap)` for a line it may not run beside,
 * `after: <ids>` for an unfinished `after:`, `parked`, `breaking`, or the picker's reason as it stands. `against` is the
 * pick's structured form of that refusal when it has one.
 */
export function waitTail(why: string, against?: WaitAgainst): string {
  if (against !== undefined) {
    switch (against.how) {
      case "overlap":
        return `waits: ${against.id} (overlap)`;
      case "hold":
        return `waits: ${against.id} (exclusive)`;
      case "runs-alone":
        return `waits: ${against.id} (breaking)`;
      case "window-not-empty":
        return "breaking";
    }
  }
  if (why.startsWith("parent-run")) return "parent-run";
  if (why.startsWith("paused")) return "paused";
  return why;
}
