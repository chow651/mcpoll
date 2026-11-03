#!/usr/bin/env node
// mcpoll panel server — on demand, loopback only, dies with the process.
//
//   node bin/ui.mjs [--port 7777] [--no-open]
//
// Endpoints
//   GET  /api/state?host=&force=   per-host incremental ledger
//   POST /api/save                 write N switches to registry in one go
//   POST /api/probe                re-probe MCP servers, then recompute one host
//   GET  /api/backups              list config backups
//   POST /api/restore              put a backup back
//   POST /api/reveal               show a file in the OS file manager
//   GET  /api/cache                size of the local caches
//   POST /api/cache/clear          drop them

import { createServer } from "node:http";
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, statSync, copyFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildState, loadRegistry, REGISTRY_PATH, ROOT as MCPOLL_ROOT } from "../lib/ledger.mjs";
import { adapters, project } from "../lib/hosts.mjs";
import { loadCalibration, setFactor, provenanceFor } from "../lib/calibration.mjs";
import { dataPath } from "../lib/paths.mjs";
import { inventory, loadCache } from "../lib/inventory.mjs";
import { probe as gatewayProbe, usageByAgent } from "../lib/magpie.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const UI = join(HERE, "..", "ui");
const argv = process.argv.slice(2);
const val = (f, d) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const PORT = Number(val("port", process.env.MCPOLL_PORT ?? 7777));
const OPEN = !argv.includes("--no-open");

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };

let cache = new Map(); // per-host state
let inflight = new Map();
let gwCache = null; // gateway audit snapshot, refreshed at most once a minute

