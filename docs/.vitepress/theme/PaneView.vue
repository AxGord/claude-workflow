<script lang="ts">
// A tree of hooks/pane-view.ts (the plan pane's own drawing, shared with the mod) drawn in the DOM: a box is a
// flex box, a text a span with the terminal's colors, a button a clickable span that hands its action up, a link
// its label. This file draws primitives only; every row, glyph, color and section comes from the shared module.
import { defineComponent, h, type PropType, type VNode } from "vue";
import type { PaneAction, PaneEl, PaneNode } from "../../../hooks/pane-view";

/** A color of the tree is a theme key of Claude Code (`TONE` of hooks/pane-view.ts): the stylesheet below gives each key a
 *  value per terminal ground, so the same tree draws on a dark and on a light terminal. Anything else (`#rrggbb`) is kept. */
const colorOf = (c: string): string => (/^[A-Za-z]+$/.test(c) ? `var(--tc-${c})` : c);

export default defineComponent({
  name: "PaneView",
  props: { node: { type: [Object, Array, String, null] as PropType<PaneNode>, default: null } },
  emits: { act: (_a: PaneAction) => true },
  setup(props, { emit }) {
    const draw = (n: PaneNode): (VNode | string)[] => {
      if (n === null) return [];
      if (typeof n === "string") return [n];
      if (Array.isArray(n)) return (n as readonly PaneNode[]).flatMap(draw);
      const el = n as PaneEl;
      const kids = (): (VNode | string)[] => (el.el === "link" ? [] : el.children.flatMap(draw));
      switch (el.el) {
        case "link":
          return [h("span", { class: "pv-link", title: el.href }, el.label)];
        case "text": {
          const { color, dimColor, weight } = el.props;
          const style: Record<string, string> = {};
          if (color !== undefined) style.color = colorOf(color);
          if (dimColor) style[color === undefined ? "color" : "opacity"] = color === undefined ? "var(--pv-dim)" : "0.65";
          if (weight === "bold") style.fontWeight = "700";
          return [h("span", { style }, kids())];
        }
        case "box": {
          const row = el.props.flexDirection !== "column";
          const gap = el.props.gap ?? 0;
          return [
            h(
              "div",
              { key: el.key, class: "pv-box", style: { flexDirection: row ? "row" : "column", gap: gap > 0 ? `${gap}ch` : undefined } },
              kids(),
            ),
          ];
        }
        case "button":
          return [h("span", { key: el.key, class: "pv-btn", role: "button", onClick: () => emit("act", el.action) }, kids())];
      }
    };
    return () => h("div", { class: "pv" }, draw(props.node));
  },
});
</script>

<style>
/* the dark terminal's palette; a terminal that follows the site's light theme (`term-follows-site`) redefines it below.
   One `--tc-<theme key>` per value of `TONE` (hooks/pane-view.ts), pinned by src/site-terminal-light.test.ts */
.pv {
  --pv-dim: #7d8590;
  --pv-link: #b1b9f9;
  --pv-hover: rgba(255, 255, 255, 0.06);
  --tc-success: #4eba65;
  --tc-error: #ff6b80;
  --tc-warning: #ffc107;
  --tc-suggestion: #b1b9f9;
  --tc-claude: #d77757;
  --tc-inactive: #999999;
  --tc-remember: #b1b9f9;
  --tc-autoAccept: #af87ff;
  display: flex;
  flex-direction: column;
  white-space: pre;
  min-width: 0;
}
html:not(.dark) .term-follows-site .pv {
  --pv-dim: #6e7781;
  --pv-link: #5769f7;
  --pv-hover: rgba(0, 0, 0, 0.06);
  --tc-success: #2c7a39;
  --tc-error: #ab2b3f;
  --tc-warning: #966c1e;
  --tc-suggestion: #5769f7;
  --tc-claude: #d77757;
  --tc-inactive: #666666;
  --tc-remember: #0000ff;
  --tc-autoAccept: #8700ff;
}
.pv-box {
  display: flex;
  min-width: 0;
}
.pv-btn {
  cursor: pointer;
}
.pv-btn:hover {
  background: var(--pv-hover);
}
.pv-link {
  color: var(--pv-link);
  text-decoration: underline;
}
</style>
