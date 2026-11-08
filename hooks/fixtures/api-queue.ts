// Recorded /api/queue answer (src/dashboard.test.ts checks it; WF_RECORD_REPLIES=1 re-records).
export const API_QUEUE = {
  "file": "/proj/.claude/batch/queue.yaml",
  "batchSize": 2,
  "lines": [
    {
      "id": "RUN-1",
      "afterIds": [],
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
      "afterIds": [],
      "status": "pending",
      "difficulty": "3",
      "touches": "n",
      "exclusive": false,
      "paused": false,
      "notes": 0,
      "text": "n",
      "reason": "ready",
      "pickOrder": 1
    },
    {
      "id": "NEXT-2",
      "afterIds": [],
      "status": "pending",
      "difficulty": "2",
      "touches": "n2",
      "exclusive": false,
      "paused": false,
      "notes": 0,
      "text": "n2",
      "reason": "ready",
      "pickOrder": 0,
      "priority": "high"
    },
    {
      "id": "WAIT-1",
      "afterIds": [
        "NEXT-1"
      ],
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
      "afterIds": [],
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
      "afterIds": [],
      "status": "done",
      "exclusive": false,
      "paused": false,
      "notes": 1,
      "lastNoteDate": "2026-11-07",
      "lastNote": "landed abc",
      "text": "d"
    },
    {
      "id": "FAIL-LONG",
      "afterIds": [],
      "status": "failed",
      "exclusive": false,
      "paused": false,
      "notes": 1,
      "lastNoteDate": "2026-11-08",
      "lastNote": "a reason that runs on and on well past the width of any plan pane a person would open beside the chat",
      "text": "f4"
    },
    {
      "id": "FAIL-OLD",
      "afterIds": [],
      "status": "failed",
      "difficulty": "4",
      "exclusive": false,
      "paused": false,
      "notes": 1,
      "lastNoteDate": "2026-11-06",
      "lastNote": "gate red: the suite",
      "text": "f"
    },
    {
      "id": "FAIL-NEW",
      "afterIds": [],
      "status": "failed",
      "exclusive": false,
      "paused": false,
      "notes": 1,
      "lastNoteDate": "2026-11-07",
      "lastNote": "closed as a split",
      "text": "f2"
    },
    {
      "id": "FAIL-BARE",
      "afterIds": [],
      "status": "failed",
      "exclusive": false,
      "paused": false,
      "notes": 0,
      "text": "f3"
    }
  ]
};
