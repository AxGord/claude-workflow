import path from "node:path";
import { fileURLToPath } from "node:url";
import { withBuildLock } from "./site-browser-helpers.js";
import { writeSiteWorkflows } from "./site-workflows.js";

/**
 * Writes the export when no docs build is running: VitePress copies `docs/public` while it builds,
 * and a temporary file of this write that is renamed away in that moment fails the build, so the
 * write takes the build lock the builds take.
 */
export function writeWhenNoBuild(root: string, lock?: string): Promise<void> {
  return withBuildLock(() => {
    writeSiteWorkflows(root);
  }, lock);
}

/** Vitest's global setup: the site's workflow export is a build product, so every test run writes it fresh. */
export default function setup(): Promise<void> {
  return writeWhenNoBuild(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
}
