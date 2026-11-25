# Decisions

Append only: one line per refuted hypothesis, `what → why not → slice id`, at most 300 characters. Search with `grep -n`, never rewrite a line.

Claude Code/limit fault put a worker in the driver slot (seq 3484) -> refuted: the driver itself called link_agent(P, worker) 1h47m before the limit, as task-driver.md says, and the engine keeps the last linked id as the session agent → ENG-REVISIT-WORKER-LIVENESS
