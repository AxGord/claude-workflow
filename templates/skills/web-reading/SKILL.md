---
name: web-reading
description: Fetch web content via subagents
---

## Goal: protect main context from web content bloat

Every web fetch MUST go through a subagent (Task tool).
Never put raw web content into main conversation context.

### Step 1: Source-specific tools (no fetch needed)

Pick the right tool before reaching for the web:

- GitHub repos/issues/PRs → `gh` CLI
- GitHub raw file URLs (.md, .json, .yaml, .txt, etc.) → `gh api` or direct WebFetch (NOT Jina)
- npm packages → `npm info <pkg>`
- PyPI packages → `pip show <pkg>`
- Local files → Read tool

If none apply → Step 2.

### Step 2: Jina Reader via subagent (HTML pages only)

Jina converts HTML → clean markdown. Use ONLY for web pages with HTML content.
Do NOT use Jina for raw files (.md, .json, .yaml, .txt, .xml, .csv) — use direct WebFetch instead (Step 3).

Use Task tool. Subagent fetches clean content:

```
https://r.jina.ai/<original-url>
```

With a precise extraction prompt specifying WHAT to extract.

### Step 3: Direct WebFetch via subagent

If Jina failed (ECONNREFUSED, empty response, error page).
Subagent uses WebFetch with strict prompt:

> "Extract ONLY the main article content as clean markdown.
> Ignore navigation, sidebars, headers, footers, ads, cookie banners.
> Return structured content with headings, code blocks, and lists."

### Step 4: WebSearch

If the page itself is inaccessible — search for the same
content in mirrors, official docs, blogs, cached versions.

### Step 5: Browser via Playwright MCP (last resort)

When content requires JS rendering or visual analysis:

- Use browser_navigate to open the page
- Prefer browser_snapshot (text accessibility tree) over screenshots — much lighter
- Use browser_take_screenshot ONLY when visual layout matters
- If routing through subagent: subagent analyzes, returns TEXT summary only
- NEVER pass raw screenshots or DOM dumps to main context

### Prompt rules

ALWAYS specify exactly what to extract. Never "get the page content" or "summarize this page" — state precisely what data you need.
