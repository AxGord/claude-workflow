import tokens from "../../../dashboard/tokens.css?raw";
import components from "../../../dashboard/components.css?raw";
import { scopedTokens } from "./dash-tokens";

/** The class of an element that wears the dashboard's look: its tokens are declared on it and its rules reach only what is inside. */
export const DASH = "dash";

// The dashboard's own stylesheets, scoped: the tokens on the root, the rules inside an `@scope`, so nothing of
// the dashboard's page-wide rules (body, a, *) reach the site around it. The page's own theme switch and the
// system's colour preference have no say here: the demos follow VitePress's `html.dark` (its theme switch), so
// the light set sits on `.dash` and the dark set on `html.dark .dash`.
const STYLE_ID = "dashboard-css";
const css = `${scopedTokens(tokens, DASH)}\n@scope (.${DASH}) {\n${components}\n}`;

/** Puts the scoped stylesheet in the page's head, once. */
export function useDashboardCss(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = css;
  document.head.appendChild(style);
}
