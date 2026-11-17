import { reactive } from "vue";
import { advance, DEFAULT_SPEED, type ReplayFile } from "../../../src/replay";

// The scene's one clock: the transport bar under the stage drives it, the map and the terminal window read it,
// so the two panes are always at the same moment of the replay.
export const shared = reactive<{
  file: ReplayFile | null;
  at: number;
  duration: number;
  playing: boolean;
  speed: number;
  /** whether the Claude Code window is drawn over the map (the `T` key and the transport's button flip it) */
  terminal: boolean;
  /** whether the window fills the whole stage (its green button, a double-click on its title bar); only a shown window is zoomed */
  zoom: boolean;
}>({ file: null, at: 0, duration: 0, playing: false, speed: DEFAULT_SPEED, terminal: true, zoom: false });

/** Show or hide the Claude Code window: the one switch the pill, the `T` key and the window's close and minimise buttons share. A hidden window is not zoomed. */
export function setTerminal(on: boolean): void {
  shared.terminal = on;
  if (!on) shared.zoom = false;
}

/** Zoom the window to fill the stage, or back to its place. */
export function toggleZoom(): void {
  shared.zoom = !shared.zoom;
}

let raf = 0;
let last = 0;

function frame(now: number): void {
  if (!shared.playing) return;
  const clock = advance(shared.at, last === 0 ? 0 : now - last, shared.speed, shared.duration);
  last = now;
  shared.at = clock.at;
  if (clock.ended) shared.playing = false;
  else raf = requestAnimationFrame(frame);
}

export function play(): void {
  if (!shared.file) return;
  if (shared.at >= shared.duration) shared.at = 0;
  shared.playing = true;
  last = 0;
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(frame);
}

export function pause(): void {
  shared.playing = false;
  cancelAnimationFrame(raf);
}

export function toggle(): void {
  if (shared.playing) pause();
  else play();
}

/** A jump of the position (the scrub, the recorder's hook): the clock goes on from there when it plays. */
export function seekTo(ms: number): void {
  shared.at = Math.max(0, Math.min(shared.duration, ms));
  last = 0;
}

export function load(file: ReplayFile): void {
  shared.file = file;
  shared.duration = file.durationMs;
  shared.at = 0;
}
