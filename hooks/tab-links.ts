// The dashboard view each pane tab's header link opens. Kept apart from pane-view.ts (which is typed against the
// plugin's own types and not part of the engine's TypeScript program) so the engine's tests can pin the paths to
// `routePath` of src/dashboard-routes.ts without pulling the whole pane in. Pure and import-free.

/**
 * The path and label of the link under each tab (the pane's `View` ids). Waiting has no view of its own: its lines
 * are the Plan view's pending section, so it links there.
 */
export const TAB_LINKS = {
  plan: { path: '/plan', label: 'plan ↗' },
  sessions: { path: '/sessions', label: 'sessions ↗' },
  waiting: { path: '/plan', label: 'plan ↗' },
  pool: { path: '/pool', label: 'pool ↗' },
} as const
