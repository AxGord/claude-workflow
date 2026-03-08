const TEMPLATE_RE = /\{\{([a-zA-Z0-9_.]+)\}\}/g;

function resolve(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function render(template: string, vars: Record<string, unknown>): string {
  return template.replace(TEMPLATE_RE, (_match, path: string) => {
    const val = resolve(vars, path);
    if (val === undefined || val === null) return "";
    if (typeof val === "object") return JSON.stringify(val);
    return String(val);
  });
}
