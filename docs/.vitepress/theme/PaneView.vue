<script lang="ts">
// A tree of hooks/pane-view.ts (the plan pane's own drawing, shared with the mod) drawn in the DOM: a box is a
// flex box, a text a span with the terminal's colors, a button a clickable span that hands its action up, a link
// its label. This file draws primitives only; every row, glyph, color and section comes from the shared module.
import { defineComponent, h, type PropType, type VNode } from "vue";
import type { PaneAction, PaneEl, PaneNode } from "../../../hooks/pane-view";

/** The terminal's named colors, as a dark terminal theme draws them. */
const COLORS: Record<string, string> = {
  black: "#3b4048",
  red: "#ff6b6b",
  green: "#4ec98a",
  yellow: "#e5c07b",
  blue: "#61a8ff",
  magenta: "#d38aea",
  cyan: "#4fc1d9",
  white: "#e6e6e6",
  gray: "#8b949e",
  grey: "#8b949e",
  cyanBright: "#7fe6ff",
  greenBright: "#7ee2a8",
  redBright: "#ff8f8f",
  yellowBright: "#ffe08a",
  blueBright: "#8cc2ff",
};
const colorOf = (c: string): string => COLORS[c] ?? c;

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
.pv {
  --pv-dim: #7d8590;
  display: flex;
  flex-direction: column;
  white-space: pre;
  min-width: 0;
}
.pv-box {
  display: flex;
  min-width: 0;
}
.pv-btn {
  cursor: pointer;
}
.pv-btn:hover {
  background: rgba(255, 255, 255, 0.06);
}
.pv-link {
  color: #4fc1d9;
  text-decoration: underline;
}
</style>
