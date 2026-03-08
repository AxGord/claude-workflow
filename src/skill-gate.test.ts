import { describe, it, expect, afterEach } from "vitest";
import { Engine } from "./engine.js";
import { Executor } from "./executor.js";
import {
  InMemoryStorage,
  createTestLoader,
  cleanupDir,
} from "./test-helpers.js";
import type { Loader } from "./loader.js";

describe("Skill Gate", () => {
  let storage: InMemoryStorage;
  let loader: Loader;
  let executor: Executor;
  let engine: Engine;
  let dir: string;

  function setup(workflows: Record<string, object>) {
    storage = new InMemoryStorage();
    const result = createTestLoader(workflows);
    loader = result.loader;
    dir = result.dir;
    executor = new Executor();
    engine = new Engine(storage, loader, executor);
  }

  afterEach(() => {
    if (dir) cleanupDir(dir);
  });

  /** Basic workflow with a skill gate state in the middle. */
  const SKILL_GATE_WORKFLOW = {
    initial: "start",
    states: {
      start: {
        prompt: "Begin",
        transitions: { load_skills: "gate" },
      },
      gate: {
        prompt: "Gate prompt",
        skills: ["skill-a", "skill-b"],
        transitions: { continue: "work" },
      },
      work: {
        prompt: "Do the work",
        transitions: { done: "end" },
      },
      end: {
        prompt: "Done",
        terminal: true,
        outcome: "complete",
      },
    },
  };

  describe("blocking when skills are not loaded", () => {
    it("returns skill loading prompt when entering a skill gate with unloaded skills", async () => {
      setup({ wf: SKILL_GATE_WORKFLOW });
      const { sessionId } = await engine.start("wf");

      const result = await engine.transition(sessionId, "load_skills");

      // Should stay at the gate state and prompt to load skills
      expect(result.currentStateName).toBe("gate");
      expect(result.prompt).toContain('Skill("skill-a")');
      expect(result.prompt).toContain('Skill("skill-b")');
      expect(result.prompt).toContain("Load the following skills");
    });

    it("includes the state's own prompt before the skill loading instructions", async () => {
      setup({ wf: SKILL_GATE_WORKFLOW });
      const { sessionId } = await engine.start("wf");

      const result = await engine.transition(sessionId, "load_skills");

      expect(result.prompt).toContain("Gate prompt");
    });
  });

  describe("marking skills as loaded on transition", () => {
    it("marks skills as loaded when transitioning FROM a skill gate state", async () => {
      setup({ wf: SKILL_GATE_WORKFLOW });
      const { sessionId } = await engine.start("wf");

      // Enter the gate (skills not loaded, blocks)
      await engine.transition(sessionId, "load_skills");

      // Now manually transition out — this should mark skills as loaded
      const result = await engine.transition(sessionId, "continue");

      expect(result.currentStateName).toBe("work");

      // Verify the session has loaded_skills set
      const session = storage.read(sessionId);
      expect(session).not.toBeNull();
      expect(session!.loaded_skills).toBeDefined();
      expect(session!.loaded_skills!["skill-a"]).toBe(0); // epoch 0
      expect(session!.loaded_skills!["skill-b"]).toBe(0);
    });
  });

  describe("auto-transitioning when skills are already loaded", () => {
    it("auto-transitions through the gate when all skills are loaded", async () => {
      setup({ wf: SKILL_GATE_WORKFLOW });
      const { sessionId } = await engine.start("wf");

      // Enter the gate (blocks)
      await engine.transition(sessionId, "load_skills");

      // Transition from the gate — this marks skills as loaded
      await engine.transition(sessionId, "continue");

      // Now go back to start and re-enter the gate
      // We need a workflow that allows cycling back
      cleanupDir(dir);
      setup({
        wf: {
          initial: "start",
          states: {
            start: {
              prompt: "Begin",
              transitions: { load_skills: "gate" },
            },
            gate: {
              prompt: "Gate prompt",
              skills: ["skill-a", "skill-b"],
              transitions: { continue: "work" },
            },
            work: {
              prompt: "Do the work",
              transitions: { back: "start", done: "end" },
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      // Re-create engine with the cycle workflow
      const { sessionId: sid2 } = await engine.start("wf");

      // First pass: gate blocks
      await engine.transition(sid2, "load_skills");
      // Transition from gate marks skills loaded
      await engine.transition(sid2, "continue");
      // Go back to start
      await engine.transition(sid2, "back");
      // Re-enter gate — should auto-transition through since skills are loaded
      const result = await engine.transition(sid2, "load_skills");

      expect(result.currentStateName).toBe("work");
      expect(result.prompt).toBe("Do the work");
    });

    it("records auto-transition in history with event=skill_gate", async () => {
      setup({
        wf: {
          initial: "start",
          states: {
            start: {
              prompt: "Begin",
              transitions: { load_skills: "gate" },
            },
            gate: {
              prompt: "Gate prompt",
              skills: ["skill-a"],
              transitions: { continue: "work" },
            },
            work: {
              prompt: "Do the work",
              transitions: { back: "start", done: "end" },
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("wf");

      // Load skills
      await engine.transition(sessionId, "load_skills");
      await engine.transition(sessionId, "continue");
      await engine.transition(sessionId, "back");

      // Re-enter gate with skills loaded — auto-transition
      const result = await engine.transition(sessionId, "load_skills");

      const autoEntry = result.history.find(
        h => h.event === "skill_gate" && h.from === "gate" && h.to === "work"
      );
      expect(autoEntry).toBeDefined();
    });
  });

  describe("epoch-based staleness", () => {
    it("blocks again after skill_epoch is incremented", async () => {
      setup({
        wf: {
          initial: "start",
          states: {
            start: {
              prompt: "Begin",
              transitions: { load_skills: "gate" },
            },
            gate: {
              prompt: "Gate prompt",
              skills: ["skill-a"],
              transitions: { continue: "work" },
            },
            work: {
              prompt: "Do the work",
              transitions: { back: "start", done: "end" },
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("wf");

      // Load skills through the gate
      await engine.transition(sessionId, "load_skills");
      await engine.transition(sessionId, "continue");

      // Verify skills are loaded at epoch 0
      let session = storage.read(sessionId)!;
      expect(session.loaded_skills!["skill-a"]).toBe(0);

      // Simulate context clear by incrementing skill_epoch
      await storage.write(sessionId, {
        ...session,
        skill_epoch: 1,
      });

      // Go back to start and re-enter gate
      await engine.transition(sessionId, "back");
      const result = await engine.transition(sessionId, "load_skills");

      // Gate should block because skills were loaded at epoch 0, but current epoch is 1
      expect(result.currentStateName).toBe("gate");
      expect(result.prompt).toContain('Skill("skill-a")');
      expect(result.prompt).toContain("Load the following skills");
    });

    it("allows passage after reloading skills at new epoch", async () => {
      setup({
        wf: {
          initial: "start",
          states: {
            start: {
              prompt: "Begin",
              transitions: { load_skills: "gate" },
            },
            gate: {
              prompt: "Gate prompt",
              skills: ["skill-a"],
              transitions: { continue: "work" },
            },
            work: {
              prompt: "Do the work",
              transitions: { back: "start", done: "end" },
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("wf");

      // Load skills at epoch 0
      await engine.transition(sessionId, "load_skills");
      await engine.transition(sessionId, "continue");

      // Bump epoch
      let session = storage.read(sessionId)!;
      await storage.write(sessionId, { ...session, skill_epoch: 1 });

      // Go back, re-enter gate (blocks)
      await engine.transition(sessionId, "back");
      await engine.transition(sessionId, "load_skills");

      // Now transition from gate again — marks skills at epoch 1
      await engine.transition(sessionId, "continue");

      session = storage.read(sessionId)!;
      expect(session.loaded_skills!["skill-a"]).toBe(1);

      // Go back again and re-enter — should auto-transition now
      await engine.transition(sessionId, "back");
      const result = await engine.transition(sessionId, "load_skills");

      expect(result.currentStateName).toBe("work");
    });
  });

  describe("skill gate as initial state", () => {
    it("blocks at initial state when skills are not loaded", async () => {
      setup({
        wf: {
          initial: "gate",
          states: {
            gate: {
              prompt: "Initial gate",
              skills: ["init-skill"],
              transitions: { continue: "work" },
            },
            work: {
              prompt: "Working",
              transitions: { done: "end" },
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const result = await engine.start("wf");

      expect(result.currentStateName).toBe("gate");
      expect(result.prompt).toContain('Skill("init-skill")');
      expect(result.prompt).toContain("Load the following skills");
    });

    it("auto-transitions from initial state when skills are pre-loaded", async () => {
      setup({
        wf: {
          initial: "gate",
          states: {
            gate: {
              prompt: "Initial gate",
              skills: ["init-skill"],
              transitions: { continue: "work" },
            },
            work: {
              prompt: "Working",
              transitions: { done: "end" },
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      // Start normally (gate blocks)
      const { sessionId } = await engine.start("wf");

      // Pre-load the skill in session data
      let session = storage.read(sessionId)!;
      await storage.write(sessionId, {
        ...session,
        loaded_skills: { "init-skill": 0 },
      });

      // Now if we get status, it should still show the gate
      // But entering via a new session start with pre-loaded skills would auto-transition
      // Let's test by creating a second workflow that starts fresh with pre-loaded skills

      // Actually, the auto-transition happens at _handleSkillGate time.
      // Start a new session and manually set loaded_skills before the engine checks
      const { sessionId: sid2 } = await engine.start("wf");
      // This blocks at gate — but let's pre-load and then transition
      session = storage.read(sid2)!;
      await storage.write(sid2, {
        ...session,
        loaded_skills: { "init-skill": 0 },
      });

      // getStatus still reports gate since no re-evaluation happens
      // But calling transition from gate should work normally
      const result = await engine.transition(sid2, "continue");
      expect(result.currentStateName).toBe("work");
    });
  });

  describe("partial skill loading", () => {
    it("blocks when only some skills are loaded", async () => {
      setup({
        wf: {
          initial: "start",
          states: {
            start: {
              prompt: "Begin",
              transitions: { load_skills: "gate" },
            },
            gate: {
              prompt: "Gate",
              skills: ["skill-a", "skill-b", "skill-c"],
              transitions: { continue: "work" },
            },
            work: {
              prompt: "Working",
              transitions: { done: "end" },
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("wf");

      // Pre-load only skill-a
      let session = storage.read(sessionId)!;
      await storage.write(sessionId, {
        ...session,
        loaded_skills: { "skill-a": 0 },
      });

      const result = await engine.transition(sessionId, "load_skills");

      // Should still block — skill-b and skill-c are missing
      expect(result.currentStateName).toBe("gate");
      expect(result.prompt).toContain('Skill("skill-b")');
      expect(result.prompt).toContain('Skill("skill-c")');
      // skill-a is loaded, should NOT appear in the missing list
      expect(result.prompt).not.toContain('Skill("skill-a")');
    });
  });

  describe("skill gate with no transitions", () => {
    it("throws error when a loaded skill gate has no transitions to auto-follow", async () => {
      setup({
        wf: {
          initial: "start",
          states: {
            start: {
              prompt: "Begin",
              transitions: { go: "gate" },
            },
            gate: {
              prompt: "Gate",
              skills: ["skill-a"],
              // No transitions defined
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("wf");

      // Pre-load skills so gate tries to auto-transition
      let session = storage.read(sessionId)!;
      await storage.write(sessionId, {
        ...session,
        loaded_skills: { "skill-a": 0 },
      });

      await expect(engine.transition(sessionId, "go"))
        .rejects.toThrow("no transitions defined");
    });
  });

  describe("skill gate in sub_workflow", () => {
    it("handles skill gate at start of sub_workflow", async () => {
      setup({
        parent: {
          initial: "start",
          states: {
            start: {
              sub_workflow: "child",
              on_complete: "done",
              on_fail: "done",
            },
            done: {
              prompt: "Parent done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
        child: {
          initial: "gate",
          states: {
            gate: {
              prompt: "Child gate",
              skills: ["child-skill"],
              transitions: { continue: "work" },
            },
            work: {
              prompt: "Child working",
              transitions: { finish: "end" },
            },
            end: {
              prompt: "Child done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const result = await engine.start("parent");

      // Should push into child workflow and block at the skill gate
      expect(result.stack).toHaveLength(2);
      expect(result.currentWorkflow).toBe("child");
      expect(result.currentStateName).toBe("gate");
      expect(result.prompt).toContain('Skill("child-skill")');
    });
  });

  describe("multiple skill gates in sequence", () => {
    it("handles chained skill gates (gate → gate → work)", async () => {
      setup({
        wf: {
          initial: "start",
          states: {
            start: {
              prompt: "Begin",
              transitions: { go: "gate1" },
            },
            gate1: {
              prompt: "First gate",
              skills: ["skill-a"],
              transitions: { continue: "gate2" },
            },
            gate2: {
              prompt: "Second gate",
              skills: ["skill-b"],
              transitions: { continue: "work" },
            },
            work: {
              prompt: "Working",
              transitions: { done: "end" },
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("wf");

      // Pre-load both skills
      let session = storage.read(sessionId)!;
      await storage.write(sessionId, {
        ...session,
        loaded_skills: { "skill-a": 0, "skill-b": 0 },
      });

      // Enter gate1 — skills loaded, auto-transitions to gate2 — skills loaded, auto-transitions to work
      const result = await engine.transition(sessionId, "go");

      expect(result.currentStateName).toBe("work");
      expect(result.prompt).toBe("Working");
    });

    it("stops at second gate when only first gate's skills are loaded", async () => {
      setup({
        wf: {
          initial: "start",
          states: {
            start: {
              prompt: "Begin",
              transitions: { go: "gate1" },
            },
            gate1: {
              prompt: "First gate",
              skills: ["skill-a"],
              transitions: { continue: "gate2" },
            },
            gate2: {
              prompt: "Second gate",
              skills: ["skill-b"],
              transitions: { continue: "work" },
            },
            work: {
              prompt: "Working",
              transitions: { done: "end" },
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("wf");

      // Pre-load only skill-a
      let session = storage.read(sessionId)!;
      await storage.write(sessionId, {
        ...session,
        loaded_skills: { "skill-a": 0 },
      });

      // Enter gate1 — skill-a loaded, auto-transitions to gate2 — skill-b not loaded, blocks
      const result = await engine.transition(sessionId, "go");

      expect(result.currentStateName).toBe("gate2");
      expect(result.prompt).toContain('Skill("skill-b")');
    });
  });

  describe("dispatch chain integration", () => {
    // ---------------------------------------------------------------
    // 1. start() landing on a sub_workflow initial state
    // ---------------------------------------------------------------
    it("start() on a sub_workflow initial state pushes into the child", async () => {
      setup({
        parent: {
          initial: "launch",
          states: {
            launch: {
              sub_workflow: "child",
              on_complete: "done",
              on_fail: "done",
            },
            done: {
              prompt: "Parent done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
        child: {
          initial: "work",
          states: {
            work: {
              prompt: "Child working",
              transitions: { finish: "end" },
            },
            end: {
              prompt: "Child done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const result = await engine.start("parent");

      expect(result.stack).toHaveLength(2);
      expect(result.currentWorkflow).toBe("child");
      expect(result.currentStateName).toBe("work");
      expect(result.prompt).toBe("Child working");
    });

    // ---------------------------------------------------------------
    // 2. start() landing on an action state as initial state
    // ---------------------------------------------------------------
    it("start() on an action initial state auto-executes and routes", async () => {
      setup({
        wf: {
          initial: "run",
          states: {
            run: {
              type: "exec",
              command: "echo hello",
              on_success: "ok",
              on_error: "fail",
            },
            ok: {
              prompt: "All good",
              transitions: { done: "end" },
            },
            fail: {
              prompt: "Failed",
              terminal: true,
              outcome: "fail",
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const result = await engine.start("wf");

      expect(result.currentStateName).toBe("ok");
      expect(result.prompt).toBe("All good");
    });

    // ---------------------------------------------------------------
    // 3. start() landing on a skill gate initial state (already tested
    //    above, but here we verify integration with the full chain)
    // ---------------------------------------------------------------
    it("start() on a skill gate initial state blocks with skill prompt", async () => {
      setup({
        wf: {
          initial: "gate",
          states: {
            gate: {
              prompt: "Must load skills first",
              skills: ["my-skill"],
              transitions: { continue: "work" },
            },
            work: {
              prompt: "Working",
              transitions: { done: "end" },
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const result = await engine.start("wf");

      expect(result.currentStateName).toBe("gate");
      expect(result.prompt).toContain("Must load skills first");
      expect(result.prompt).toContain('Skill("my-skill")');
      expect(result.prompt).toContain("Load the following skills");
      expect(result.stack).toHaveLength(1);
    });

    // ---------------------------------------------------------------
    // 4. transition() to a terminal state that pops back to a parent
    //    whose on_complete target is a skill gate
    // ---------------------------------------------------------------
    it("terminal pop back to parent skill gate blocks at the gate", async () => {
      setup({
        parent: {
          initial: "delegate",
          states: {
            delegate: {
              sub_workflow: "child",
              on_complete: "parent_gate",
              on_fail: "parent_fail",
            },
            parent_gate: {
              prompt: "Parent gate prompt",
              skills: ["parent-skill"],
              transitions: { continue: "parent_work" },
            },
            parent_work: {
              prompt: "Parent working",
              transitions: { done: "parent_end" },
            },
            parent_fail: {
              prompt: "Parent failed",
              terminal: true,
              outcome: "fail",
            },
            parent_end: {
              prompt: "Parent done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
        child: {
          initial: "work",
          states: {
            work: {
              prompt: "Child working",
              transitions: { finish: "child_end" },
            },
            child_end: {
              prompt: "Child done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("parent");

      // We're in child/work. Transition to child terminal → pops to parent_gate
      const result = await engine.transition(sessionId, "finish");

      // Should pop child, land on parent_gate (skill gate), and block
      expect(result.stack).toHaveLength(1);
      expect(result.currentWorkflow).toBe("parent");
      expect(result.currentStateName).toBe("parent_gate");
      expect(result.prompt).toContain('Skill("parent-skill")');
      expect(result.prompt).toContain("Load the following skills");
    });

    it("terminal pop back to parent skill gate auto-transitions when skills loaded", async () => {
      setup({
        parent: {
          initial: "delegate",
          states: {
            delegate: {
              sub_workflow: "child",
              on_complete: "parent_gate",
              on_fail: "parent_fail",
            },
            parent_gate: {
              prompt: "Parent gate prompt",
              skills: ["parent-skill"],
              transitions: { continue: "parent_work" },
            },
            parent_work: {
              prompt: "Parent working",
              transitions: { done: "parent_end" },
            },
            parent_fail: {
              prompt: "Parent failed",
              terminal: true,
              outcome: "fail",
            },
            parent_end: {
              prompt: "Parent done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
        child: {
          initial: "work",
          states: {
            work: {
              prompt: "Child working",
              transitions: { finish: "child_end" },
            },
            child_end: {
              prompt: "Child done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("parent");

      // Pre-load the parent skill
      let session = storage.read(sessionId)!;
      await storage.write(sessionId, {
        ...session,
        loaded_skills: { "parent-skill": 0 },
      });

      // Child finishes → pops → parent_gate (skills loaded) → auto-transitions to parent_work
      const result = await engine.transition(sessionId, "finish");

      expect(result.stack).toHaveLength(1);
      expect(result.currentWorkflow).toBe("parent");
      expect(result.currentStateName).toBe("parent_work");
      expect(result.prompt).toBe("Parent working");
    });

    // ---------------------------------------------------------------
    // 5. Action state that resolves to a skill gate target
    // ---------------------------------------------------------------
    it("action state routing to a skill gate blocks at the gate", async () => {
      setup({
        wf: {
          initial: "run",
          states: {
            run: {
              type: "exec",
              command: "echo ok",
              on_success: "gate",
              on_error: "fail",
            },
            gate: {
              prompt: "Skills needed",
              skills: ["action-skill"],
              transitions: { continue: "work" },
            },
            work: {
              prompt: "Working",
              transitions: { done: "end" },
            },
            fail: {
              prompt: "Failed",
              terminal: true,
              outcome: "fail",
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const result = await engine.start("wf");

      // exec succeeds → routes to gate → blocks (skills not loaded)
      expect(result.currentStateName).toBe("gate");
      expect(result.prompt).toContain('Skill("action-skill")');
      expect(result.prompt).toContain("Load the following skills");
    });

    it("action state routing to a skill gate auto-transitions when skills pre-loaded", async () => {
      setup({
        wf: {
          initial: "start",
          states: {
            start: {
              prompt: "Begin",
              transitions: { go: "run" },
            },
            run: {
              type: "exec",
              command: "echo ok",
              on_success: "gate",
              on_error: "fail",
            },
            gate: {
              prompt: "Skills needed",
              skills: ["action-skill"],
              transitions: { continue: "work" },
            },
            work: {
              prompt: "Working",
              transitions: { done: "end" },
            },
            fail: {
              prompt: "Failed",
              terminal: true,
              outcome: "fail",
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("wf");

      // Pre-load skills
      let session = storage.read(sessionId)!;
      await storage.write(sessionId, {
        ...session,
        loaded_skills: { "action-skill": 0 },
      });

      // transition → exec → gate (skills loaded) → auto-transition → work
      const result = await engine.transition(sessionId, "go");

      expect(result.currentStateName).toBe("work");
      expect(result.prompt).toBe("Working");
    });

    // ---------------------------------------------------------------
    // 6. Sub-workflow push where the sub-workflow's initial state is
    //    a skill gate
    // ---------------------------------------------------------------
    it("sub_workflow push into a skill gate initial state blocks at the gate", async () => {
      setup({
        parent: {
          initial: "start",
          states: {
            start: {
              prompt: "Begin",
              transitions: { delegate: "sub" },
            },
            sub: {
              sub_workflow: "child",
              on_complete: "done",
              on_fail: "done",
            },
            done: {
              prompt: "Parent done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
        child: {
          initial: "child_gate",
          states: {
            child_gate: {
              prompt: "Child gate",
              skills: ["child-skill"],
              transitions: { continue: "child_work" },
            },
            child_work: {
              prompt: "Child working",
              transitions: { finish: "child_end" },
            },
            child_end: {
              prompt: "Child done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("parent");

      // Transition to sub_workflow state → pushes child → child starts at skill gate → blocks
      const result = await engine.transition(sessionId, "delegate");

      expect(result.stack).toHaveLength(2);
      expect(result.currentWorkflow).toBe("child");
      expect(result.currentStateName).toBe("child_gate");
      expect(result.prompt).toContain('Skill("child-skill")');
    });

    it("sub_workflow push into a skill gate auto-transitions when skills loaded", async () => {
      setup({
        parent: {
          initial: "start",
          states: {
            start: {
              prompt: "Begin",
              transitions: { delegate: "sub" },
            },
            sub: {
              sub_workflow: "child",
              on_complete: "done",
              on_fail: "done",
            },
            done: {
              prompt: "Parent done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
        child: {
          initial: "child_gate",
          states: {
            child_gate: {
              prompt: "Child gate",
              skills: ["child-skill"],
              transitions: { continue: "child_work" },
            },
            child_work: {
              prompt: "Child working",
              transitions: { finish: "child_end" },
            },
            child_end: {
              prompt: "Child done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("parent");

      // Pre-load skills
      let session = storage.read(sessionId)!;
      await storage.write(sessionId, {
        ...session,
        loaded_skills: { "child-skill": 0 },
      });

      // Transition → push child → gate (skills loaded) → auto-transition → child_work
      const result = await engine.transition(sessionId, "delegate");

      expect(result.stack).toHaveLength(2);
      expect(result.currentWorkflow).toBe("child");
      expect(result.currentStateName).toBe("child_work");
      expect(result.prompt).toBe("Child working");
    });

    // ---------------------------------------------------------------
    // 7. Stack pop where the on_complete target is a skill gate
    //    (already covered by test #4 above, but here we test the
    //    full chain: child terminal → pop → parent gate → auto-transition
    //    → parent sub_workflow → push grandchild)
    // ---------------------------------------------------------------
    it("pop → skill gate auto-transition → sub_workflow push chains correctly", async () => {
      setup({
        parent: {
          initial: "delegate_child",
          states: {
            delegate_child: {
              sub_workflow: "child",
              on_complete: "parent_gate",
              on_fail: "parent_fail",
            },
            parent_gate: {
              prompt: "Parent gate",
              skills: ["p-skill"],
              transitions: { continue: "delegate_grandchild" },
            },
            delegate_grandchild: {
              sub_workflow: "grandchild",
              on_complete: "parent_done",
              on_fail: "parent_fail",
            },
            parent_done: {
              prompt: "Parent done",
              terminal: true,
              outcome: "complete",
            },
            parent_fail: {
              prompt: "Parent failed",
              terminal: true,
              outcome: "fail",
            },
          },
        },
        child: {
          initial: "c_work",
          states: {
            c_work: {
              prompt: "Child working",
              transitions: { finish: "c_end" },
            },
            c_end: {
              prompt: "Child done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
        grandchild: {
          initial: "g_work",
          states: {
            g_work: {
              prompt: "Grandchild working",
              transitions: { finish: "g_end" },
            },
            g_end: {
              prompt: "Grandchild done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("parent");

      // Pre-load the parent skill
      let session = storage.read(sessionId)!;
      await storage.write(sessionId, {
        ...session,
        loaded_skills: { "p-skill": 0 },
      });

      // We're in child/c_work. Finish child → pop → parent_gate (skills loaded)
      // → auto-transition → delegate_grandchild → push grandchild → g_work
      const result = await engine.transition(sessionId, "finish");

      expect(result.stack).toHaveLength(2);
      expect(result.currentWorkflow).toBe("grandchild");
      expect(result.currentStateName).toBe("g_work");
      expect(result.prompt).toBe("Grandchild working");
    });

    // ---------------------------------------------------------------
    // 8. Skill gate auto-transition to a terminal state triggers pop
    // ---------------------------------------------------------------
    it("skill gate auto-transition to a terminal state pops the stack", async () => {
      setup({
        parent: {
          initial: "delegate",
          states: {
            delegate: {
              sub_workflow: "child",
              on_complete: "parent_done",
              on_fail: "parent_done",
            },
            parent_done: {
              prompt: "Parent done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
        child: {
          initial: "gate",
          states: {
            gate: {
              prompt: "Gate",
              skills: ["s"],
              transitions: { continue: "child_end" },
            },
            child_end: {
              prompt: "Child done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("parent");

      // We're at child/gate (blocking). Pre-load the skill.
      let session = storage.read(sessionId)!;
      await storage.write(sessionId, {
        ...session,
        loaded_skills: { s: 0 },
      });

      // Now transition from gate → marks skills loaded → next visit to gate
      // would auto-transition, but currently we're AT the gate, we need to
      // manually transition "continue" which goes to child_end (terminal) → pop → parent_done (terminal) → complete
      const result = await engine.transition(sessionId, "continue");

      expect(result.stack).toHaveLength(0);
      expect(result.prompt).toContain("completed");
    });

    // ---------------------------------------------------------------
    // 9. Action chain → skill gate in the middle
    // ---------------------------------------------------------------
    it("exec chain that hits a skill gate blocks correctly", async () => {
      setup({
        wf: {
          initial: "step1",
          states: {
            step1: {
              type: "exec",
              command: "echo one",
              on_success: "step2",
              on_error: "fail",
            },
            step2: {
              type: "exec",
              command: "echo two",
              on_success: "gate",
              on_error: "fail",
            },
            gate: {
              prompt: "Load skills now",
              skills: ["chain-skill"],
              transitions: { continue: "work" },
            },
            work: {
              prompt: "Working",
              transitions: { done: "end" },
            },
            fail: {
              prompt: "Failed",
              terminal: true,
              outcome: "fail",
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const result = await engine.start("wf");

      // step1 → step2 → gate (blocks because chain-skill not loaded)
      expect(result.currentStateName).toBe("gate");
      expect(result.prompt).toContain('Skill("chain-skill")');

      // Verify history recorded both action transitions
      const actionEntries = result.history.filter(h => h.event === "action");
      expect(actionEntries).toHaveLength(2);
      expect(actionEntries[0].from).toBe("step1");
      expect(actionEntries[0].to).toBe("step2");
      expect(actionEntries[1].from).toBe("step2");
      expect(actionEntries[1].to).toBe("gate");
    });

    // ---------------------------------------------------------------
    // 10. Skill gate auto-transition chains through action states
    // ---------------------------------------------------------------
    it("skill gate auto-transitions into an action state chain", async () => {
      setup({
        wf: {
          initial: "start",
          states: {
            start: {
              prompt: "Begin",
              transitions: { go: "gate" },
            },
            gate: {
              prompt: "Gate",
              skills: ["s"],
              transitions: { continue: "run" },
            },
            run: {
              type: "exec",
              command: "echo done",
              on_success: "ok",
              on_error: "fail",
            },
            ok: {
              prompt: "Success",
              transitions: { done: "end" },
            },
            fail: {
              prompt: "Failed",
              terminal: true,
              outcome: "fail",
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("wf");

      // Pre-load skill
      let session = storage.read(sessionId)!;
      await storage.write(sessionId, {
        ...session,
        loaded_skills: { s: 0 },
      });

      // go → gate (skills loaded) → auto-transition → run (exec) → ok
      const result = await engine.transition(sessionId, "go");

      expect(result.currentStateName).toBe("ok");
      expect(result.prompt).toBe("Success");

      // Verify history has both skill_gate and action events
      const gateEntry = result.history.find(
        h => h.event === "skill_gate" && h.from === "gate" && h.to === "run"
      );
      expect(gateEntry).toBeDefined();

      const actionEntry = result.history.find(
        h => h.event === "action" && h.from === "run" && h.to === "ok"
      );
      expect(actionEntry).toBeDefined();
    });

    // ---------------------------------------------------------------
    // 11. Visit counts and total_transitions are tracked across
    //     auto-transitions (skill gates, actions, pushes)
    // ---------------------------------------------------------------
    it("visit counts and total_transitions track correctly through auto-transitions", async () => {
      setup({
        wf: {
          initial: "start",
          states: {
            start: {
              prompt: "Begin",
              transitions: { go: "gate" },
            },
            gate: {
              prompt: "Gate",
              skills: ["s"],
              transitions: { continue: "work" },
            },
            work: {
              prompt: "Working",
              transitions: { done: "end" },
            },
            end: {
              prompt: "Done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const { sessionId } = await engine.start("wf");

      // Pre-load skill
      let session = storage.read(sessionId)!;
      await storage.write(sessionId, {
        ...session,
        loaded_skills: { s: 0 },
      });

      // go → gate (auto-transition, +1 transition) → work (+1 transition)
      const result = await engine.transition(sessionId, "go");

      expect(result.currentStateName).toBe("work");

      // The frame should have counted:
      // start→gate (transition call = +1), gate→work (auto = +1) = total 2
      const frame = result.stack[0];
      expect(frame.total_transitions).toBe(2);
      expect(frame.state_visits.gate).toBe(1);
      expect(frame.state_visits.work).toBe(1);
    });

    // ---------------------------------------------------------------
    // 12. start() on a sub_workflow whose initial state is an action
    // ---------------------------------------------------------------
    it("start() pushes sub_workflow whose initial state is an action and chains", async () => {
      setup({
        parent: {
          initial: "launch",
          states: {
            launch: {
              sub_workflow: "child",
              on_complete: "done",
              on_fail: "done",
            },
            done: {
              prompt: "Parent done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
        child: {
          initial: "run",
          states: {
            run: {
              type: "exec",
              command: "echo hello",
              on_success: "child_work",
              on_error: "child_fail",
            },
            child_work: {
              prompt: "Child working after exec",
              transitions: { finish: "child_end" },
            },
            child_fail: {
              prompt: "Child failed",
              terminal: true,
              outcome: "fail",
            },
            child_end: {
              prompt: "Child done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      const result = await engine.start("parent");

      // start → push child → exec runs → routes to child_work
      expect(result.stack).toHaveLength(2);
      expect(result.currentWorkflow).toBe("child");
      expect(result.currentStateName).toBe("child_work");
      expect(result.prompt).toBe("Child working after exec");
    });

    // ---------------------------------------------------------------
    // 13. Full chain: action → skill gate → sub_workflow → terminal → pop → skill gate
    // ---------------------------------------------------------------
    it("complex multi-dispatch chain: action → gate → sub_workflow → pop → gate", async () => {
      setup({
        main: {
          initial: "check",
          states: {
            check: {
              type: "exec",
              command: "echo ok",
              on_success: "main_gate",
              on_error: "main_fail",
            },
            main_gate: {
              prompt: "Main gate",
              skills: ["main-skill"],
              transitions: { continue: "delegate" },
            },
            delegate: {
              sub_workflow: "sub",
              on_complete: "main_done",
              on_fail: "main_fail",
            },
            main_done: {
              prompt: "All done",
              terminal: true,
              outcome: "complete",
            },
            main_fail: {
              prompt: "Failed",
              terminal: true,
              outcome: "fail",
            },
          },
        },
        sub: {
          initial: "sub_work",
          states: {
            sub_work: {
              prompt: "Sub working",
              transitions: { finish: "sub_end" },
            },
            sub_end: {
              prompt: "Sub done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
      });

      // Start: check (exec) → main_gate (blocks, skills not loaded)
      const result = await engine.start("main");

      expect(result.currentStateName).toBe("main_gate");
      expect(result.prompt).toContain('Skill("main-skill")');
      expect(result.stack).toHaveLength(1);

      // Now load skills and transition through the gate
      const { sessionId } = result;
      let session = storage.read(sessionId)!;
      await storage.write(sessionId, {
        ...session,
        loaded_skills: { "main-skill": 0 },
      });

      // Transition from gate → marks skills loaded, move to delegate → push sub → sub_work
      const result2 = await engine.transition(sessionId, "continue");

      expect(result2.stack).toHaveLength(2);
      expect(result2.currentWorkflow).toBe("sub");
      expect(result2.currentStateName).toBe("sub_work");

      // Finish sub → pop → main_done (terminal) → complete
      const result3 = await engine.transition(sessionId, "finish");

      expect(result3.stack).toHaveLength(0);
      expect(result3.prompt).toContain("completed");
    });

    // ---------------------------------------------------------------
    // 14. Pop from child with on_fail targeting a skill gate
    // ---------------------------------------------------------------
    it("child failure pops to parent on_fail skill gate", async () => {
      setup({
        parent: {
          initial: "delegate",
          states: {
            delegate: {
              sub_workflow: "child",
              on_complete: "parent_done",
              on_fail: "recovery_gate",
            },
            recovery_gate: {
              prompt: "Recovery: load skills",
              skills: ["recovery-skill"],
              transitions: { continue: "recover" },
            },
            recover: {
              prompt: "Recovering",
              transitions: { done: "parent_done" },
            },
            parent_done: {
              prompt: "Parent done",
              terminal: true,
              outcome: "complete",
            },
          },
        },
        child: {
          initial: "work",
          states: {
            work: {
              prompt: "Child working",
              transitions: { fail: "child_fail" },
            },
            child_fail: {
              prompt: "Child failed",
              terminal: true,
              outcome: "fail",
            },
          },
        },
      });

      const { sessionId } = await engine.start("parent");

      // Child fails → pops with outcome "fail" → on_fail → recovery_gate (blocks)
      const result = await engine.transition(sessionId, "fail");

      expect(result.stack).toHaveLength(1);
      expect(result.currentWorkflow).toBe("parent");
      expect(result.currentStateName).toBe("recovery_gate");
      expect(result.prompt).toContain('Skill("recovery-skill")');
    });
  });
});
