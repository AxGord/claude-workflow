import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const root = resolve(__dirname, "..");
const read = (file: string): string => readFileSync(resolve(root, file), "utf8");
const frontmatter = (file: string): Record<string, string> => {
  const m = /^---\n([\s\S]*?)\n---\n/u.exec(read(file));
  expect(m).not.toBeNull();
  return yaml.parse(m![1]) as Record<string, string>;
};
const driverTools = (): string[] =>
  frontmatter("agents/driver.md")
    .tools.split(",")
    .map(t => t.trim());
const WF = "mcp__plugin_workflow_wf__";

describe("the shipped driver runs at medium effort", () => {
  it("agents/driver.md frontmatter", () => {
    const fm = frontmatter("agents/driver.md");
    expect(fm.model).toBe("haiku");
    expect(fm.effort).toBe("medium");
  });

  it("bundled batch-task's driver: block", () => {
    const wf = yaml.parse(read("templates/batch-task.yaml")) as {
      driver: { model: string; effort: string };
    };
    expect(wf.driver).toMatchObject({ model: "haiku", effort: "medium" });
  });
});

describe("the shipped driver's tool list", () => {
  it("cannot end, delete, create or rewrite a session, nor change a priority", () => {
    const tools = driverTools();
    for (const name of ["abort", "delete", "create", "modify", "resume", "set_priority"]) {
      expect(tools).not.toContain(WF + name);
    }
  });

  it("keeps every workflow tool a driver prompt calls", () => {
    const tools = driverTools();
    const prompts = read("templates/batch-task.yaml") + read("templates/drivers/task-driver.md");
    for (const name of [
      "start",
      "status",
      "transition",
      "context_set",
      "link_agent",
      "queue_mark",
    ]) {
      expect(prompts).toMatch(new RegExp(`\\b${name}\\b`, "u"));
      expect(tools).toContain(WF + name);
    }
    expect(tools).toContain(`${WF}queue_edit`);
    for (const t of ["Agent", "SendMessage", "Read", "ToolSearch", "SubagentHandback"]) {
      expect(tools).toContain(t);
    }
  });
});
