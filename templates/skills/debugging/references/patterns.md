# debugging — Meta-patterns (full text)

Moved verbatim from SKILL.md; the index there names each lesson and when to open it.

## Same Defect in a THIRD Unit = Build a Roster Differential, Not a Third Point Fix

When the same mistake turns up in a third member of a family — three checks, three handlers, three adapters — the fix that pays is a test over the **registry**, not another test beside the fix. Site-by-site repair finds only the sites someone thought to look at, and it is silent about the fourth.

**DON'T:** Write one more targeted test next to the fix and call the class closed because the known sites are green.

**DO:** Build a differential over the enumeration the system already keeps: run ONE fixture twice, changing only the variable that distinguishes the wrong answer from the right one, and assert a SUBSET relation between the two runs. Nothing then has to predict what each unit should say — only that the change cannot take an answer away.

Three properties separate a class-catcher from a case-catcher:

- It iterates the **registry itself**, so a new unit joins by being registered. A hand-maintained list has the same blind spot as the fixes you are replacing.
- It asserts a **relation between two runs**, not an expected value. Expected values need per-unit knowledge you do not have and would have to keep current.
- Tolerated divergences live in an **explicit named constant**, not in a softened assertion — an accepted exception stays readable, and a new one fails loudly.

**Tell:** You are writing the third fix for one root cause, and each one needed someone to notice the site first.

**GOTCHA:** A differential over a roster is exactly the shape that passes by exercising nothing — most cells produce no output, the subset relation holds vacuously, and the harness is green on a broken tree. Give it a non-vacuity floor that counts what actually ran, and measure that floor: in one case only 5 of ~180 registered units produced a write in any cell. Validate the harness by REVERTING each already-known fix and confirming it fails; a harness that catches the sites you found by hand is the only evidence it would catch the ones you did not. (Real case: a proof asked a narrow scope instead of the wide one — four sites fixed one at a time across three rounds; the roster differential reproduced all four and, on its first run, found a fifth nobody had looked for, one whose autofix DELETED a member another file reached reflectively.)

## Repeated Same Symptom After 2+ Fixes = Wrong Subsystem Target

When the user reports the same perceived symptom after two or more rounds of plausible fixes, stop patching that surface. A symptom that survives multiple reasonable fixes is almost always at the **seam between two decoupled subsystems** — a baked/precomputed path vs. a live event; a cached value vs. its source; a predicted value vs. an independently-computed actual.

**DON'T:** Keep refining one side each iteration — shapes, easing, constants, thresholds — to match the user's latest wording.

**DO:** By the 2nd repeat, trace BOTH subsystems end-to-end and ask: "why do these two representations exist, and must they?" The fix is to make them **coincide** — re-derive one from the other at the authoritative moment — not to tune one side.

**Tell:** Every "fix" addresses the user's latest description verbatim, yet the user keeps saying "same thing / didn't help." You find yourself adjusting constants repeatedly with no lasting effect.

**GOTCHA:** The seam is invisible when you look at only one subsystem. You must trace both from their shared input to their diverging output paths to see the gap. (Real case: four rounds of tuning a precomputed trajectory failed because the actual hit was computed by a SEPARATE live simulation — the fix was re-deriving one from the other at start time, which no amount of trajectory tuning could achieve.)

## Regressing Feature? Find the Principled Algorithm the Codebase Already Has

When a feature keeps regressing across many patch cycles — tuning constants, reshaping curves, adjusting thresholds — stop inventing ad-hoc logic. Ask: **"what does correct behavior fundamentally require, and does this codebase already compute that for some other case?"**

**DON'T:** Keep hand-rolling case-specific heuristics to chase the latest symptom. Each variant is "more specific" than the last and never converges.

**DO:** Grep for the concept (clearance, retry, normalization, lift…). If a general implementation exists, find why the failing case is excluded from it — an early `return`, a zone guard, a capability flag. That exclusion is the smoking gun: someone already solved it generally, then deliberately opted out the hard case. Mirror or apply that proven algorithm to the excluded case, using its same constants for parity. Ask the "do we already do it elsewhere?" question by the **2nd** regression, not the 6th.

**Tell:** You're writing the Nth variant of the same code path and each fix is narrower than the last. A sibling module has a richer version of the same routine that the failing path doesn't call.

**GOTCHA:** The exclusion guard often looks load-bearing. Verify it with the principled algorithm before assuming it's correct — it may just be an early simplification that was never revisited.

## "Impossible in the Limit" ≠ "Cheap Lever Fails the Actual Case"

When a global constant's effect scales with a per-case input, no single value can satisfy ALL inputs — that proof is correct. But it does NOT establish that the constant fails the specific case in front of you.

