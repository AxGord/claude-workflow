import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Loader } from "./loader.js";
import { describeWorkflows, renderWorkflows } from "./workflow-describe.js";
/** The file the documentation site's landing draws its workflow graphs from, relative to the repository root. */
export const SITE_WORKFLOWS_FILE = path.join("docs", "public", "workflows.json");
/**
 * Writes the site's `workflows.json` from the bundled templates of the checkout at `root`, as the
 * engine's own Loader reads them (only that tier: an empty directory stands in for the machine's
 * global one). It is a build product, never committed: `npm run docs:build` writes it before the
 * site is built, and the test run writes it (`src/site-workflows-setup.ts`), so it cannot go stale.
 */
export function writeSiteWorkflows(root) {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "wf-site-workflows-"));
    try {
        const loader = new Loader(path.join(root, "templates"), empty, null);
        const text = renderWorkflows(describeWorkflows(loader.getAll()));
        const file = path.join(root, SITE_WORKFLOWS_FILE);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // atomic: a test file reading the export while another run's setup rewrites it never sees a cut one
        const part = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(part, text);
        fs.renameSync(part, file);
        return { file, text, count: loader.getAll().size };
    }
    finally {
        fs.rmSync(empty, { recursive: true, force: true });
    }
}
