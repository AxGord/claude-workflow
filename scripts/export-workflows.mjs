#!/usr/bin/env node
// Exports the workflow definitions the documentation site's landing page draws: every bundled template
// (templates/*.yaml, through the engine's own Loader) as `/api/workflows` describes it, into
// docs/public/workflows.json. The page lays them out with dashboard/graph.js, the code the dashboard draws with,
// so a click on a state shows what the dashboard shows. Run it after a template changes:
//
//   npm run build && npm run docs:workflows
//
// src/site-live-graphs.test.ts fails while the file is not what this script writes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(name) {
  const file = path.join(root, "build", name);
  if (!fs.existsSync(file)) throw new Error(`build/${name} is missing: run \`npm run build\` first`);
  return import(pathToFileURL(file).href);
}

async function main() {
  const { describeWorkflows, renderWorkflows } = await load("workflow-describe.js");
  const { Loader } = await load("loader.js");
  // only the bundled tier: an empty global directory stands in for the machine's own
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wf-site-workflows-"));
  const out = path.join(root, "docs", "public", "workflows.json");
  try {
    const loader = new Loader(path.join(root, "templates"), empty, null);
    const text = renderWorkflows(describeWorkflows(loader.getAll()));
    fs.writeFileSync(out, text);
    console.log(`${path.relative(process.cwd(), out)}: ${(Buffer.byteLength(text) / 1000).toFixed(1)} KB, ${loader.getAll().size} workflows`);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(`export-workflows: ${err.message}`);
  process.exit(1);
});