async function state(host, { force = false, probe = false } = {}) {
  const key = `${host ?? "*"}|${probe ? "p" : ""}`;
  if (!force && cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);
  const p = buildState({ host, force, probe }).then((s) => {
    cache.set(key, s);
    inflight.delete(key);
    return s;
  });
  inflight.set(key, p);
  return p;
}

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function readBody(req) {
  let raw = "";
  for await (const c of req) raw += c;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// One atomic write for a whole batch of switches.
function saveChanges(changes) {
  const reg = loadRegistry();
  const applied = [];
  for (const { host, server, mode } of changes) {
    if (!reg.hosts?.[host]) throw Object.assign(new Error(`unknown host '${host}'`), { status: 400 });
    if (!["native", "off"].includes(mode)) throw Object.assign(new Error(`bad mode '${mode}'`), { status: 400 });
    reg.hosts[host].servers ??= {};
    reg.hosts[host].servers[server] ??= {};
    reg.hosts[host].servers[server].mode = mode;
    applied.push({ host, server, mode });
  }
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n", "utf8");
  // Every registry write leaves a trace. This is the only path that can flip a
  // host's mode, and I have already dirtied registry.json twice by accident.
  try {
    appendFileSync(
      dataPath(".audit.log"),
      `${new Date().toISOString()} save ${applied.map((a) => `${a.host}/${a.server}=${a.mode}`).join(" ")}\n`,
    );
  } catch {}
  cache.clear();
  return applied;
}

function backupDir() {
  return dataPath(".backups");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    if (p === "/api/state") {
      const host = url.searchParams.get("host") || null;
      const force = url.searchParams.has("force");
      return json(res, 200, await state(host, { force }));
    }

    if (p === "/api/save" && req.method === "POST") {
      const b = await readBody(req);
      const changes = Array.isArray(b.changes) ? b.changes : [];
      if (!changes.length) return json(res, 400, { error: "no changes" });
      const applied = saveChanges(changes);
      return json(res, 200, { ok: true, applied, state: await state(b.host ?? null, { force: false }) });
    }

    if (p === "/api/probe" && req.method === "POST") {
      const b = await readBody(req);
      cache.clear();
      return json(res, 200, { ok: true, state: await state(b.host ?? null, { force: true, probe: true }) });
    }

    if (p === "/api/backups") {
      let files = [];
      try {
        files = readdirSync(backupDir())
          .map((f) => ({ file: f, ts: statSync(join(backupDir(), f)).mtimeMs, size: statSync(join(backupDir(), f)).size }))
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 30);
      } catch {}
      return json(res, 200, { backups: files });
    }

    if (p === "/api/restore" && req.method === "POST") {
      const b = await readBody(req);
      const name = String(b.file ?? "");
      if (!name || name.includes("..") || name.includes("/") || name.includes("\\")) return json(res, 400, { error: "bad file" });
      const src = join(backupDir(), name);
      if (!existsSync(src)) return json(res, 404, { error: "backup not found" });
      const m = /^(.*)\.(\d{10,})\.bak$/.exec(name);
      if (!m) return json(res, 400, { error: "unrecognised backup name" });
      const flat = m[1];
      const reg = loadRegistry();
      const target = Object.entries(reg.hosts ?? {})
        .map(([name2]) => project(reg, name2).path)
        .find((path) => path && path.replace(/[:\\/]/g, "_") === flat);
      if (!target) return json(res, 400, { error: "cannot map backup to a host config" });
      copyFileSync(src, target);
      cache.clear();
      return json(res, 200, { ok: true, restored: target });
    }

    if (p === "/api/reveal" && req.method === "POST") {
      const b = await readBody(req);
      const target = resolve(String(b.path ?? ""));
      if (!target || !existsSync(target)) return json(res, 404, { error: "not found" });
      spawn("explorer", [`/select,${target}`], { detached: true, stdio: "ignore" }).unref();
      return json(res, 200, { ok: true });
    }

    if (p === "/api/gateway") {
      // Optional: if a local magpie gateway is running it already holds the whole
      // bill (money per client). We read it; we never write to it.
      const now = Date.now();
      if (!gwCache || now - gwCache.at > 60_000) {
        const gw = await gatewayProbe();
        let usage = null;
        if (gw.up) {
          try {
            usage = await usageByAgent({ base: gw.base, period: "30d" });
          } catch {}
        }
        gwCache = { at: now, value: { ...gw, usage } };
      }
      return json(res, 200, gwCache.value);
    }

    if (p === "/api/calibration") {
      if (req.method === "POST") {
        const b = await readBody(req);
        if (!b.host) return json(res, 400, { error: "host required" });
        const next = setFactor(b.host, b.tokensPerChar, { source: b.source ?? "manual", method: b.method ?? "手动设置" });
        cache.clear();
        return json(res, 200, { ok: true, calibration: next });
      }
      return json(res, 200, loadCalibration());
    }

    if (p === "/api/cache") {
      const files = [join(MCPOLL_ROOT, ".cache", "state.json"), join(MCPOLL_ROOT, ".cache", "inventory.json")].map((f) => {
        try {
          const st = statSync(f);
          return { file: f.split(/[\\/]/).pop(), bytes: st.size, ts: st.mtimeMs };
        } catch {
          return { file: f.split(/[\\/]/).pop(), bytes: 0, ts: null };
        }
      });
      return json(res, 200, { files, total: files.reduce((n, f) => n + f.bytes, 0) });
    }

    if (p === "/api/cache/clear" && req.method === "POST") {
      for (const f of [join(MCPOLL_ROOT, ".cache", "state.json")]) {
        try {
          rmSync(f, { force: true });
        } catch {}
      }
      cache.clear();
      return json(res, 200, { ok: true });
    }

    if (p === "/api/apply" && req.method === "POST") {
      const b = await readBody(req);
      const reg = loadRegistry();
      const targets = Array.isArray(b.hosts) && b.hosts.length ? b.hosts : b.host ? [b.host] : Object.keys(reg.hosts ?? {});
      const results = [];
      for (const h of targets) {
        const proj = project(reg, h);
        const adapter = adapters[proj.adapter];
        const cur = adapter.read(proj.path).servers ?? {};
        const d = { add: [], change: [], remove: proj.drops ?? [] };
        for (const [n, e] of Object.entries(proj.updates ?? {})) {
          if (!cur[n]) d.add.push(n);
          else if (JSON.stringify(cur[n]) !== JSON.stringify({ ...cur[n], ...e })) d.change.push(n);
        }
        if (!d.add.length && !d.change.length && !d.remove.length) {
          results.push({ host: h, changed: false });
          continue;
        }
        if (b.dryRun) {
          results.push({ host: h, dryRun: true, diff: d });
          continue;
        }
        try {
          const r = adapter.apply(proj.path, proj.updates ?? {}, proj.drops ?? [], cur);
          results.push({ host: h, changed: true, backup: r?.backup ?? null, planOnly: r?.planOnly ?? false, diff: d });
        } catch (e) {
          results.push({ host: h, error: e.message });
        }
      }
      cache.clear();
      return json(res, 200, { ok: true, results });
    }

    const file = p === "/" ? "index.html" : p.replace(/^\//, "");
    const full = join(UI, file);
    if (full.startsWith(UI) && existsSync(full)) {
      res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream", "cache-control": "no-store" });
      return res.end(readFileSync(full));
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, e?.status ?? 500, { error: String(e?.message ?? e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  // port 0 = let the OS pick (the desktop shell does this); report the real one
  const url = `http://127.0.0.1:${server.address().port}/`;
  console.log(`mcpoll  ${url}`);
  // first paint should already have numbers: warm the current host only
  state(null).catch(() => {});
  // no probe cache yet (first run / fresh clone): measure the servers once in the
  // background. Until it lands the panel shows calls and dashes, never a guess.
  if (Object.keys(loadCache()).length === 0) {
    inventory(loadRegistry(), { refresh: true })
      .then(() => {
        cache.clear();
        return state(null, { force: true });
      })
      .catch(() => {});
  }
  if (OPEN && process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  else if (OPEN) spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" }).unref();
});
