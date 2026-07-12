---
name: skill-manager
description: Create, install, update, optimize skills
---

## Skill lifecycle manager

This skill is HEAVY. Always run via subagent (Task tool), never in main context.

### Model policy

- Use **Opus** or **Sonnet** for subagents
- **NEVER use Haiku** — insufficient for quality work
- Skills are optimized for Opus/Sonnet reasoning capabilities

**Model selection by task:**
- **OPTIMIZE skills** → Sonnet (filtering/editing, doesn't need deep reasoning)
- **CREATE skill from research** → Sonnet (research + writing)
- **Complex code generation** → Opus (when quality is critical)

### ⛔ PROTECTED skills — NEVER modify or overwrite

Skills matching `preferences*` (`preferences/`, `preferences-<lang>/`,
any other `preferences-*` variant) are user-owned personal rules.

These are ONLY updated when the user gives direct feedback.
skill-manager must NEVER touch, overwrite, or regenerate them without
an explicit user request.

### 1. FIND an existing skill

Search order:
A) Check awesome-agent-skills: https://github.com/VoltAgent/awesome-agent-skills
B) Check awesome-claude-code: https://github.com/hesreallyhim/awesome-claude-code
C) Check anthropics/skills: https://github.com/anthropics/skills
D) Search npm: `npm search claude skill <keyword>`
E) Search GitHub: `gh search repos "claude skill <keyword>"`

**IMPORTANT:** Subagents don't have access to skills. When launching a research subagent, include these web-reading rules in the prompt:

1. For GitHub repos/issues/PRs → use `gh` CLI, not web fetch
2. Fetch web pages via Jina Reader: `WebFetch("https://r.jina.ai/<url>", "<precise extraction prompt>")`
3. If Jina fails → direct `WebFetch` with prompt: "Extract ONLY main article content as clean markdown. Ignore navigation, sidebars, headers, footers, ads."
4. If page inaccessible → `WebSearch` for mirrors, docs, cached versions
5. ALWAYS specify exactly what to extract — never "get the page" or "summarize"

### 2. INSTALL an existing skill

```bash
# From known repos
npx -y openskills install <owner/repo/skill-name> -g

# Or manually
# 1. Fetch the SKILL.md content
# 2. Write to ~/.claude/skills/<skill-name>/SKILL.md
# 3. Copy any scripts/, references/, assets/ if present
```

After install, verify:
- SKILL.md has valid frontmatter (name, description)
- Description doesn't overlap with existing skills
- Fits the layered architecture: universal → lang → domain → target

### 3. CREATE a new skill from scratch

Follow Anthropic's skill-creator principles:

A) **Size = f(content)** — can be 10 lines or 500, depends on how much Claude DOESN'T know
B) **CRITICAL: Don't teach what Claude already knows!**
C) **When in doubt — EXCLUDE** (easier to add later than to remove)
D) **Minimal code examples** — only to illustrate a gotcha, not full solutions
E) **Always add `description` to frontmatter** — max 5-6 words, as short as possible. Without it Claude won't load the skill.
F) **Do NOT add `disable-model-invocation`** — skills must be callable via Skill() tool. Discovery chain: workflow `think` state → domain mapping → `Skill(name)`.
G) Use progressive disclosure:
   - SKILL.md body (<5k words) = loaded when triggered via Skill()
   - references/ = loaded on demand

**Splitting an oversized skill into references/:**
- Extract ONLY clusters that are NOT needed in every session (macro authoring, target-specific runtime edges, tool-self-development recipes). Everyday gotchas stay in the body — the model can't know it needs a gotcha it hasn't seen.
- Split by error loudness: content whose absence fails LOUDLY (compiler error, CLI failure → model goes looking) is safe to extract; content preventing SILENT bugs keeps at least a one-line trigger in the body.
- Each extracted section leaves a one-line index entry in the body: trap + fix in one line (recognition stays guaranteed, details load on demand).
- Index header gets an IMPERATIVE trigger ("BEFORE writing macro code → Read references/macros.md"), never a passive "see also".
- Move content VERBATIM (mechanical line-range split); verify every original heading appears exactly once across body + references.
- If the skill has a repo/template source of truth, write BOTH copies and diff them.

### ⚠️ What to include vs exclude in skills

**NEVER include** (Claude already knows this):
- Basic syntax of mainstream languages
- Standard library functions that are well-documented
- Common design patterns (singleton, factory, observer)
- General programming principles (DRY, SOLID)
- Popular framework basics (React, ASP.NET, Django)
- **Well-known patterns with full examples** (multi-stage Docker builds, async/await)
- **Obvious best practices** (use .gitignore, validate input)
- **Standard CLI commands** (docker run, git commit, npm install)

**ALWAYS include** (Claude needs this):
- **Gotchas and pitfalls** — things Claude commonly gets wrong
- **Subtle differences** — from similar languages/frameworks
- **Non-obvious conventions** — that differ from common patterns
- **Version-specific changes** — recent updates Claude may not know
- **Integration quirks** — how things work together in practice
- **User's preferences** — always in preferences-* skills
- **Niche topics** — obscure APIs, legacy systems, specialized domains

**Process for creating a lang-* or domain-* skill:**

1. Start with EMPTY file
2. Research web for "gotchas", "common mistakes", "pitfalls" in this domain
3. For each finding — two-model filter (Opus + Sonnet):
   - Both models know it → SKIP (water)
   - At least one doesn't know → INCLUDE
4. Specific numbers/boundaries → always verify by computation, record exact values
5. If nothing passes the filter → maybe this skill isn't needed

