# Decisions

Append only: one line per refuted hypothesis, `what → why not → slice id`, at most 300 characters. Search with `grep -n`, never rewrite a line.

Claude Code/limit fault put a worker in the driver slot (seq 3484) -> refuted: the driver itself called link_agent(P, worker) 1h47m before the limit, as task-driver.md says, and the engine keeps the last linked id as the session agent → ENG-REVISIT-WORKER-LIVENESS

native Workflow is a script that only starts agents, with no MCP and a run lost with its session: refuted in part, agents in a script reach session MCP tools, and a run resumes after claude --resume by relaunch (2.1.331 docs) → ENG-NATIVE-WORKFLOW-POSITIONING

Agent panel detach needs no resume: a worker still running about 30 s after its spawner's run and its own background work ended is drawn top-level (seen live, claude 2.1.331); a spawner parked on a live child with no own background work stays untested → ENG-DETACH-LIVE-REPRO

Panel-detach theory (a resume detaches a worker) built no engine, template or workflow rule: the fresh-worker-outside-the-tree proposal was never implemented; WAKES-DRIVER-ONLY, LINK-AGENT-ROLE and the resume choice rest on routing, cost and labels; keep → ENG-DETACH-WORKAROUND-AUDIT
