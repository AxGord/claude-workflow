// The node half of scripts/smoke-fresh-install.sh: what a shell line cannot do, run against the fresh
// CLONE the shell built (never against the checkout this file sits in).
//
//   node smoke-fresh-mcp.mjs mcp       <clone> <project> <home> <port> <sids-file>
//       the MCP server over stdio (the SDK's own client, no Claude process) and the dashboard beside it
//   node smoke-fresh-mcp.mjs manifest  <clone>
//       the plugin's manifests agree with each other and name files that exist
//   node smoke-fresh-mcp.mjs pack      <clone>      (`npm pack --dry-run --json` on stdin)
//       the npm package carries what the plugin runs
//   node smoke-fresh-mcp.mjs plugin-start <plugin-dir> <project> <home> <port>
//       the server a git-sourced install runs: the command of the plugin's own .mcp.json, started in the plugin
//       directory as Claude Code leaves it (release tree, dependencies installed), one initialize + tools/list
//   node smoke-fresh-mcp.mjs block     <markdown> <needle>
//       the first fenced yaml block of <markdown> that contains <needle>
//   node smoke-fresh-mcp.mjs tasks     <markdown> <needle>
//       the same block's `tasks:` as one JSON mapping per line
//
// Every check prints `STEP <name> PASS|FAIL <reason>` on stdout; the shell turns each into its own
// PASS / FAIL line. Exit 0 whenever the checks ran (a FAIL is a line, not an exit code), 2 on usage.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [mode, ...argv] = process.argv.slice(2);

/** A check that returns its reason, or throws it: one STEP line either way. */
async function step(name, fn) {
  let line;
  try {
    line = `PASS ${(await fn()) ?? ""}`;
  } catch (err) {
    line = `FAIL ${err instanceof Error ? err.message : String(err)}`;
  }
  process.stdout.write(`STEP ${name} ${line.replace(/\s+/g, " ").trim()}\n`);
}

function must(cond, message) {
  if (!cond) throw new Error(message);
}

function yamlBlock(file, needle) {
  const blocks = [...fs.readFileSync(file, "utf8").matchAll(/```yaml\n([\s\S]*?)```/g)].map(m => m[1]);
  const hit = blocks.find(b => b.includes(needle));
  if (hit === undefined) throw new Error(`${file}: no yaml block containing ${needle}`);
  return hit;
}

async function fromClone(clone, spec) {
  return import(pathToFileURL(path.join(clone, "node_modules", spec)).href);
}

