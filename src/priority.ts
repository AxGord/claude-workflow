// The queue's priority words, in rank order. A leaf module so the curator config can name them without importing the queue.
export const PRIORITIES = ["urgent", "high", "normal", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];
