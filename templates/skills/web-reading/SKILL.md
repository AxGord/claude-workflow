---
name: web-reading
description: Fetch web content via subagents
---

## Goal: protect main context from web content bloat

Every web fetch goes through a subagent (Agent tool) with a **precise
extraction prompt** — ALWAYS specify exactly what to extract, never
"get the page content" or "summarize this page". Never put raw web
content into main conversation context.

Subagents run in the background by default — pass
`run_in_background: false` when the fetched result gates your next step.

Note: WebFetch/WebSearch may be deferred tools — load them via
ToolSearch (`select:WebFetch,WebSearch`) before first use.

### Step 1: Source-specific tools (no fetch needed)

Pick the right tool before reaching for the web:

- GitHub repos/issues/PRs → `gh` CLI
- GitHub raw file URLs (.md, .json, .yaml, .txt, etc.) → `gh api` or direct WebFetch
- npm packages → `npm info <pkg>`
- PyPI packages → `pip index versions <pkg>` or the PyPI JSON API
  (`https://pypi.org/pypi/<pkg>/json`) — `pip show` only reports the
  locally installed version, not what's available
- Local files → Read tool

If none apply → Step 2.

### Step 2: Direct WebFetch via subagent

Subagent uses WebFetch with a strict prompt:

> "Extract ONLY the main article content as clean markdown.
> Ignore navigation, sidebars, headers, footers, ads, cookie banners.
> Return structured content with headings, code blocks, and lists."

Use WebFetch for raw files too (.md, .json, .yaml, .txt, .xml, .csv).

### Step 3: Jina Reader fallback (HTML pages only)

If WebFetch failed or returned junk (bot walls, heavily scripted pages),
Jina converts HTML → clean markdown:

```
https://r.jina.ai/<original-url>
```

- HTML pages ONLY — never raw files (Step 2 handles those)
- **NEVER route URLs containing tokens, secrets, or signed parameters
  through r.jina.ai** — it is a third-party service and sees the full URL

### Step 4: WebSearch

If the page itself is inaccessible — search for the same
content in mirrors, official docs, blogs, cached versions.

### Step 5: Browser MCP, if available (last resort)

When content requires JS rendering or visual analysis, and a browser MCP
is available. Route through a subagent like every other fetch — the
subagent drives the browser and returns a TEXT summary only:

- Use browser_navigate to open the page
- Prefer browser_snapshot (text accessibility tree) over screenshots — much lighter
- Use browser_take_screenshot ONLY when visual layout matters
- NEVER pass raw screenshots or DOM dumps to main context
