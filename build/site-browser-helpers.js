import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
// What the real-browser site tests share: the repo root, the playwright browser lookup, and a built-site server.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "/claude-workflow/";
const TYPES = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
};
/** The playwright version's own browser when installed, else any installed headless shell (layout is the same). */
export function browserPath() {
    if (fs.existsSync(chromium.executablePath()))
        return undefined;
    const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
    for (const d of fs.existsSync(cache) ? fs.readdirSync(cache).sort().reverse() : []) {
        if (!d.startsWith("chromium_headless_shell-"))
            continue;
        for (const sub of fs.readdirSync(path.join(cache, d))) {
            const exe = path.join(cache, d, sub, "chrome-headless-shell");
            if (fs.existsSync(exe))
                return exe;
        }
    }
    return undefined;
}
export const browserInstalled = () => fs.existsSync(chromium.executablePath()) || browserPath() !== undefined;
const LOCK = path.join(os.tmpdir(), `wf-site-build-${path.basename(ROOT)}.lock`);
const alive = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
};
/** A lock directory without a pid file this old is the leftover of a crash between its creation and the pid write. */
const PIDLESS_STALE_MS = 5000;
/** The pid that holds the lock, 0 while it is being written or when the file is gone. */
function holder(lock) {
    try {
        return Number(fs.readFileSync(path.join(lock, "pid"), "utf8").trim()) || 0;
    }
    catch {
        return 0;
    }
}
/** True when the lock's holder is gone: its pid is dead, or it never wrote one and the directory is old. */
function stale(lock) {
    const pid = holder(lock);
    if (pid > 0)
        return !alive(pid);
    try {
        return Date.now() - fs.statSync(lock).mtimeMs > PIDLESS_STALE_MS;
    }
    catch {
        return false;
    }
}
/** VitePress builds into one `.temp` under the docs: two builds at once (test files, or a nested vitest run) break each other, so builds take turns across processes. */
export async function withBuildLock(work, lock = LOCK) {
    for (;;) {
        try {
            fs.mkdirSync(lock);
            fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
            break;
        }
        catch (e) {
            if (e.code !== "EEXIST")
                throw e;
            if (stale(lock))
                fs.rmSync(lock, { recursive: true, force: true });
            else
                await new Promise(r => setTimeout(r, 200));
        }
    }
    try {
        return work();
    }
    finally {
        fs.rmSync(lock, { recursive: true, force: true });
    }
}
/** Builds the docs site into the directory `out`, holding the build lock. */
export function buildDocs(out) {
    return withBuildLock(() => {
        execFileSync("node", ["node_modules/vitepress/bin/vitepress.js", "build", "docs", "--outDir", out], { cwd: ROOT, stdio: "pipe" });
    });
}
/** Builds the docs site into a temp directory (named by `label`) and serves it on a free local port. */
export async function serveBuiltSite(label) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
    const remove = () => fs.rmSync(out, { recursive: true, force: true });
    try {
        await buildDocs(out);
        const server = http.createServer((req, res) => {
            let rel = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
            if (!rel.startsWith(BASE))
                rel = BASE;
            rel = rel.slice(BASE.length);
            const file = path.join(out, rel === "" ? "index.html" : rel);
            const found = [file, `${file}.html`].find(f => f.startsWith(out) && fs.existsSync(f) && fs.statSync(f).isFile());
            if (!found) {
                res.statusCode = 404;
                res.end();
                return;
            }
            res.setHeader("content-type", TYPES[path.extname(found)] ?? "application/octet-stream");
            res.end(fs.readFileSync(found));
        });
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address();
        return {
            url: `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}${BASE}`,
            close: () => {
                server.close();
                remove();
            },
        };
    }
    catch (e) {
        remove();
        throw e;
    }
}
