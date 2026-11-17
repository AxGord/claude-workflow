import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./dashboard.js";
import { Pool } from "./pool.js";
import { Storage } from "./storage.js";
import type { Loader } from "./loader.js";

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function base(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dash-fav-"));
  dirs.push(dir);
  const storage = new Storage(path.join(dir, "state"));
  const server = buildApp(
    storage,
    {} as Loader,
    undefined,
    new Pool(path.join(dir, "pool")),
  ).listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise(r => server.once("listening", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("dashboard tab identity", () => {
  it("serves the page with the brand title and an icon link", async () => {
    const html = await (await fetch(`${await base()}/`)).text();
    expect(html).toMatch(/<title>Claude Workflow · Dashboard<\/title>/);
    expect(html).toMatch(/<link[^>]+rel="icon"[^>]+href="\/favicon\.svg"/);
  });

  it("serves /favicon.svg as the site's icon with an svg content type", async () => {
    const res = await fetch(`${await base()}/favicon.svg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/image\/svg\+xml/);
    const body = await res.text();
    expect(body).toBe(fs.readFileSync(path.resolve("docs/public/favicon.svg"), "utf8"));
    const brand = (await import(pathToFileURL(path.resolve("scripts/brand.mjs")).href)) as {
      faviconSvg(): string;
    };
    expect(body).toBe(brand.faviconSvg());
  });

  it("fills the brand into every way the page is served, never leaving the placeholder", async () => {
    const root = await base();
    for (const p of ["/", "/index.html", "/plan"]) {
      const html = await (await fetch(`${root}${p}`)).text();
      expect(html, p).not.toContain("{{BRAND}}");
      expect(html, p).toContain("<h1>Claude Workflow</h1>");
      expect(html, p).toContain("<title>Claude Workflow · Dashboard</title>");
    }
  });

  it("the name and the favicon have one source: the site config and render-banner read scripts/brand.mjs", () => {
    const read = (f: string): string => fs.readFileSync(path.resolve(f), "utf8");
    expect(read("docs/.vitepress/config.mts")).toMatch(
      /import \{ NAME \} from "\.\.\/\.\.\/scripts\/brand\.mjs"/,
    );
    expect(read("docs/.vitepress/config.mts")).not.toMatch(/const NAME =/);
    expect(read("scripts/render-banner.mjs")).toMatch(/from "\.\/brand\.mjs"/);
    expect(read("scripts/render-banner.mjs")).not.toMatch(/function faviconSvg/);
    expect(read("scripts/brand.mjs")).not.toMatch(/^import /m);
    expect(read("dashboard/index.html")).toMatch(/<link[^>]+rel="icon"[^>]+href="\/favicon\.svg"/);
  });
});
