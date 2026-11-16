import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

interface Spec {
  name: string;
  tagline: string;
  chips: { text: string; tone: string }[];
}
interface Variant {
  file: string;
  width: number;
  height: number;
  bg: { blur: number; opacity: number };
}
interface Banner {
  DESIGN: string;
  DARK: Record<string, string>;
  LIGHT: Record<string, string>;
  VARIANTS: Variant[];
  logoSvg(palette: Record<string, string>): string;
  faviconSvg(): string;
  brandFiles(): { file: string; svg: string }[];
  schematicSvg(): string;
  templateNames(root?: string): string[];
  readHero(root?: string): { name: string; tagline: string };
  bannerSpec(root?: string): Spec;
  bannerHtml(spec: Spec, variant: Variant, sceneUri: string): string;
  stampText(spec: Spec): string;
  stampPng(png: Buffer, text: string): Buffer;
  readPng(png: Buffer): { width: number; height: number; text?: string };
}
const B = (await import(
  pathToFileURL(path.join(ROOT, "scripts/render-banner.mjs")).href
)) as Banner;

/** The bundled workflows as the loader's bundled tier counts them, counted here without the script's code. */
const TEMPLATES = fs
  .readdirSync(path.join(ROOT, "templates"))
  .filter(f => f.endsWith(".yaml")).length;

