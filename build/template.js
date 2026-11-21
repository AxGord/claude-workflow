const TEMPLATE_RE = /\{\{([a-zA-Z0-9_.]+)\}\}/g;
function resolve(obj, path) {
    let cur = obj;
    for (const key of path.split(".")) {
        if (cur == null || typeof cur !== "object")
            return undefined;
        cur = cur[key];
    }
    return cur;
}
export function render(template, vars) {
    return template.replace(TEMPLATE_RE, (_match, path) => {
        const val = resolve(vars, path);
        if (val === undefined || val === null)
            return "";
        if (typeof val === "object")
            return JSON.stringify(val);
        return String(val);
    });
}
