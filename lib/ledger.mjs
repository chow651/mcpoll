// One state object for both the CLI and the panel.
//
// Sources:
//   inventory → schema size per server (probe cache)
//   host logs → per-request presence + real call counts
//   registry  → what the user wants each host to see
//
// Cost model, in the only unit that matters: PER REQUEST. Context is re-sent on
// every call, so the bill is (schema tokens) × (requests while loaded).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { ROOT, adapters, project, diff } from "./hosts.mjs";
import { scanClaude, scanCodex, scanDsh, estTokens } from "./usage.mjs";
import { inventory, loadCache } from "./inventory.mjs";
import { loadCalibration, factorFor, priced } from "./calibration.mjs";
import { magpieLibrary } from "./library.mjs";
import { dataPath, seed, ensureParent } from "./paths.mjs";

export const REGISTRY_PATH = seed(dataPath("registry.json"), "registry.example.json");
const CACHE_FILE = dataPath(".cache", "state.json");

export function loadRegistry() {
  seed(REGISTRY_PATH, "registry.example.json");
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
}

/**
 * tool name -> server. Inventory keys are `server:hash`, and hosts disagree on
 * naming (MCP uses hyphens, several hosts log underscores), so index both forms
 * and drop names claimed by more than one server.
 */
const toolMap = (inv) => {
  const m = {};
  const ambiguous = new Set();
  for (const [key, p] of Object.entries(inv)) {
    const server = key.split(":")[0];
    for (const t of p.perTool ?? []) {
      for (const nm of new Set([t.name, t.name.replace(/-/g, "_")])) {
        if (m[nm] === undefined) m[nm] = server;
        else if (m[nm] !== server) ambiguous.add(nm);
      }
    }
  }
  for (const nm of ambiguous) delete m[nm];
  return m;
};

function attribute(name, map) {
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const i = rest.lastIndexOf("__");
    if (i >= 0) return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
  }
  if (name.includes("__")) {
    const i = name.lastIndexOf("__");
    return { server: name.slice(0, i), tool: name.slice(i + 2) };
  }
  const server = map[name];
  return server ? { server, tool: name } : null;
}

const median = (a) => (a?.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);

// ── incremental cache ────────────────────────────────────────────────
// Cheap, exact signature per host: file count + total bytes of its sessions.
// Session logs are append-only, so the size changes whenever anything new lands.
const LOG_ROOTS = {
  "claude-code": [join(homedir(), ".claude", "projects")],
  dsh: [join(homedir(), ".dsh", "sessions")],
  codex: [join(homedir(), ".codex", "sessions")],
};

const SCANNERS = { "claude-code": scanClaude, dsh: scanDsh, codex: scanCodex };

function hostSignature(host) {
  const roots = LOG_ROOTS[host];
  if (!roots) return "none";
  let files = 0;
  let bytes = 0;
  const walk = (dir, depth = 0) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        walk(p, depth + 1);
      } else if (e.name.endsWith(".jsonl") || e.name.endsWith(".zstd")) {
        try {
          bytes += statSync(p).size;
          files++;
        } catch {}
      }
    }
  };
  for (const r of roots) walk(r);
  return `${files}:${bytes}`;
}

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf8"));
  } catch {
    return { hosts: {} };
  }
}

