// Recorded engine replies (src/tools.test.ts checks them; WF_RECORD_REPLIES=1 re-records).
export const START_REPLY = "SESSION: SID\npipe @ plan\n\nPlan it\n\nTRANSITIONS: go\n\n---\nWORKFLOW RULES:\n- Transitions in real-time only — never batch multiple transitions in one step.\n- Complete each state fully before transitioning to the next.\n- On tool errors: stop and investigate before continuing.\n- To advance: transition({ transition: \"<name>\" })\n---";
export const TRANSITION_REPLY = "pipe @ work\n\nWork\n\nTRANSITIONS: done";
