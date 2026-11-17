#!/usr/bin/env node
// Writes the workflow definitions the documentation site's landing page draws: every bundled template
// (templates/*.yaml, through the engine's own Loader) as `/api/workflows` describes it, into
// docs/public/workflows.json. The page lays them out with dashboard/graph.js, the code the dashboard draws with,
// so a click on a state shows what the dashboard shows. The file is a build product: git-ignored, written by
// `npm run docs:build` / `docs:dev` / `docs:preview` (through `docs:prepare`) and by every test run
// (src/site-workflows-setup.ts), so it never goes stale. By hand:
//
//   npm run build && npm run docs:workflows
//
// The writer is `writeSiteWorkflows` (src/site-workflows.ts), the one the test run uses too.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

async function load(name) {
  const file = path.join(root, "build", name);
  if (!fs.existsSync(file)) throw new Error(`build/${name} is missing: run \`npm run build\` first`);
  return import(pathToFileURL(file).href);
}

async function main() {
  const { writeSiteWorkflows } = await load("site-workflows.js");
  const { file, text, count } = writeSiteWorkflows(root);
  console.log(`${path.relative(process.cwd(), file)}: ${(Buffer.byteLength(text) / 1000).toFixed(1)} KB, ${count} workflows`);
}

main().catch(err => {
  console.error(`export-workflows: ${err.message}`);
  process.exit(1);
});
