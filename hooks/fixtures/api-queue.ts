// Recorded /api/queue answer (src/dashboard.test.ts checks it; WF_RECORD_REPLIES=1 re-records).
export const API_QUEUE = {
  "file": "/proj/.claude/batch/queue.yaml",
  "batchSize": 2,
  "lines": [
    {
      "id": "RUN-1",
      "status": "running",
      "difficulty": "7",
      "touches": "r",
      "exclusive": false,
      "paused": false,
      "notes": 0,
      "text": "r"
    },
    {
      "id": "NEXT-1",
      "status": "pending",
      "difficulty": "3",
      "touches": "n",
      "exclusive": false,
      "paused": false,
      "notes": 0,
      "text": "n",
      "reason": "ready"
    },
    {
      "id": "WAIT-1",
      "status": "pending",
      "difficulty": "5",
      "after": "NEXT-1",
      "touches": "w",
      "exclusive": false,
      "paused": false,
      "notes": 0,
      "text": "w",
      "reason": "after: NEXT-1 (pending)"
    },
    {
      "id": "PARK-1",
      "status": "pending",
      "touches": "p",
      "exclusive": false,
      "paused": true,
      "notes": 0,
      "text": "p",
      "reason": "parked"
    },
    {
      "id": "DONE-1",
      "status": "done",
      "exclusive": false,
      "paused": false,
      "notes": 1,
      "lastNoteDate": "2026-11-07",
      "text": "d"
    }
  ]
};
