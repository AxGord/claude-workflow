import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROOT, serveBuiltSite, type BuiltSite } from "./site-browser-helpers.js";

// A link to the site in a social network or a messenger shows a preview card: the site serves the social preview as
// docs/public/og.png (written by the same generator as docs/social-preview.png) and every page's head carries
// Open Graph and Twitter tags with ABSOLUTE urls (a crawler does not resolve a base).

const SITE = "https://axgord.github.io/claude-workflow/";
const IMAGE = `${SITE}og.png`;
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

interface Variant {
  file: string;
  also?: string[];
  width: number;
  height: number;
}
const B = (await import(pathToFileURL(path.join(ROOT, "scripts/render-banner.mjs")).href)) as {
  VARIANTS: Variant[];
  readPng(png: Buffer): { width: number; height: number; text?: string };
  stampText(spec: unknown): string;
  bannerSpec(): unknown;
};

/** The `<meta>` tags of a page as `{ "property:og:title": "...", "name:description": "..." }`. */
function metas(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of html.match(/<meta [^>]*>/g) ?? []) {
    const key = /\b(property|name)="([^"]+)"/.exec(tag);
    const content = /\bcontent="([^"]*)"/.exec(tag);
    if (key && content) out[`${key[1]}:${key[2]}`] = content[1] ?? "";
  }
  return out;
}

describe("the image: rendered by the generator, served by the site", () => {
  const social = B.VARIANTS.find(v => v.file === "docs/social-preview.png");

  it("the generator writes docs/public/og.png from the social preview's own render", () => {
    expect(social?.also).toEqual(["docs/public/og.png"]);
    expect(read("scripts/render-banner.mjs")).toContain(
      "for (const file of [variant.file, ...(variant.also ?? [])])",
    );
  });

  it("og.png is the social preview, byte for byte, 1280x640 and current for today's hero and chips", () => {
    const og = fs.readFileSync(path.join(ROOT, "docs/public/og.png"));
    expect(og.equals(fs.readFileSync(path.join(ROOT, "docs/social-preview.png")))).toBe(true);
    const png = B.readPng(og);
    expect([png.width, png.height]).toEqual([1280, 640]);
    expect(png.text, "run `npm run docs:banner`").toBe(B.stampText(B.bannerSpec()));
  });

  it("the config names the same size as the image", () => {
    const config = read("docs/.vitepress/config.mts");
    expect(config).toContain('width: "1280", height: "640"');
  });
});

describe("the built site's head", () => {
  let site: BuiltSite | undefined;
  beforeAll(async () => {
    site = await serveBuiltSite("wf-social-preview");
  }, 180_000);
  afterAll(() => site?.close());

  const page = async (route: string): Promise<string> => {
    const res = await fetch(`${site?.url ?? ""}${route}`);
    expect(res.status, route).toBe(200);
    return res.text();
  };

  it("the landing carries Open Graph and Twitter tags with absolute urls", async () => {
    const m = metas(await page(""));
    expect(m["property:og:type"]).toBe("website");
    expect(m["property:og:site_name"]).toBe("Claude Workflow");
    expect(m["property:og:title"]).toBe("Claude Workflow");
    expect(m["property:og:description"]).toBe(
      "Workflows for Claude Code agents. States, gates, a machine-wide thread pool and a live map of everything that runs.",
    );
    expect(m["property:og:url"]).toBe(SITE);
    expect(m["property:og:image"]).toBe(IMAGE);
    expect(m["property:og:image:width"]).toBe("1280");
    expect(m["property:og:image:height"]).toBe("640");
    expect(m["property:og:image:alt"]).toBeTruthy();
    expect(m["name:twitter:card"]).toBe("summary_large_image");
    expect(m["name:twitter:image"]).toBe(IMAGE);
    expect(m["name:twitter:title"]).toBe("Claude Workflow");
    expect(m["name:description"]).toBeTruthy();
  });

  it("a doc page has its own title, description and url, and the same image", async () => {
    const m = metas(await page("pool"));
    expect(m["property:og:title"]).toMatch(/ \| Claude Workflow$/);
    expect(m["property:og:description"]).toBe(
      "Why parallel agents queue instead of choking the machine, and how leases, budget, priority, locks and backfill work",
    );
    expect(m["property:og:url"]).toBe(`${SITE}pool`);
    expect(m["name:twitter:description"]).toBe(m["property:og:description"]);
    expect(m["property:og:image"]).toBe(IMAGE);
    expect(m["name:description"]).toBe(m["property:og:description"]);
  });

  it("every image url in a tag is absolute https", async () => {
    for (const route of ["", "concepts", "faq"]) {
      const m = metas(await page(route));
      for (const k of ["property:og:image", "name:twitter:image", "property:og:url"])
        expect(m[k], `${route} ${k}`).toMatch(/^https:\/\//);
    }
  });

  it("the image the tags name is served with HTTP 200 as a PNG", async () => {
    const res = await fetch(`${site?.url ?? ""}og.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.equals(fs.readFileSync(path.join(ROOT, "docs/public/og.png")))).toBe(true);
  });
});