describe("scripts/render-banner.mjs: the banner and the social preview are rendered, not drawn", () => {
  it("the workflow chip says the number of templates/, whatever it is today", () => {
    expect(TEMPLATES).toBeGreaterThan(0);
    const chips = B.bannerSpec().chips.map(c => c.text);
    expect(chips).toContain(`${TEMPLATES} workflows`);
    // the other chips name the product's parts: engine, pool, queue, map
    expect(chips).toEqual([
      "FSM engine",
      `${TEMPLATES} workflows`,
      "Thread pool",
      "Task queue",
      "Live map",
    ]);
    expect(B.templateNames()).toHaveLength(TEMPLATES);
  });

  it("the README states the same number", () => {
    expect(read("README.md")).toContain(`**${TEMPLATES} bundled workflows**`);
  });

  it("the name and the tagline are the landing's hero, read from docs/index.md", () => {
    const front = /^---\n([\s\S]*?)\n---/.exec(read("docs/index.md"))?.[1] ?? "";
    const tagline = /^ {2}tagline: (.+)$/m.exec(front)?.[1];
    const name = /^ {2}name: (.+)$/m.exec(front)?.[1];
    expect(tagline).toBeTruthy();
    expect(B.readHero()).toEqual({ name, tagline });
    const [v] = B.VARIANTS;
    const html = B.bannerHtml(B.bannerSpec(), v, "data:image/png;base64,AAAA");
    expect(html).toContain(tagline as string);
    expect(html).toContain("data:image/png;base64,AAAA"); // the captured scene frame is the picture behind the drawing
    for (const c of B.bannerSpec().chips) expect(html).toContain(c.text);
  });

  it("the picture is the logo, the schematic of a task's life over a blurred crop of the scene frame", () => {
    for (const v of B.VARIANTS) {
      const html = B.bannerHtml(B.bannerSpec(), v, "data:image/png;base64,AAAA");
      expect(html).toContain(
        B.logoSvg(B.DARK).match(/<path d="M12 32 C22 32 20 13[^>]*>/)?.[0] as string,
      );
      for (const word of [
        "queue",
        "think",
        "code",
        "review",
        "land",
        "fix",
        "thread pool",
        "waiting",
      ])
        expect(html, word).toContain(`>${word}</text>`);
      expect(html).toContain(`filter:blur(${v.bg.blur}px)`);
      expect(html).toContain(`opacity:${v.bg.opacity}`);
    }
    // the schematic is the same in both sizes: the gates between the stages and the dashed fix arrow
    expect(B.schematicSvg().match(/rotate\(45 /g)).toHaveLength(3);
    expect(B.schematicSvg()).toContain("stroke-dasharray");
  });

  it("the README's size lays the schematic right over the scene, so its background is blurred and dimmer than the draft's (.3, sharp)", () => {
    const [readme] = B.VARIANTS;
    expect(readme.file).toBe("docs/banner.png");
    expect(readme.bg.opacity).toBeLessThanOrEqual(0.25);
    expect(readme.bg.blur).toBeGreaterThanOrEqual(3);
  });

  it("the scene behind the drawing is the live frame, not a stored picture", () => {
    const script = read("scripts/render-banner.mjs");
    expect(script).not.toMatch(/scene-bg|banner-variants|\.jpg/);
    expect(script).toContain("scene.page.screenshot(");
  });

  it("logo 2 is the site's logo (one file per colour scheme) and favicon, written by the script and current", () => {
    const files = B.brandFiles();
    expect(files.map(f => f.file)).toEqual([
      "docs/public/logo.svg",
      "docs/public/logo-light.svg",
      "docs/public/favicon.svg",
    ]);
    for (const f of files)
      expect(read(f.file), `${f.file}: run \`npm run docs:banner\``).toBe(f.svg);
    expect(B.logoSvg(B.DARK)).toContain(B.DARK.fg);
    expect(B.logoSvg(B.LIGHT)).toContain(B.LIGHT.fg);
    expect(B.logoSvg(B.LIGHT)).not.toContain(B.DARK.fg);
    expect(B.faviconSvg()).toContain("prefers-color-scheme: light");
    const config = read("docs/.vitepress/config.mts");
    expect(config).toContain('logo: { light: "/logo-light.svg", dark: "/logo.svg"');
    expect(config).toContain('href: "/claude-workflow/favicon.svg"');
  });

  it("the two images are the sizes the README and GitHub's social preview ask for", () => {
    expect(B.VARIANTS.map(v => [v.file, v.width, v.height])).toEqual([
      ["docs/banner.png", 1200, 400],
      ["docs/social-preview.png", 1280, 640],
    ]);
    for (const v of B.VARIANTS) {
      const png = B.readPng(fs.readFileSync(path.join(ROOT, v.file)));
      expect([png.width, png.height]).toEqual([v.width, v.height]);
    }
  });

  it("each committed image was rendered for today's hero and chips: a new template without a re-render fails here", () => {
    const stamp = B.stampText(B.bannerSpec());
    expect(stamp).toContain(`"${TEMPLATES} workflows"`);
    expect(stamp).toContain(`"design":"${B.DESIGN}"`); // an image of an older drawing is stale too
    for (const v of B.VARIANTS) {
      const png = B.readPng(fs.readFileSync(path.join(ROOT, v.file)));
      expect(png.text, `${v.file}: run \`npm run docs:banner\``).toBe(stamp);
    }
  });

  it("the stamp is a valid PNG chunk that reads back, and a PNG without one reads as unstamped", () => {
    const plain = fs.readFileSync(path.join(ROOT, "docs/banner.png"));
    const body = Buffer.from(plain.subarray(0, plain.indexOf("tEXt") - 4));
    // the committed file minus its stamp: signature, IHDR, then the rest after the tEXt chunk
    const at = plain.indexOf("tEXt") - 4;
    const stampLen = plain.readUInt32BE(at) + 12;
    const unstamped = Buffer.concat([body, plain.subarray(at + stampLen)]);
    expect(B.readPng(unstamped).text).toBeUndefined();
    const again = B.stampPng(unstamped, "hello");
    expect(B.readPng(again)).toEqual({ width: 1200, height: 400, text: "hello" });
    expect(again.length).toBe(unstamped.length + 12 + "Description\0hello".length);
  });

  it("is one command: npm run docs:banner, documented in the README, the images shown from docs/", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["docs:banner"]).toBe("node scripts/render-banner.mjs");
    const readme = read("README.md");
    expect(readme).toContain("`npm run docs:banner`");
    expect(readme).toContain('<img src="docs/banner.png"');
    // it captures the scene the way the recorders do: through the shared capture, not a second one
    const script = read("scripts/render-banner.mjs");
    expect(script).toContain('from "./scene-capture.mjs"');
    expect(script).toContain("window.__replay.seek(");
    expect(script).toContain("openScene()");
  });
});