**Two-model consensus** (mirrors water-removal):
- Remove what BOTH models know
- Add what at LEAST ONE model doesn't know

**Gotcha vs Pattern — examples:**
```
✗ EXCLUDE: "Use multi-stage builds to reduce image size"
  (well-known pattern, Claude knows this)

✓ INCLUDE: "COPY --from=0 uses stage INDEX, not name — breaks if stages reordered"
  (gotcha, easy to miss)

✗ EXCLUDE: "Use async/await for asynchronous code"
  (basic syntax)

✓ INCLUDE: "ConfigureAwait(false) in library code — otherwise deadlock in UI"
  (subtle gotcha, context-dependent)
```

Structure:
```
~/.claude/skills/<skill-name>/
├── SKILL.md           # Required: frontmatter + instructions
├── references/        # Optional: detailed docs, schemas
├── scripts/           # Optional: executable helpers
└── assets/            # Optional: templates, samples
```

Naming for layered architecture:
- Universal: `code-writing`, `architecture`, `testing`, `refactoring`
- Language: `lang-csharp`, `lang-haxe`, `lang-python`
- Domain: `domain-unity`, `domain-dotnet`, `domain-gamedev`
- Target: `target-hashlink`, `target-aspnet`, `target-webgl`

### 4. CONVERT documentation into a skill

For turning language/framework docs into a skill:

A) Fetch documentation using web-reading chain
B) Extract:
   - Core idioms and conventions
   - Common patterns and anti-patterns
   - API quick reference (signatures, not full docs)
   - Gotchas and common mistakes
C) Structure as SKILL.md — focus on what Claude wouldn't know
D) Move detailed API references to references/ directory
E) Write precise description for auto-invocation

### 5. ENRICH skill from observed error

Triggered by reflection when Claude makes a verifiable mistake.

1. Identify the error and the skill it belongs to
2. Research the correct answer: code verification → web docs → web search
3. Verify the correct answer by running code (if possible)
4. Add ONLY the verified correction to the existing skill
5. Format: show the wrong thing and the right thing with exact values

Example flow: Claude writes `Fib(46) overflows Int32` → verification shows Fib(46) fits,
Fib(47) overflows → add verified table to math skill with exact numbers.

### 6. UPDATE an existing skill (manual)

```bash
# Via openskills (if installed from repo)
npx -y openskills update <skill-name>

# Or manually
# 1. Read current ~/.claude/skills/<skill-name>/SKILL.md
# 2. Identify what's missing or wrong
# 3. Edit with improvements
# 4. Verify description still fits
```

### 7. LIST and AUDIT current skills

```bash
ls ~/.claude/skills/
```

Check for:
- Overlapping descriptions between skills
- Skills that are too large (>500 lines)
- Missing skills for languages/domains being used
- Outdated information

### 8. OPTIMIZE skills (on model version change)

When Claude version changes (e.g., 4.5 → 5.0), run optimization:

**Trigger:** User says "optimize skills" or new model version detected.

**Process for each skill:**

1. Read the skill content
2. For each piece of information, ask:
   - "Does the NEW model already know this?" → REMOVE if yes
   - "Is this a gotcha/pitfall that's still relevant?" → KEEP
   - "Is this user's preference?" → NEVER TOUCH (preferences-*)
   - "Has this API/convention changed?" → UPDATE from fresh research
3. Re-test: does the skill still add value?
4. If skill becomes nearly empty → consider deleting it

**What to keep regardless of model version:**
- User preferences (preferences-*)
- Behavioral/meta skills (reflection)
- Infrastructure skills (web-reading, mcp-setup)
- Recent version-specific changes (last 6-12 months)
- Niche domains (ANE, Re-ID pipelines)

**What to aggressively prune:**
- Basic syntax of mainstream languages
- Well-documented standard library functions
- General programming principles
- Popular framework basics

**Deduplicate with preferences:**
During optimization, check preferences-* skills for this language/domain.
If a rule exists in preferences-*, REMOVE it from the base skill.
User preferences always win — no need to duplicate.

Example: if preferences-haxe says "use final class", remove any mention
of final class conventions from lang-haxe.

**Log optimizations:**
After optimization, note in MEMORY.md:
- Date optimized
- Model version optimized for
- What was removed/kept/updated

### 9. UPDATE selector domain mappings after creating new skills

**MANDATORY:** After creating or installing any new skill, update the domain mapping
in `~/.claude/skills/coding-skill-selector/SKILL.md` — one place.

Add the new skill to the appropriate section (by extension or by domain), e.g.:
```
- NewDomain → `Skill("domain-newdomain")`
```

**This single skill is loaded at the skill-gate states of all code-related workflows (coding, debugging, bug-fix, code-review, etc.).**

### Language rule

All skills MUST be written in English only. Never mix languages in skill files.

### Validation checklist

Before finishing any skill operation:
- [ ] Frontmatter has `name` + short `description` (no disable-model-invocation)
- [ ] Name is hyphen-case, max 64 chars
- [ ] SKILL.md ≤500 lines (size driven by content, not arbitrary target)
- [ ] Follows layered architecture (universal/lang/domain/target)
- [ ] Only gotchas/pitfalls — no basic patterns Claude already knows
- [ ] No provenance notes (dates, "verified on X", one-off measurements) — skill content is timeless method, not a change journal
- [ ] If skill is nearly empty → maybe it's not needed
- [ ] **selector domain mapping updated** (coding-skill-selector skill)
