import { computeStations } from "./stations.js";
/** The definitions the dashboard draws (`dashboard/graph.js`): the one owner of the shape the REST endpoint and the site's export share. */
export function describeWorkflows(workflows) {
    const result = {};
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
export function renderWorkflows(descriptions) {
    const sorted = {};
    for (const name of Object.keys(descriptions).sort())
        sorted[name] = descriptions[name];
    return JSON.stringify(sorted) + "\n";
}
