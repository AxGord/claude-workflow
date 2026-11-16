import { reactive } from "vue";
import type { ReplayFile } from "../../../src/replay";

// The scene's one clock: the map player writes it, the terminal pane reads it, so the two stay in sync.
export const shared = reactive<{ file: ReplayFile | null; at: number }>({ file: null, at: 0 });