function writeCache(c) {
  try {
    mkdirSync(dirname(CACHE_FILE), { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(c), "utf8");
  } catch {}
}

// ── usage per host ───────────────────────────────────────────────────
function computeUsage(scan, inv, cal = {}, canPrice = true) {
  const factor = cal.tokensPerChar ?? null;
  const map = toolMap(inv);
  const perServerCalls = {};
  for (const [name, n] of Object.entries(scan.calls ?? {})) {
    const a = attribute(name, map);
    if (a) perServerCalls[a.server] = (perServerCalls[a.server] ?? 0) + n;
  }

  const headerChars = {};
  const requestsWhileLoaded = {};
  const sessionsWith = {};
  let requests = 0;
  let fresh = 0;
  let cached = 0;
  let output = 0;
  let headerCount = 0;

  for (const s of scan.perSession ?? []) {
    requests += s.requests ?? 0;
    fresh += s.fresh ?? 0;
    cached += s.cached ?? 0;
    output += s.output ?? 0;
    headerCount += s.headerCount ?? 0;
    for (const [sv, arr] of Object.entries(s.headerServerChars ?? {})) {
      (headerChars[sv] ??= []).push(...arr);
      requestsWhileLoaded[sv] = (requestsWhileLoaded[sv] ?? 0) + (s.requests ?? 0);
      sessionsWith[sv] = (sessionsWith[sv] ?? 0) + 1;
    }
  }

  const invByName = {};
  for (const [k, v] of Object.entries(inv)) invByName[k.split(":")[0]] = v;

  const perServer = {};
  for (const [server, arr] of Object.entries(headerChars)) {
    const perReq = canPrice && factor != null ? Math.round(median(arr) * factor) : null;
    const reqs = requestsWhileLoaded[server] ?? arr.length;
    perServer[server] = {
      perReq,
      requests: reqs,
      sampledHeaders: arr.length,
      sessions: sessionsWith[server] ?? 0,
      occupancy: perReq == null ? null : perReq * reqs,
      calls: perServerCalls[server] ?? 0,
    };
  }
  for (const [server, calls] of Object.entries(perServerCalls)) {
    if (perServer[server]) continue;
    perServer[server] = {
      perReq: canPrice && factor != null ? Math.round((invByName[server]?.chars ?? 0) * factor) : null,
      requests: 0,
      sampledHeaders: 0,
      sessions: 0,
      occupancy: 0,
      calls,
      source: "calls-only",
    };
  }

  return {
    sessions: scan.sessions ?? 0,
    requests,
    fresh,
    cached,
    output,
    avgCtx: requests ? Math.round((fresh + cached) / requests) : 0,
    headerCount,
    perServer,
  };
}

/**
 * @param {object} opts
 * @param {string|null} opts.host  recompute only this host; others come from cache
 * @param {boolean} opts.force     ignore this host's cache
 * @param {boolean} opts.probe     re-probe MCP servers first
 */
export async function buildState({ host = null, force = false, probe = false } = {}) {
  const registry = loadRegistry();
  const cache = readCache();
  const inv = probe ? await inventory(registry, { refresh: true }) : loadCache();

  const targets = host ? [host] : Object.keys(registry.hosts ?? {});
  const usage = {};
  if (cache.hosts) for (const [h, v] of Object.entries(cache.hosts)) usage[h] = v.usage;
  const recomputed = [];
  const unchanged = [];

  for (const h of targets) {
    const sig = hostSignature(h);
    const hit = cache.hosts?.[h];
    const scanner = SCANNERS[h];
    if (!scanner) {
      unchanged.push(h);
      continue;
    }
    const factorNow = (loadCalibration().hosts[h] ?? {}).tokensPerChar ?? null;
    if (!force && hit && hit.sig === sig && hit.factor === factorNow) {
      unchanged.push(h);
      continue;
    }
    const cal = loadCalibration().hosts[h] ?? {};
    usage[h] = computeUsage(scanner(), inv, cal, priced(h));
    cache.hosts ??= {};
    cache.hosts[h] = { sig, factor: factorNow, usage: usage[h], savedAt: Date.now() };
    recomputed.push(h);
  }
  writeCache(cache);

  // ── host projections (cheap: registry + adapter read) ─────────────
  const hosts = [];
  for (const [name, cfg] of Object.entries(registry.hosts ?? {})) {
    const proj = project(registry, name);
    const d = diff(proj);
    hosts.push({
      name,
      adapter: cfg.adapter,
      path: proj.path,
      modes: Object.fromEntries(Object.entries(cfg.servers ?? {}).map(([s, e]) => [s, e.mode ?? "off"])),
      present: Object.keys(proj.current ?? {}),
      diff: { add: d.add, change: d.change, remove: d.remove },
      notes: proj.notes,
    });
  }

  const library = magpieLibrary();

  const recommendations = [];
  for (const h of hosts) {
    const u = usage[h.name];
    if (!u) continue;
    for (const [server, m] of Object.entries(u.perServer)) {
      if (m.perReq != null && m.perReq >= 100 && !m.calls) {
        recommendations.push({
          host: h.name,
          server,
          action: "off",
          perReq: m.perReq,
          requests: m.requests,
          saves: (m.perReq ?? 0) * m.requests,
          why: `0 calls in ${u.sessions} sessions`,
        });
      }
    }
  }
  recommendations.sort((a, b) => b.saves - a.saves);

  const servers = {};
  const invByName = {};
  for (const [k, v] of Object.entries(inv)) invByName[k.split(":")[0]] = v;
  for (const [name, def] of Object.entries(registry.servers ?? {})) {
    const p = invByName[name];
    servers[name] = {
      transport: def.transport,
      url: def.url,
      tags: def.tags ?? [],
      tools: p?.tools ?? null,
      chars: p?.chars ?? null,
      perTool: (p?.perTool ?? []).map((t) => ({ name: t.name, chars: t.chars })),
    };
  }

  return {
    generatedAt: Date.now(),
    hosts,
    servers,
    usage,
    recommendations,
    totalRecoverable: recommendations.reduce((n, r) => n + r.saves, 0),
    calibration: loadCalibration(),
    library, // servers another tool (magpie) syncs into these host configs
    recomputed,
    unchanged,
  };
}

export { adapters, project, ROOT };
