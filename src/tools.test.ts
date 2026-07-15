import { describe, it, expect, beforeEach } from "vitest";
import { formatStatus, resetDeliveredPrompts } from "./tools.js";
import type { StatusResult } from "./engine.js";

function makeStatus(overrides: Partial<StatusResult> = {}): StatusResult {
  return {
    sessionId: "s1",
    stack: [{ workflow: "master", current_state: "route", state_visits: {} } as never],
    activeFrame: 0,
    currentState: { prompt: "FULL ROUTING RULES", digest_on_repeat: true },
    currentStateName: "route",
    currentWorkflow: "master",
    availableTransitions: { chat: "chat" },
    prompt: "FULL ROUTING RULES",
    history: [],
    context: {},
    taskOps: [],
    visitCount: 1,
    ...overrides,
  } as StatusResult;
}

describe("formatStatus digest_on_repeat", () => {
  beforeEach(() => resetDeliveredPrompts());

  it("delivers the full prompt on first delivery in the process", () => {
    const out = formatStatus(makeStatus());
    expect(out).toContain("FULL ROUTING RULES");
  });

  it("delivers a digest on the second delivery of the same state", () => {
    formatStatus(makeStatus());
    const out = formatStatus(makeStatus({ sessionId: "s2" }));
    expect(out).not.toContain("FULL ROUTING RULES");
    expect(out).toContain("already delivered earlier in this process");
    expect(out).toContain("TRANSITIONS: chat");
  });

  it("forceFullPrompt (status tool) always returns the full text", () => {
    formatStatus(makeStatus());
    const out = formatStatus(makeStatus(), { forceFullPrompt: true });
    expect(out).toContain("FULL ROUTING RULES");
  });

  it("states without the flag always get the full prompt", () => {
    const plain = makeStatus({
      currentState: { prompt: "PLAIN" },
      currentStateName: "chat",
      prompt: "PLAIN",
    });
    formatStatus(plain);
    const out = formatStatus(plain);
    expect(out).toContain("PLAIN");
  });

  it("same-session revisit abbreviation still wins over the digest", () => {
    formatStatus(makeStatus());
    const out = formatStatus(makeStatus({ visitCount: 2 }));
    expect(out).toContain("Revisit #2");
    expect(out).not.toContain("FULL ROUTING RULES");
  });

  it("digest keys are per workflow:state — a different state is unaffected", () => {
    formatStatus(makeStatus());
    const other = makeStatus({
      currentStateName: "doc_sync",
      currentState: { prompt: "DOC SYNC RULES", digest_on_repeat: true },
      prompt: "DOC SYNC RULES",
    });
    const out = formatStatus(other);
    expect(out).toContain("DOC SYNC RULES");
  });
});
