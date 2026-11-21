import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import {
  ROOT,
  browserInstalled,
  browserPath,
  serveBuiltSite,
  type BuiltSite,
} from "./site-browser-helpers.js";

// The catalog (anthropics/claude-plugins-community) serves 0.1.11 without build/, so the first install command a
// reader copies must be this repository's own marketplace. The rendered landing Install block and the rendered
// getting-started page are read in a real browser; the README's first install command is the first line of its
// first fenced block under "## Install".

const OWN = "/plugin marketplace add AxGord/claude-workflow";
const HAVE_BROWSER = browserInstalled();

let site: BuiltSite | undefined;
let browser: Browser;

beforeAll(async () => {
  if (!HAVE_BROWSER) return;
  site = await serveBuiltSite("wf-install-own-first");
  browser = await chromium.launch({ executablePath: browserPath() });
}, 180_000);

afterAll(async () => {
  await browser?.close();
  site?.close();
});

describe.skipIf(!HAVE_BROWSER)(
  "the rendered install copy leads with the repo's own marketplace",
  () => {
    it("landing: the Install block's first command adds AxGord/claude-workflow", async () => {
      const page = await browser.newPage();
      try {
        await page.goto(site?.url ?? "");
        await page.waitForSelector(".install pre");
        const text = await page.locator(".install pre").innerText();
        expect(text.split("\n")[0]).toBe(OWN);
        expect(text).toContain("/plugin install workflow@claude-workflow");
      } finally {
        await page.close();
      }
    }, 120_000);

    it("getting-started: the first marketplace command on the page adds AxGord/claude-workflow", async () => {
      const page = await browser.newPage();
      try {
        await page.goto(`${site?.url ?? ""}getting-started`);
        await page.waitForSelector(".vp-doc pre");
        const blocks = await page.locator(".vp-doc pre").allInnerTexts();
        const first = blocks.flatMap(b => b.split("\n")).find(l => l.includes("marketplace add"));
        expect(first).toBe(OWN);
      } finally {
        await page.close();
      }
    }, 120_000);
  },
);

describe("README", () => {
  it("the first command of the Install section's first code block adds AxGord/claude-workflow", () => {
    const md = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const section = md.split(/^## Install$/m)[1] ?? "";
    const block = /```bash\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
    expect(block.split("\n")[0]).toBe(OWN);
  });
});
