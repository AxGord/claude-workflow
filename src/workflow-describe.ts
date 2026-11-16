import { computeStations, type Station } from "./stations.js";
import type { WorkflowDefinition } from "./types.js";

/** A workflow as `/api/workflows` and the documentation site's `docs/public/workflows.json` carry it. */
export interface WorkflowDescription {
  readonly name: string;
  readonly description: WorkflowDefinition["description"];
  readonly initial: string;
  readonly max_transitions: WorkflowDefinition["max_transitions"];
  readonly states: WorkflowDefinition["states"];
  readonly stations: readonly Station[];
  readonly map?: false;
  readonly driver?: { readonly model: string | undefined; readonly effort: string | undefined };
}

/** The definitions the dashboard draws (`dashboard/graph.js`): the one owner of the shape the REST endpoint and the site's export share. */
export function describeWorkflows(
  workflows: Iterable<readonly [string, WorkflowDefinition]>,
): Record<string, WorkflowDescription> {
  const result: Record<string, WorkflowDescription> = {};
  for (const [name, wf] of workflows) {
    result[name] = {
      name: wf.name,
      description: wf.description,
      initial: wf.initial,
      max_transitions: wf.max_transitions,
      states: wf.states,
      stations: computeStations(wf),
      ...(wf.map === false ? { map: false } : {}),
      ...(wf.driver ? { driver: { model: wf.driver.model, effort: wf.driver.effort } } : {}),
    };
  }
  return result;
}

/** The site's file: every workflow by name in name order, compact JSON, so the file is byte-stable and a test can compare it with a fresh export. */
export function renderWorkflows(descriptions: Record<string, WorkflowDescription>): string {
  const sorted: Record<string, WorkflowDescription> = {};
  for (const name of Object.keys(descriptions).sort()) sorted[name] = descriptions[name];
  return JSON.stringify(sorted) + "\n";
}
