// The engine's hand-edited configs are YAML (pool `config.yaml`, `pool-gate.yaml`,
// `read-only-commands.yaml`): one parser for them, and the warning for a JSON one left behind.
import fs from "node:fs";
import YAML from "yaml";

/** A YAML text's value; an empty or comments-only text is `{}`; a syntax error is one line. */
export function parseYaml(text: string): unknown {
  try {
    return (YAML.parse(text) as unknown) ?? {};
  } catch (err) {
    throw new Error(`not YAML: ${(err as Error).message.split("\n")[0]}`);
  }
}

// Files already warned about by this process: the warning is one line, not one per read.
const warned = new Set<string>();

/**
 * One stderr line when `yamlFile` is absent but its `.json` twin is there: the engine reads YAML
 * only, so that config is ignored until converted. True when it warned (now or before).
 */
export function warnLeftoverJson(yamlFile: string): boolean {
  const json = yamlFile.replace(/\.yaml$/, ".json");
  if (json === yamlFile || fs.existsSync(yamlFile) || !fs.existsSync(json)) return false;
  if (!warned.has(json)) {
    warned.add(json);
    process.stderr.write(
      `workflow: ${json} is ignored (configs are YAML now): wf-queue --convert ${json} --into ${yamlFile}\n`,
    );
  }
  return true;
}
