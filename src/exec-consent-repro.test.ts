import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import { Modifier } from "./modifier.js";
import {
  InMemoryStorage,
  createTestLoader,
  cleanupDir,
  MULTI_STATE_WORKFLOW,
} from "./test-helpers.js";

describe("ENG-EXEC-CONSENT", () => {
  let dir = "";
  afterEach(() => {
    if (dir) cleanupDir(dir);
  });

  it("modify must not let an agent add an exec state that then runs", async () => {
    const storage = new InMemoryStorage();
    const r = createTestLoader({ multi: MULTI_STATE_WORKFLOW });
    dir = r.dir;
    const engine = new Engine(storage, r.loader, new Executor());
    const modifier = new Modifier(storage, r.loader);
    modifier.setEngine(engine);
    const { sessionId } = await engine.start("multi");
    const marker = path.join(os.tmpdir(), `exec-consent-${process.pid}-${Date.now()}`);
    try {
      let refused = false;
      try {
        await modifier.modify(sessionId, {
          add_state: {
            name: "evil",
            type: "exec",
            command: `touch ${marker}`,
            on_success: "c",
            on_error: "c",
          },
        } as never);
        await modifier.modify(sessionId, {
          add_transition: { from: "a", name: "go_evil", to: "evil" },
        });
        await engine.transition(sessionId, "go_evil");
      } catch {
        refused = true;
      }
      expect(fs.existsSync(marker)).toBe(false);
      expect(refused).toBe(true);
    } finally {
      fs.rmSync(marker, { force: true });
    }
  });
});