async function mcp([clone, project, home, port, sidsFile]) {
  const sdk = "@modelcontextprotocol/sdk/dist/esm/client";
  const { Client } = await fromClone(clone, `${sdk}/index.js`);
  const { StdioClientTransport } = await fromClone(clone, `${sdk}/stdio.js`);
  const base = `http://127.0.0.1:${port}`;
  const stderr = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(clone, "build", "index.js")],
    cwd: project,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: process.env.TMPDIR ?? "",
      STATE_DIR: path.join(home, ".claude", "workflow-state"),
      WF_POOL_DIR: path.join(home, ".claude", "workflow-pool"),
      DASHBOARD_PORT: port,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", d => stderr.push(String(d)));
  const client = new Client({ name: "smoke-fresh", version: "1" });
  const stop = () => void client.close().finally(() => process.exit(143));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const text = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    return res.content.map(c => c.text ?? "").join("\n");
  };
  // README "Quick start" and docs/getting-started.md "Write the YAML by hand": the blocks as printed, in the
  // project before the server starts (the page says to create the file, then ask the agent).
  const wfDir = path.join(project, ".claude", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  fs.writeFileSync(path.join(wfDir, "hello.yaml"), yamlBlock(path.join(clone, "docs", "getting-started.md"), "name: hello"));
  fs.writeFileSync(path.join(wfDir, "ship.yaml"), yamlBlock(path.join(clone, "README.md"), "name: ship"));
  const sids = [];
  const started = async (args, expect) => {
    const out = await text("start", args);
    const sid = /^SESSION: ([0-9a-f]+)/m.exec(out)?.[1];
    must(sid !== undefined, `start ${JSON.stringify(args)} answered: ${out.slice(0, 160)}`);
    must(out.includes(expect), `start ${JSON.stringify(args)}: no "${expect}" in: ${out.slice(0, 160)}`);
    sids.push(sid);
    fs.appendFileSync(sidsFile, `${sid}\n`);
    return sid;
  };
  try {
    await step("mcp-connect", async () => {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map(t => t.name);
      for (const n of ["list", "start", "transition", "status", "queue_add"])
        must(names.includes(n), `tool ${n} is not served (${names.join(" ")})`);
      return `${names.length} tools over stdio`;
    });
    await step("mcp-list", async () => {
      const out = await text("list");
      for (const n of ["master", "batch", "bug-fix", "coding"])
        must(out.includes(`  ${n} (`), `list has no workflow ${n}`);
      return `${(out.match(/^ {2}\S+ \(\d+ states\)/gm) ?? []).length} bundled workflows listed`;
    });
    await step("mcp-start-master", async () => {
      const sid = await started({}, "master @ route");
      return `start() with no arguments opened master, session ${sid}`;
    });
    await step("mcp-start-batch", async () => {
      const sid = await started({ workflow: "batch", force: "smoke: a second root on purpose" }, "batch @ ");
      return `start batch opened session ${sid}`;
    });

    await step("docs-hello", async () => {
      const out = await text("list");
      must(out.includes("  hello ("), "getting-started's hello.yaml, present when the server started, is not listed");
      const sid = await started({ workflow: "hello", force: "smoke: second root" }, "hello @ plan");
      const a = await text("transition", { session_id: sid, transition: "go" });
      must(a.includes("hello @ do"), `transition go: ${a.slice(0, 120)}`);
      const b = await text("transition", { session_id: sid, transition: "done" });
      must(/finish|complete/i.test(b), `transition done did not end the session: ${b.slice(0, 160)}`);
      return "getting-started's hello.yaml listed, started and run to its end";
    });
    // A new user's ~/.claude/workflows does not exist when the server starts: a file made there later is
    // picked up (a watcher event, a moment later), no restart.
    await step("watch-new-dir", async () => {
      const dir = path.join(home, ".claude", "workflows");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "late.yaml"),
        'name: late\ndescription: "made after the server started"\ninitial: a\nstates:\n  a:\n    terminal: true\n    outcome: complete\n',
      );
      for (let waited = 0; waited < 5000; waited += 250) {
        await new Promise(r => setTimeout(r, 250));
        if ((await text("list")).includes("  late (")) return `listed ${waited + 250} ms after it was written, no restart`;
      }
      throw new Error("a workflow file made in ~/.claude/workflows after the server started is not listed after 5 s");
    });
    await step("docs-ship-untrusted", async () => {
      const out = await text("list");
      must(!out.includes("  ship ("), "an exec workflow of an untrusted project was loaded");
      must(out.includes("wf-trust") && out.includes("not trusted"), "list does not say how to trust the project");
      return "README's ship.yaml (an exec state) is held back and list names wf-trust";
    });
    // A plugin install puts no wf-trust on the user's PATH: the line list prints must run as copied, from a
    // shell whose PATH holds nothing of the plugin.
    await step("trust-command-copyable", async () => {
      const hint = /`(\S*wf-trust) ([^`]+)`/.exec(await text("list"));
      must(hint !== null, "list prints no `<path>/wf-trust <project>` command");
      const [, cmd] = hint;
      must(path.isAbsolute(cmd), `the printed command word is not a full path: ${cmd}`);
      must(
        cmd === path.join(fs.realpathSync(clone), "scripts", "wf-trust") || cmd === path.join(clone, "scripts", "wf-trust"),
        `the printed command is not the clone's scripts/wf-trust: ${cmd}`,
      );
      const bare = `${path.dirname(process.execPath)}:/usr/bin:/bin`;
      const r = spawnSync("sh", ["-c", `command -v wf-trust`], { env: { PATH: bare, HOME: home }, encoding: "utf8" });
      must(r.status !== 0, "wf-trust is already on the smoke's PATH, the check proves nothing");
      const run = spawnSync(cmd, ["--list"], { env: { PATH: bare, HOME: home, STATE_DIR: path.join(home, ".claude", "workflow-state") }, cwd: project, encoding: "utf8" });
      must(run.status === 0, `the printed command exited ${run.status}: ${run.stderr}`);
      return "the command list prints for the consent step is the clone's wf-trust by full path and runs with no wf-* on PATH";
    });
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ projects: { [fs.realpathSync(project)]: { hasTrustDialogAccepted: true } } }),
    );
    await step("docs-ship-trusted", async () => {
      const out = await text("list");
      must(out.includes("  ship ("), "the running server did not notice the folder-trust answer");
      const sid = await started({ workflow: "ship", force: "smoke: second root" }, "ship @ plan");
      await text("transition", { session_id: sid, transition: "go" });
      const b = await text("transition", { session_id: sid, transition: "done" });
      must(b.includes("ship @ do") && b.includes("visit 2"), `a failing test state did not route back to do: ${b.slice(0, 200)}`);
      return "trust noticed without a restart; the exec `npm test` failed and routed back to do";
    });

    await step("dashboard", async () => {
      const page = await fetch(`${base}/`);
      must(page.status === 200, `GET / answered ${page.status}`);
      must((page.headers.get("content-type") ?? "").includes("text/html"), "GET / is not html");
      const api = await (await fetch(`${base}/api/sessions`)).json();
      const ids = new Set(api.map(s => s.session_id));
      for (const sid of sids) must(ids.has(sid), `GET /api/sessions lacks session ${sid}`);
      const wfs = await (await fetch(`${base}/api/workflows`)).json();
      must(JSON.stringify(wfs).includes("master"), "GET /api/workflows lacks master");
      return `GET / 200 html, /api/sessions lists ${sids.length} sessions, /api/workflows lists the workflows`;
    });
    await step("server-stderr", async () => {
      const warn = stderr.join("").split("\n").filter(l => /warning|error|fatal|unhandled|uncaught/i.test(l));
      must(warn.length === 0, `the server printed: ${warn.slice(0, 3).join(" | ")}`);
      return "no reference warning, error or uncaught exception on the server's stderr";
    });
  } finally {
    await client.close().catch(() => {});
  }
}

