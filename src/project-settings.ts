// A project's own engine settings: `.claude/workflows/settings.json` at its root (a worktree
// counts as its main checkout, like the queue and the pool's project). Keys: `priority`,
// `memory_write_gate`.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { projectRoot } from "./pool.js";
import { PriorityLevelSchema, type PriorityLevel } from "./types.js";

export const PROJECT_SETTINGS_FILE = "settings.json";

/** How the knowledge write gate answers a new memory file with no `why-memory:` line. */
export const MemoryWriteGateSchema = z.enum(["deny", "ask"]);
export type MemoryWriteGateMode = z.infer<typeof MemoryWriteGateSchema>;

const ProjectSettingsSchema = z.strictObject({
  /** The level of a session or a bare `wf-run` in the project that names no priority and has no parent. */
  priority: PriorityLevelSchema.optional(),
  /** Opt-in: absent = the gate is off and the project's memory writes are nobody's business. */
  memory_write_gate: MemoryWriteGateSchema.optional(),
});
type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

/** The settings file of the project `cwd` belongs to. */
export function projectSettingsPath(cwd: string): string {
  return path.join(projectRoot(cwd), ".claude", "workflows", PROJECT_SETTINGS_FILE);
}

/**
 * The project's settings, `{}` when it has no settings file. A file that is not JSON, names an
 * unknown key or a value outside its key's words throws: a silently ignored typo would run every
 * task at the wrong level, or leave a gate off.
 */
function readProjectSettings(cwd: string): ProjectSettings {
  const file = projectSettingsPath(cwd);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`${file}: ${(err as Error).message}`);
  }
  try {
    return ProjectSettingsSchema.parse(JSON.parse(text));
  } catch (err) {
    const why =
      err instanceof z.ZodError
        ? err.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
        : (err as Error).message;
    throw new Error(`${file}: ${why}`, { cause: err });
  }
}

/** The project's default priority level, or undefined when the file names none. */
export function projectDefaultPriority(cwd: string): PriorityLevel | undefined {
  return readProjectSettings(cwd).priority;
}

/** The project's `memory_write_gate` mode, or undefined (the gate is off) when the file names none. */
export function projectMemoryWriteGate(cwd: string): MemoryWriteGateMode | undefined {
  return readProjectSettings(cwd).memory_write_gate;
}
