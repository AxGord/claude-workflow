import tokens from "../../../dashboard/tokens.css?raw";
import components from "../../../dashboard/components.css?raw";

/** The class of an element that wears the dashboard's look: its tokens are declared on it and its rules reach only what is inside. */
export const DASH = "dash";

// The dashboard's own stylesheets, scoped: the tokens on the root, the rules inside an `@scope`, so nothing of
// the dashboard's page-wide rules (body, a, *) reaches the site around it.
const STYLE_ID = "dashboard-css";
const css = `${tokens.replace(/^:root\s*\{/m, `.${DASH} {`)}\n@scope (.${DASH}) {\n${components}\n}`;

/** Puts the scoped stylesheet in the page's head, once. */
export function useDashboardCss(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}