**DON'T:** Write an elegant impossibility argument for the general case and propose a per-case solver/refactor without having run the simple fix once.
**DO:** Try the cheapest knob empirically first — adjust the constant, widen the relevant tolerance, measure the real target. Reserve the heavy solution for when the simple lever is *measured* to fail, not when it's only *proven* imperfect in the limit.

**Principle:** "Can't be perfect for all" ≠ "doesn't work for this." Empirical failure on the actual target is required evidence; theoretical failure on adversarial inputs is not.

**Tell:** You're composing a sound argument for why a simple fix "structurally cannot work" and proposing architecture instead — without having run the simple fix once. That's the signal to stop, try the knob, and measure.

## "How Did It Work Before?" = Revert Signal

When the user asks "how did the old way work?", "why not keep it simple / slightly different?", or "did you even try the original approach?" — that is not a request to polish the new mechanism. It is evidence the new direction is wrong.

**DON'T:** Defend the new design across multiple fix→verify cycles, trading one symptom for another, while the user keeps invoking prior behavior.
**DO:** By the 2nd such pushback, diff against the pre-change baseline. Articulate honestly what the original did and why it was adequate. Offer to revert before sinking more cycles.

**Tell:** You are on the 3rd+ iteration fixing your own new mechanism; each fix introduces a new symptom; the user's questions consistently reference what it used to do. The thrash itself is the signal — the baseline was right.

**Principle:** Repeated pushback that references prior/simpler behavior is not polish feedback — it is a direction correction. Reverting to a known-good baseline is a first-class fix, not a failure.

## A Regression YOU Introduced Is a REVERT, Never a Redesign

Special case of the above with a sharper rule. When the user's complaint is
about behavior that broke AFTER your own change (especially collateral from a
fix aimed at a DIFFERENT symptom), the spec for "fixed" is the pre-change
baseline — not your judgment of what the mechanism should be. Redesigning it
means guessing the baseline from memory; every guess that misses costs a full
user round-trip and erodes trust.

**DON'T:** Iterate replacement designs for the thing you broke (observed
cascade: synthesis → tune-to-measured-baseline → full-physics rewrite — each
"fix" more ambitious than the last while the user kept saying "it worked
before").
**DO:** Identify the exact edit of yours that first changed the behavior,
restore that code path verbatim, and prove the restoration with a mechanical
oracle (frozen fixtures re-passing WITHOUT regeneration, byte-diff of
generated outputs, golden files) — not with "looks right".

**Tell:** Your successive fixes for one complaint GROW in scope. Scope growth
while the user references the past is the strongest possible revert signal —
by the time you're proposing an architecture, the answer was `git diff` to
the baseline three rounds ago.

**Corollary:** In a long-running UNCOMMITTED working tree, "revert" may mean
hand-reconstruction. Commit checkpoints at every user-visible-good state so a
revert is one command, not an archaeology project.

## Model Emits What the Presenter Can't Deliver → Fix the Emitter, Check the Rejected-Fix Ledger First

When a bug is a contract violation between a data/model layer and a
presentation layer — the model emitted an outcome the presenter cannot
honestly produce (an unreachable target, a state the UI can't render as one
coherent motion) — the durable fix is in the EMITTER: stop emitting
undeliverable pairings, constrained against the presenter's real capability.

**DON'T:** Patch the presenter to fake the model's claimed outcome (splicing
a canned glide/animation to "reach" a value the simulation never hit) —
however small the visual gap, it reads as fake physics and gets rejected.
**DO:** Measure the presenter's honest capability empirically — drive its
real pipeline over a parameter grid, not a hand-derived geometric bound
(chaotic outcomes have no clean closed-form threshold). Constrain the
emitter to the measured-deliverable region. Before designing the fix, check
the project's record of previously rejected fix families (memory/docs/commit
lore) — a design in a rejected family costs a full user round-trip
regardless of execution quality.

**Tell:** Your fix adds presentation-side code animating toward a model
value the simulation never reached; or you're about to ship a fix pattern
the project's history already rejected under a different symptom.

## Predicted-vs-Measured Mismatch = Falsified Hypothesis; Verify the Fix Against the ORIGINAL Metric

Two disciplines for "my fix is principled but the bug persists".

