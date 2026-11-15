// A project's own engine settings: `.claude/workflows/settings.json` at its root (a worktree
// counts as its main checkout, like the queue and the pool's project). One key so far.
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { projectRoot } from "./pool.js";
import { PriorityLevelSchema, type PriorityLevel } from "./types.js";

export const PROJECT_SETTINGS_FILE = "settings.json";

const ProjectSettingsSchema = z.strictObject({
  /** The level of a session or a bare `wf-run` in the project that names no priority and has no parent. */
  priority: PriorityLevelSchema.optional(),
});

/** The settings file of the project `cwd` belongs to. */
export function projectSettingsPath(cwd: string): string {
  return path.join(projectRoot(cwd), ".claude", "workflows", PROJECT_SETTINGS_FILE);
}

/**
 * The project's default priority level, or undefined when it has no settings file or the file
 * names none. A file that is not JSON, names an unknown key or a level outside
 * low/normal/high/urgent throws: a silently ignored typo would run every task at the wrong level.
 */
export function projectDefaultPriority(cwd: string): PriorityLevel | undefined {
  const file = projectSettingsPath(cwd);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`${file}: ${(err as Error).message}`);
  }
  try {
    return ProjectSettingsSchema.parse(JSON.parse(text)).priority;
  } catch (err) {
    const why =
      err instanceof z.ZodError
        ? err.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
        : (err as Error).message;
    throw new Error(`${file}: ${why}`, { cause: err });
  }
}
