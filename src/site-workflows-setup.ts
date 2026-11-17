import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeSiteWorkflows } from "./site-workflows.js";

/** Vitest's global setup: the site's workflow export is a build product, so every test run writes it fresh. */
export default function setup(): void {
  writeSiteWorkflows(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
}