**Falsifier rule:** when a candidate mechanism lets you PREDICT an observable
consequence — the time, place, or value at which something should happen —
and the prediction MISSES what you measured (even slightly), the hypothesis
is FALSIFIED, not "measurement noise / seeding uncertainty". A real but
MASKED cause (a second effect hiding behind the one you're studying) produces
exactly this trap: the fix is sound in isolation, measures zero effect, and
the mismatch was the tell all along. Don't absorb the gap — find what your
model didn't account for.

**Post-fix gate:** after applying the fix, re-run the ORIGINAL failing metric,
not a proxy. A byte-identical result means you changed the wrong thing →
return to diagnosis; never start tuning the fix's parameters to chase the
symptom (that's curve-fitting, not fixing).

**"No effect" report ⇒ check the artifact before the logic:** when someone
reports "I don't see the change" / "looks the same" after a change you
believe you made, your FIRST move is not to re-explain or re-diagnose the
logic — it's to confirm you and they are observing the SAME, freshly-built
artifact. A stale build (a build/test script that rebuilds only one target)
or a proxy (a simulation, a different binary, a reimplementation of the
logic in another language) makes a correct fix look broken and a broken fix
look correct — the two are indistinguishable from the symptom alone.

**Tell:** you're about to defend a change with evidence from something OTHER
than the exact artifact under observation — test output, a script that
reimplements the logic, a binary built by a different command than the one
that produced what the user is running.

**Do:** before trusting what an artifact shows, verify it was built from
current sources — compare its mtime against the changed sources, or confirm
the build command actually rebuilds THAT target (many build/test scripts
rebuild only a subset). Reproduce the effect through the exact artifact the
user runs, not a proxy.

Abstract example: a "no effect" report traced to a stale interactive
binary — the test script rebuilt only the test target, so the tool under
observation still ran old code while the suite passed. A simulation of the
logic had "proved" the fix; the shipped artifact never had it.

## A Never-Reset Latch Is Stale on Occurrence 2 — Test the Second Run, Not the First

When a value is latched once per occurrence (per request, per run, per
cycle) behind a "0/null = unset" sentinel, and the code only ASSIGNS that
field and never RESETS it, the field is stale starting on the occurrence
AFTER the one that set it. First-occurrence testing — fresh process, first
request, clean start — always passes, because the sentinel is genuinely
unset the first time; the bug is invisible to single-shot verification by
construction. It surfaces on occurrence 2+ (the prior value persists) or on
a variant path that's supposed to leave the field unset (the consumer reads
the stale leftover and acts on it).

**DON'T:** Verify a stateful feature with one clean-start run and call it
done. A green first run proves nothing about lifecycle correctness.

**DO:** Exercise occurrence 2+ of the same operation back to back, plus the
variant path meant to leave the field unset — confirm the sentinel is
actually cleared between occurrences, not just correctly read on the first
one. The durable fix is a teardown that clears the latch at end-of-occurrence
or start-of-next, not a consumer-side guess at the stale value.

**Tell:** Your fix relies on "0/null means unset," but grep shows the field
is assigned in exactly one place and reset nowhere — the previous
occurrence's value survives into the next.

## A Positional Join of Two Lists Silently Mispairs — Cross-Check Before Reporting

Zipping two separately-produced sequences by position (not an explicit shared key) mispairs every row once their internal ordering diverges — yet the join succeeds and row counts match, so the result looks entirely plausible:

```sh
find . -exec md5 -q {} \; > sums.txt    # traversal order
find . | sort              > names.txt  # different order
paste sums.txt names.txt                # rows now mismatched
```

**DON'T:** Trust matching line counts as proof of correct pairing — derive both sides from ONE ordered list, or carry the key with the value per line, avoiding the join entirely.
**DO:** Before reporting any derived list, count, or diff, cross-check it against a source built by a different mechanism — that's the reusable discipline; the ordering bug is just one way to trigger it.

**Tell:** You're about to report a list/count/diff with no independent confirmation. Same risk for any index-zipped parallel sequences — log lines↔timestamps, ids↔results, rows↔headers.

## An Untested Explanation Is a Guess — Manipulate the Cause Before Reasoning From It

A component fails to surface something it plausibly should have. The observation is real, but the explanation you reach for — "the needed input was never in scope for that query" — is invented on the spot, sounds mechanical, and is never tested. Reasoning forward from it hands the user a confident, wrong verdict ("nothing can be done short of a much bigger change").

**DON'T:** Treat a fluent, plausible-sounding mechanism as a finding. The symptom being real doesn't make your story about it real.
**DO:** Test the claimed cause by changing it — supply the "missing" input and re-run, reorder if the claim is about ordering, clear the cache if the claim is staleness. One flip is usually cheap; a cause that survives the flip is worth reasoning from. Only fall back to reading the implementation when manipulation isn't practical — and when the two disagree, the manipulation wins.

**Tell:** You're about to write "because" about behavior you haven't varied — especially right before the next sentence rules an option out.

**Principle:** A conclusion inherits the confidence of its weakest premise. "It doesn't fire and I haven't established why" beats a fast, wrong "nothing can be done."

## A Check Coarser Than the Symptom Can't Eliminate a Hypothesis — Re-Test the Reporter's Own Theory First, at Matching Resolution

When the reporter names a mechanism up front (a boundary, seam, or junction in the affected content) and an early check "rules it out," distrust the check before the theory. A check whose granularity — window size, sampling interval — exceeds the symptom's own scale (e.g. analysis windows several times larger than the object that vanishes) structurally cannot detect an effect confined to that scale; it reports "no effect" whether or not one exists.

**DON'T:** Accept "ruled out" from a coarse probe and spend the investigation inventing self-made mechanisms instead.
**DO:** When investigation stalls, re-test the reporter's stated mechanism FIRST at a resolution finer than the symptom itself, before trying anything else. Log WHERE (screen location, index, coordinate) each occurrence is caught from the very first detection — a positional fingerprint (always the same edge/side) is itself evidence for the mechanism.

**Tell:** You "ruled out" a hypothesis with a check whose granularity is coarser than the thing measured, and hours later you're still inventing new mechanisms instead of tightening that one check.

## Verifying a SYMMETRIC Change: the Half You Can Already See Says Nothing About the Other

A change with two mirrored halves (two edges, two directions, two endpoints) invites verifying one
and inferring the other — especially when every capture happens to show the second half already
settled, so there is nothing visibly wrong with it. "Symmetric by construction" is a statement
about the code you wrote, not evidence about the code that runs; if only one half was ever observed
in motion, only one half was verified.

**DO:** name each half before verifying, and require an observation of EACH one mid-transition. A
capture where a half is already at rest is not a capture of that half.

**And when the two halves share one driver, their disagreement is a MEASUREMENT, not noise.** Two
things moved by one clock must be at the same FRACTION of their own travel at every instant. Catch
them at wildly different fractions and something is wrong — even if you got the numbers by eyeballing
pixels. Imprecision only earns a dismissal when the discrepancy is of the same order as the
imprecision; a 200-unit gap read off an estimate good to ~3 units is a finding.

**Tell:** you are about to write off an inconsistency because "I only estimated it from the picture."
Estimate the error bar out loud and compare — that takes one sentence and settles it.

**Example (abstracted):** a two-part transition drove both parts from a single tween. One frame
showed part A still 200 px from home while part B was already there — impossible under a shared
clock. It was dismissed as sloppy pixel-reading; the parts had genuinely mismatched travel
distances, and the defect shipped as "verified" for another round.

## A Pixel/Threshold Detector Is Blind Without a Positive Control — Calibrate Against the Live Frame

An automated visual detector built on a fixed color mask or threshold silently reports "cannot reproduce" the moment the live palette drifts from the one it was tuned on (a different lighting/theme/tint state) — the target contributes zero masked pixels, so the detector is blind, not the bug absent. Many clean runs are not evidence of absence if the mask was never checked against the CURRENT frame.

**DON'T:** Trust a color/threshold detector's "found nothing" after N runs without proving it can find a known-present target under current conditions.
**DO:** Before relying on such a detector, sample actual pixels from a live frame and derive thresholds from the sample; re-calibrate whenever the app's visual state changes. Run a positive control — a known target it must catch — before trusting any null result.

**Tell:** A detector reports zero hits across many runs, but its mask/threshold was authored against a different visual state than the one under test.

**The liveness filter guarding such a detector fails the same way, and inverts the verdict.** The
natural guard is "this frame is live if some reference pixel is NOT the empty value" — and a DEAD
frame (all zeroes, a stale or never-presented buffer) is also not the empty value, so it sails
through as live, and every subsequent pixel is then reported as a hit. The run comes back with a
huge, confident count of a defect that does not exist. Write the guard as a POSITIVE match — the
reference pixel equals the colour that known-present content actually has there — so a blank frame
fails it by construction. And if the readback path is itself unreliable (a GPU buffer read outside
its frame), prefer the compositor: a screenshot is composited correctly when an in-page read is not.

## An A/B Diff Harness Proves Nothing Until It Has Been Shown to Detect a Difference

Comparing two builds/engines/configs by diffing their outputs assumes the harness runs each arm correctly — but a malformed invocation (wrong flag order, wrong subcommand, wrong arg) can make BOTH arms fail IDENTICALLY: same usage/error text, same empty output. The diff is then empty, which reads exactly like the null result you were hoping for ("no regressions"), so nothing prompts a second look.

**DON'T:** Trust an empty diff between two arms as proof of parity — especially when the identical output also has a plausible-looking size (e.g. matching line counts).

**DO:** Before trusting an empty diff, prove the harness CAN detect a difference: feed it an input known to differ and confirm a non-empty diff, or at minimum read a few raw lines of one arm's output and confirm it's the expected KIND of content (file paths, not usage/error text). Sibling of the positive-control rule above, applied to A/B comparison harnesses instead of pixel detectors — same discipline as showing a test runner CAN fail before trusting its "all green."

**Tell:** Both arms' outputs are byte-identical AND you have never seen this harness detect any difference before. Extra suspicion when that identical output also has a plausible-looking size.

**Example (abstracted):** two builds of a formatter were compared by diffing "files that would change" over ~800 files. A CLI flag was passed before the subcommand, so BOTH builds printed usage text instead of file lists — the line counts happened to match (71 usage lines, mistaken for 71 files), the diff was empty, and "no behavioral change" was nearly reported. Caught only because a direct probe of the one file known to be affected also failed visibly.

## Temporary Instrumentation: Verify Its REMOVAL by Searching for the Marker

Adding print statements to measure a real system is the right move when reading cannot answer the
question. Removing them is where it goes wrong: a bulk edit (regex, sed, multi-block replace) that
"succeeded" may have matched fewer sites than you wrote, and nothing tells you. Two costs, both
quiet:

- leftovers ride along into the diff and the commit;
- a PARTIALLY removed probe set still prints, so the next measurement looks like data while
  covering only the sites that happen to remain. Plausible, smaller numbers — not obviously wrong.

**DO:** after removing, grep the codebase for the marker (`Sys.stderr`, `console.log`, the tag
string) and assert the count is zero. Trust the search, not the edit's exit status. Same when
ADDING: assert the probe count equals the number of sites you intended, or a "total" that is
missing whole categories will read as a genuine drop.

**Tell:** you ran one removal pass over several blocks at once; or a fresh measurement reports far
fewer items than the previous one, and you are about to explain the drop as progress.

**Example (abstracted):** four refusal-reason probes were added to a gate, then removed with one
regex — it matched two. The pair survived several full runs whose results were reported, and the
next measurement printed 5 refusals instead of 118, because only two categories still had a probe.
The drop looked like the fix working.

## Reproduced the Bug? Find the Commit That Introduced It BEFORE Designing the Fix

A reproduction tells you WHICH invariant is violated now. It does not tell you which invariant the
code was written to rely on. Designing a fix from the reproduction alone means inventing an
invariant — usually a new field or a new tracked quantity — when the original one is still in the
file, just written at the wrong moment. The result works and passes the harness, so nothing
contradicts it; you have simply added state to a system that had the value already.

**DO:** once the symptom reproduces, run a content search over the exact broken expression and its
neighbours (`git log -S "<the expression>" -- <file>`, then read that commit's diff). Compare the
current version of the surrounding function against the last version that worked. The fix is usually
expressible in the vocabulary that diff shows.

**Tell:** your fix introduces a new field/counter whose value is "what X used to mean", and you have
not read the commit that changed what X means. Also: you can state the root cause precisely but
cannot say when it started — those two should arrive together.

**Bonus the search gives you for free:** the answer to "why did this only start recently", which the
reporter will ask, and whether the culprit commit is released (`git tag --contains`) — which decides
whether reverting it in place is even an option.

**Example (abstracted):** a chunked downloader began fetching the same range twice. The reproduction
was exact, and the fix added a field tracking "bytes handed to the writer". The introducing commit
showed a one-line move: a counter that had been incremented synchronously at hand-off was now
incremented in the async completion callback. The value was still there, in an existing field
holding the in-flight write size; adding it to the position expression was two lines and no new
state.

## A Few Runs of a RANDOMIZED System Are Not a Before/After Measurement

When the observable is an end-of-run aggregate (a score, a survival time, a count of
handled items) and the run is driven by randomness, the same build produces a wide spread.
Comparing "before" runs against "after" runs then reads like a regression whenever the
post-change samples land low — and the urge to announce one is strongest right after a
refactor, because that is when a regression is most plausible.

**Tell:** you are about to say "looks like a regression" and your evidence is a handful of
end-of-run numbers, with no seed pinned and no check that the mechanism you changed even
ran.

**DO:** instrument the MECHANISM instead of the aggregate. One trace on the transition you
refactored settles it in a single run — it either fires the expected number of times or it
does not, and no sample size is involved. Only fall back to comparing aggregates when the
mechanism is confirmed live, and then pin the seed or take enough samples for the spread.

**Example (abstracted):** a state machine was rewritten from manual subscribe/unsubscribe
calls to declarative conditional subscriptions. Three post-change runs scored 0, 6, 0 where
three pre-change runs had scored 21, 35, 17, and a regression was reported. A trace on the
transition showed it firing seven times in the next run with a normal score — the low runs
had simply started with a hazard instead of a reward. The claim reached the user before the
one-line trace that refuted it.

## Before Demanding a BASELINE Run, Check the Baseline Can Produce the Signal

The instinct on "did my change cause this?" is right, and the control run is the honest way to
settle it. What gets skipped is whether the control is achievable at all. When the change is what
makes the observable EXIST — the sound plays only with the fix, the page renders only with the
fix — then "with" versus "without" has nothing to compare: the baseline is silent by construction,
and every request for it costs the reporter a trip that cannot return an answer. Worse, its null
result LOOKS like data ("no sound in the old build either"), so it invites the wrong conclusion.

**Tell:** you are asking someone to run the pre-change version to see whether a symptom predates
your work, and the pre-change version cannot exhibit the healthy state either. Also: you are
asking a third time.

**DO:** before requesting a control, name what the baseline should show if the symptom is absent.
If you cannot name it, the control is void — and often the tradeoff you wanted to weigh does not
exist either, because the alternative to the change is not "the old behaviour" but "no behaviour".
Look instead for a control INSIDE the changed system: a run where the suspect setting was
inactive at the moment of failure answers the same question without a second build.

**The environment-side twin: never assert the reporter's device state as established.** "Your
phone is on silent", "your cache is stale", "your switch is off" are claims about something only
they can see, and stating one as fact reads as blame while it is still a guess — it also stops
the investigation on their side. Say which observation implies it and hand them the discriminator
(two buttons, two URLs), rather than the verdict. A second, equally good explanation is usually
sitting right there: the state you already know is broken and persists across reloads.

**Example (abstracted):** a fix made a muted platform audible. Asked whether the fix also caused
a later failure, the agent demanded a pre-fix control three times — but the pre-fix build produced
no output at all on that device, so the comparison never existed. Meanwhile a run in which the
suspect setting had been switched off for the whole failure window was already in the logs and
answered it. The same session had asserted the reporter's mute switch was on; it had been off
throughout.

## A Measurement on an EXCLUSIVE Resource Is Void Unless Exclusivity Was Re-Checked Right Before It

When the thing under measurement can be held by only one client at a time (a hardware codec, a
device node, a GPU context, a single-slot license, an exclusive lock), any other client active
during the run turns the numbers into a measurement of contention. The precondition is not
satisfied by "I checked when the session started": the other client is usually a person who
starts and stops their own run whenever they like. Re-assert it immediately before EVERY run,
and put the check inside the harness so it refuses to start at all while the other process is
alive — a rule you have to remember is a rule you will skip on run five.

**The tell lives in the data, not only in the setup: failures CLUSTER.** A stationary
per-attempt failure rate scatters failures through the run; an external holder produces a burst
— all of them in the first stretch and none in the last. Before believing a rate, compute how
likely the observed split is under it (a clean tail of 7 iterations at a claimed 40% failure
rate is ~3%, i.e. the rate is not what you think).

**It cuts both ways:** while your probe holds the resource, the OTHER client is the one failing.
A stall, a black frame or a timeout the user reports from their own testing inside your probe
window may be your probe, not their bug — say so before they chase it.

**DO:** when a freshly measured rate disagrees sharply with an earlier one, suspect a second
client before you suspect the code, and re-run with exclusivity proven. **DON'T** redesign a
mechanism, or write up "the fix is insufficient", on a run whose exclusivity you cannot vouch
for.

**Example (abstracted):** an in-process retry loop was measured against a device whose decoder
accepts one client. It reported that 8 of 20 starts failed even with every retry, and that was
written up as "the retry is insufficient" — in code comments, in docs, and in a durable note.
The owner had started the real application for their own testing partway through. The tell was
already visible: every failure fell in the first two thirds of the run and the last seven
iterations were clean.

## A Deadlock You Cannot Attach a Debugger To: Kernel State Names the Wait, Not the Waiter

Per-thread kernel state — `wchan`, the syscall number, run state — is the first thing to reach
for on a frozen process, and it is genuinely useful for "is anything running at all". It cannot
settle **which** wait, and that is the question. Every candidate cycle you can read out of the
source produces the same picture: the main thread parked in a futex, no thread exiting, workers
idling in their sleep loops. So each hypothesis stays consistent with the evidence, and the
evidence cannot rank them.

Two traps make this worse:
- The userspace `pc` recorded alongside the syscall is the libc syscall wrapper, in every thread,
  every time. Resolving it against the memory map tells you nothing about your own code.
- A futex's operation flags and expected value look like they identify the primitive. They do not
  identify the *caller*, and a join and a condition wait are easy to mistake for each other.

**DO:** when no debugger can be installed (no disk, no package, a box you must not disturb),
stop reasoning and build the log. Append `<monotonic ms> tid > name` on entry and `< name` on
exit, flushed every line, from an RAII scope placed on (a) every entry point an external runtime
calls into your code and (b) every join, lock and blocking call. Run the reproduction once: the
unmatched `>` names the culprit, and the interleaving of the two threads' lines shows the cycle.
Then delete the instrumentation and verify its removal by grepping for the marker.

**DON'T** ship a fix derived only from reading the source when the observable cannot distinguish
it from the alternatives. A wrong fix costs the same build-and-deploy cycle the tracing would
have cost, and teaches nothing — while a fix that changes no behaviour is easy to misread as
"the bug is elsewhere now" instead of "the hypothesis was wrong".

**Example (abstracted):** a process froze whenever a subsystem was stopped. Source reading gave a
plausible race on a lifecycle flag shared by two threads, and it was real UB — but fixing it
changed nothing. Entry/exit tracing showed the true cycle in one run: the stop call, on the
thread the runtime owns, was joining a worker that was itself blocked inside a runtime callback
that cannot return while that thread is inside the runtime.

## A Tag-to-Tag Diff Exonerates Only the Artifacts the Repo Actually Tracks

"Version N worked, N+1 does not" invites reading the diff between the two tags. But a release
bundles more than the tracked sources: gitignored binaries — a native extension, a plugin, a
vendored shared library, a model file — ship inside the build and are absent from every diff. A
clean diff over the suspect subsystem then reads as "the subsystem did not change", which is the
opposite of what was proved.

**DO:** before treating a diff as evidence, run `git check-ignore -v <artifact>` and
`git ls-files <dir>` on the components the suspect subsystem depends on. If a component is
untracked, the version boundary does not describe it at all, and the cheapest next step is not a
bisect over N commits — it is swapping that one artifact between the two builds. Two runs split the
search space in half before a single commit is bisected.

**Tell:** the diff for the failing subsystem is small and innocuous, yet the version boundary is
sharp and reproducible. A sharp boundary with nothing in the diff means something outside the diff
moved.

**Example (abstracted):** a media pipeline regressed between two adjacent releases. The whole
source diff for that subsystem was a refactor plus one gate that only reduced work. The engine it
called was a prebuilt binary matched by an `ignore` glob, so no release-to-release diff had ever
included it.

## A Tuning Knob Cannot Explain a Regression the Old Version Survived at the Same Value

When a known-good version ran the same threshold, interval, or buffer size, proposing to change that
value is not a test of a regression hypothesis — at best it masks the symptom, and a null result
rules nothing out either. Load and timing are always plausible and never falsifiable this way, which
is exactly why they are tempting after the specific hypotheses have failed.

**DO:** read the setting's history first (`git log -L` over the accessor, or `git log -S` on the
literal) and confirm the value actually differs between the working and broken versions. If it does
not, the knob is not a variable in this experiment; spend the run on something that differs.

**Tell:** you are proposing a probe whose outcome you cannot state in advance for BOTH results —
"if it stops crashing, then X; if it keeps crashing, then Y" — and Y comes out as "inconclusive".
Also: the reporter asks "how is that connected, it used to work?", which is the same objection.

## A Drop-In Replacement Measured BESIDE the Host Has Not Been Measured

Swapping one component for another inside a large host process — a renderer, a codec, a sink, an
allocator, a crypto backend — invites a standalone rig: drive the old and the new component from a
small harness, compare throughput, cost and output, pick the winner. The rig is honest, the numbers
are real, and they can still be worthless, because the replacement's cost is not a property of the
component alone. It shares the host's resources: one GPU or graphics context, one event loop, one
display connection, one input queue, one thread pool, one lock. A component that is strictly cheaper
on its own can starve or deadlock against the host's own use of the same resource, and the damage
shows up somewhere the rig never looked — the host's UI stops responding, unrelated input is
swallowed, a second consumer of the shared context stalls.

The trap is that every standalone arm agrees, and agreement across many arms reads as strength. It
is not: they all omit the same variable. Ten arms outside the host are ten copies of one experiment.

**DO:** before calling a swap good, run the real host with the replacement in it and exercise what
the host does *around* the component — not just the component's own output. If the host cannot be
driven automatically, that is the point to hand it to whoever can run it, stating plainly that the
numbers so far are standalone. Keep the standalone rig for what it is good at: proving the component
works at all, and localizing a failure once the host shows one.

**Tell:** every measurement was taken with a CLI tool, a test binary, or a harness that links the
component directly, and the sentence you are about to write is "X is strictly better, deploy it".
Also: you already wrote down the coexistence risk as a caveat and then let the standalone numbers
answer it — a risk you named and did not test is untested, however good the other numbers are.

## New Failure Right After an Environment Change = Suspect the Change First

When a new failure appears right after you changed something about the test environment — a kernel module parameter, a driver setting, a fixture size, a mock's capacity — suspect that change before you suspect the product under test, even when the symptom lands in a different subsystem than the setting and comes with a plausible product-side story attached.

**DO:** revert the environment change and re-test FIRST, before building instrumentation or reasoning about the product. The tell was there from the start: the symptom had never appeared before the environment change.

**Tell:** you're several build/deploy/instrument cycles into a hypothesis about the product, and the one-line revert has not been tried yet.

**Corollary:** change one environment variable at a time, and record the stock/default value, so reverting is cheap.

## Ignoring a Side-Effecting Query's Result Makes the Caller Retry It — Filter at the Source

A callee that both selects a best match AND mutates state as part of matching — e.g. blends the query into the matched item's running state — has a hidden contract: every call it accepts is a write, not just a read. When the caller later decides some matches are invalid (they land on a subset it now considers unusable, such as items no longer present) and starts discarding those results on its own side, the discard costs more than the one bad answer:

**Failure 1 — the side effect repeats forever.** The discarded item stays "unmatched" from the caller's point of view, so the caller re-queries it on every later event, and the callee's mutation fires again each time. A 50/50 blend does not average away: the target's own original state weight decays as 2^-n over n repeated matches, and the drift is self-reinforcing — the more corrupted the target becomes, the more easily it wins later matches too.

**Failure 2 — a true match gets masked, not just a false one.** The callee picks ONE best candidate over the whole set it was given. If an invalid candidate happens to be the closest, it wins the slot and blocks a valid candidate that also cleared the match threshold — the caller's discard turns a false match into a missed one, not a corrected one.

**DON'T:** add a caller-side branch that calls the side-effecting matcher and then ignores or discards results landing on a subset the caller considers invalid. The call already happened, and the mutation already fired, before the caller's filter runs.

**DO:** before filtering a callee's result, list what the callee mutates and how it selects among candidates. If either depends on the same set the caller wants to filter, move the filter INTO the callee's candidate selection — exclude invalid candidates before it picks and before it mutates — and keep the caller-side filter only as a safety net for what the callee cannot know about (lag between two independently-updated views of the set, or an older callee version still in the field).

**Tell:** a fix that adds only a caller-side "if invalid, ignore this result" branch around a call that also writes state as part of producing that result.

## A Floating-Point Round-Trip Is Not Identity — Never Detect an Event by FP Equality

A value pushed through arithmetic that is an identity "on paper" — wrap into a range, convert units and back, normalize an angle — generally does NOT come back bit-identical: each surrounding add/subtract rounds, so in-range inputs pick up ~1 ULP. Gating an event on `result !== input` therefore fires on values that never left the range, at a rate that silently depends on magnitudes elsewhere in the state (e.g. camera position), so it can look correct in one regime and fire every frame in another.

**DON'T:** use FP equality of a round-tripped value as the signal that the operation "did something".

**DO:** detect the event by the condition that causes it — a range check before wrapping, an explicit flag from the code path that changes the value — then normalize. Skipping the round-trip in the common no-op case also removes its noise.

**Tell:** a callback meant to fire rarely (teleport, recycle, overflow) fires for every entity every frame. Concrete gamedev case with measurements: `domain-gamedev` → "Modulo-wrap round-trip is NOT identity".

## `pkill -f` Inside a Remote Command String Kills Its Own Shell

`ssh host 'pkill -f some/path/proc; next-command'` (or any `sh -c '<string>'`) runs the string in a
shell whose own command line contains the pattern. `pkill -f` matches that shell and kills it: the
session dies (ssh exits 255) and everything after the `;` never runs.

The pattern can also miss the real target: a process started as `./proc` from its own directory does
NOT match a pattern holding its absolute path, so the old instance survives and two instances fight
for an exclusive resource.

**DON'T:** `pkill -f` with a pattern that appears literally in the string you are executing.

**DO:** `pkill -x <name>` (exact process name), or a bracket pattern such as `pkill -f '[s]ome/path'`
that cannot match its own command line. Afterwards confirm with `pgrep -a` that exactly the
intended instance is alive.

**Tell:** a remote command exits 255 with no output and the steps after the kill did not run; or a
"restarted" process behaves as if two copies were running.

## A Screen-Capture Session on the Device Voids Every Display Measurement

An active remote-desktop or screen-sharing session captures the screen at refresh rate. The display
server then burns most of a core (measured: 8% -> 70%), frames drop, and GPU writes lose their
timing — a known-good build suddenly shows lag and tearing.

**DO:** before any visual or display-performance test, and whenever results flip for no code
reason, list established remote-desktop connections and the capture process CPU
(`ss -tnp state established`, `top`), and compare display-server CPU against the known baseline.

**Tell:** display-server CPU far above baseline while the build under test is unchanged.

Same family as "A Measurement on an EXCLUSIVE Resource Is Void Unless Exclusivity Was Re-Checked
Right Before It": another client's activity on a shared resource, re-checked before every run.

## Examples in a Comment Must Be Recomputed From the Code's Formula

A guard's comment listed which inputs pass and which fail, copied from an earlier analysis whose
formula differed slightly from the one the code ended up with (alignment 16 in the analysis, 32 in
the code). The code rejected an input the comment said passes, and the device test missed it
because the tested inputs give the same result under both formulas.

**DO:** before writing "X passes, Y fails" in a comment or report, evaluate the exact expression
from the code for every listed example (a 3-line script), and pick at least one test input where
the candidate formulas disagree.

**Tell:** examples in prose that were carried over from notes rather than computed from the final
code.