async function pluginStart([plugin, project, home, port]) {
  await step("release-start", async () => {
    const wf = JSON.parse(fs.readFileSync(path.join(plugin, ".mcp.json"), "utf8")).mcpServers.wf;
    const sdk = "@modelcontextprotocol/sdk/dist/esm/client";
    const { Client } = await fromClone(plugin, `${sdk}/index.js`);
    const { StdioClientTransport } = await fromClone(plugin, `${sdk}/stdio.js`);
    const stderr = [];
    const transport = new StdioClientTransport({
      command: wf.command === "node" ? process.execPath : wf.command,
      args: wf.args.map(a => a.replace("${CLAUDE_PLUGIN_ROOT}", plugin)),
      cwd: project,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        TMPDIR: process.env.TMPDIR ?? "",
        STATE_DIR: path.join(home, ".claude", "workflow-state"),
        WF_POOL_DIR: path.join(home, ".claude", "workflow-pool"),
        DASHBOARD_PORT: port,
        CLAUDE_PLUGIN_ROOT: plugin,
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", d => stderr.push(String(d)));
    const client = new Client({ name: "smoke-fresh-release", version: "1" });
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map(t => t.name);
      must(names.includes("start"), `tool start is not served (${names.join(" ")}); stderr: ${stderr.join("").slice(0, 200)}`);
      return `${wf.command} ${wf.args.join(" ")} answered initialize and served ${names.length} tools`;
    } catch (err) {
      throw new Error(`${err instanceof Error ? err.message : err}; stderr: ${stderr.join("").slice(0, 200)}`);
    } finally {
      await client.close().catch(() => {});
    }
  });
}

async function manifest([clone]) {
  const json = rel => JSON.parse(fs.readFileSync(path.join(clone, rel), "utf8"));
  await step("manifest", async () => {
    const pkg = json("package.json");
    const plugin = json(".claude-plugin/plugin.json");
    const market = json(".claude-plugin/marketplace.json");
    const mcpJson = json(".mcp.json");
    const hooks = json("hooks/hooks.json");
    const entry = market.plugins.find(p => p.name === plugin.name);
    must(entry !== undefined, `marketplace.json lists no plugin ${plugin.name}`);
    must(
      new Set([pkg.version, plugin.version, entry.version]).size === 1,
      `versions differ: package ${pkg.version}, plugin ${plugin.version}, marketplace ${entry.version}`,
    );
    must(Object.keys(mcpJson.mcpServers).join() === "wf", ".mcp.json does not register the server as `wf`");
    const tool = `mcp__plugin_${plugin.name}_wf__start`;
    must(
      fs.readFileSync(path.join(clone, "docs/getting-started.md"), "utf8").includes(tool),
      `getting-started's CLAUDE.md snippet does not name ${tool}`,
    );
    const missing = [];
    const cmds = Object.values(hooks.hooks).flatMap(groups => groups.flatMap(g => g.hooks.map(h => h.command)));
    for (const cmd of cmds) {
      const rel = /\/(hooks\/[\w.-]+)/.exec(cmd)?.[1];
      if (rel === undefined) continue;
      try {
        fs.accessSync(path.join(clone, rel), fs.constants.X_OK);
      } catch {
        missing.push(rel);
      }
    }
    for (const mod of hooks.modules ?? [])
      if (!fs.existsSync(path.join(clone, "hooks", mod))) missing.push(`hooks/${mod}`);
    const server = mcpJson.mcpServers.wf.args.join(" ").replace("${CLAUDE_PLUGIN_ROOT}/", "");
    if (!fs.existsSync(path.join(clone, server))) missing.push(server);
    must(missing.length === 0, `not executable or missing in the clone: ${missing.join(", ")}`);
    return `version ${pkg.version} in three manifests, server wf, ${cmds.length} hook commands executable`;
  });
}

async function pack([clone]) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  await step("npm-pack", async () => {
    const files = new Set(JSON.parse(Buffer.concat(chunks).toString("utf8"))[0].files.map(f => f.path));
    const need = [
      "build/index.js",
      "build/skills-cli.js",
      "build/queue-cli.js",
      ".claude-plugin/plugin.json",
      ".mcp.json",
      "hooks/hooks.json",
      "hooks/workflow-start.sh",
      "hooks/workflow-cleanup.sh",
      "hooks/plan-pane.tsx",
      "templates/master.yaml",
      "templates/skills/architecture/SKILL.md",
      "dashboard/index.html",
      "scripts/wf-queue",
      "scripts/wf-skills",
      "scripts/wf-run",
      "scripts/wf-trust",
    ];
    const missing = need.filter(f => !files.has(f));
    must(missing.length === 0, `the package lacks ${missing.join(", ")}`);
    return `${files.size} files, everything the plugin runs is in (${path.basename(clone)})`;
  });
}

switch (mode) {
  case "mcp":
    await mcp(argv);
    break;
  case "plugin-start":
    await pluginStart(argv);
    break;
  case "manifest":
    await manifest(argv);
    break;
  case "pack":
    await pack(argv);
    break;
  case "block":
    process.stdout.write(yamlBlock(argv[0], argv[1]));
    break;
  case "tasks": {
    const { parse } = await fromClone(process.env.SMOKE_CLONE ?? "", "yaml/dist/index.js");
    for (const t of parse(yamlBlock(argv[0], argv[1])).tasks) process.stdout.write(`${JSON.stringify(t)}\n`);
    break;
  }
  default:
    process.stderr.write("usage: smoke-fresh-mcp.mjs mcp|plugin-start|manifest|pack|block|tasks …\n");
    process.exit(2);
}
