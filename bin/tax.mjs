#!/usr/bin/env node
// mcpoll tax — the MCP context-tax ledger, in the correct unit: PER REQUEST.
//
// Context is re-sent on every LLM call, so the right units are:
//   tok/req   → how many tokens of tool schema ride along in ONE request
//   requests  → how many observed requests carried it
//   occupancy → tok/req summed over those requests (context budget consumed)
//   billed≈   → occupancy discounted by prompt-cache hit rate (tools sit at the
//               front of the prompt, so they are almost always cache reads)
//
//   node bin/tax.mjs [--refresh] [--host dsh] [--json]

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../lib/hosts.mjs";
import { scanAll, estTokens } from "../lib/usage.mjs";
import { inventory } from "../lib/inventory.mjs";
import { factorFor, costModelFor, loadCalibration } from "../lib/calibration.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f, d) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

// Cache-read is billed at roughly a tenth of fresh input on the providers in use.
const CACHE_RATE = Number(process.env.MCPOLL_CACHE_RATE ?? 0.1);

const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"));
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};
const tokFor = (chars, host) => {
  const f = factorFor(host);
  return chars == null || f == null ? null : Math.round(chars * f);
};

const k = (n) =>
  n == null ? "-" :
  Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n));

const wantHost = val("host");
const scans = scanAll().filter((h) => !wantHost || h.host === wantHost);
const inv = await inventory(registry, { refresh: has("refresh") });

const toolMap = {};
for (const [server, p] of Object.entries(inv)) {
  for (const t of p.perTool ?? []) if (toolMap[t.name] === undefined) toolMap[t.name] = server;
}

function attribute(name) {
  if (name.startsWith("mcp__")) {
    const rest = name.slice(5);
    const i = rest.lastIndexOf("__");
    return i < 0 ? null : { server: rest.slice(0, i), tool: rest.slice(i + 2) };
  }
  if (name.includes("__")) {
    const i = name.lastIndexOf("__");
    return { server: name.slice(0, i), tool: name.slice(i + 2) };
  }
  const server = toolMap[name];
  return server ? { server, tool: name } : null;
}

const median = (a) => (a?.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const report = [];

for (const scan of scans) {
  const perServer = {};
  for (const [name, n] of Object.entries(scan.calls ?? {})) {
    const a = attribute(name);
    if (a) perServer[a.server] = (perServer[a.server] ?? 0) + n;
  }

  // header-level aggregation across sessions.
  // NOTE: hosts log a request header only when the tool set CHANGES, so header
  // count is a sample. The real multiplier is the number of LLM requests made
  // while the server was loaded.
  const headerChars = {}; // server -> [chars per header]
  const requestsWhileLoaded = {}; // server -> requests in sessions where it appeared
  const sessionsWith = {}; // server -> session count
  let headerCount = 0;
  let requests = 0;
  let fresh = 0;
  let cached = 0;
  for (const s of scan.perSession ?? []) {
    headerCount += s.headerCount ?? 0;
    requests += s.requests ?? 0;
    fresh += s.fresh ?? 0;
    cached += s.cached ?? 0;
    for (const [sv, arr] of Object.entries(s.headerServerChars ?? {})) {
      (headerChars[sv] ??= []).push(...arr);
      requestsWhileLoaded[sv] = (requestsWhileLoaded[sv] ?? 0) + (s.requests ?? 0);
      sessionsWith[sv] = (sessionsWith[sv] ?? 0) + 1;
    }
  }

  const rows = [];
  const known = new Set();
  for (const [server, arr] of Object.entries(headerChars)) {
    known.add(server);
    const perReq = Math.round(median(arr) * factorFor(scan.host));
    const reqs = requestsWhileLoaded[server] ?? arr.length;
    rows.push({
      server,
      source: "header",
      perReq,
      requests: reqs,
      sampledHeaders: arr.length,
      sessions: sessionsWith[server] ?? 0,
      occupancy: perReq * reqs,
      calls: perServer[server] ?? 0,
      tools: inv[server]?.tools ?? null,
    });
  }
  const hostCfg = registry.hosts?.[scan.host]?.servers ?? {};
  for (const [server, entry] of Object.entries(hostCfg)) {
    if (known.has(server) || (entry.mode ?? "off") === "off") continue;
    const p = inv[server];
    if (!p) continue;
    known.add(server);
    rows.push({
      server,
      source: "config",
      perReq: tokFor(p.chars ?? inv[server]?.chars, scan.host),
      requests: null,
      occupancy: null,
      calls: perServer[server] ?? 0,
      tools: p.tools,
    });
  }
  for (const server of Object.keys(perServer)) {
    if (known.has(server)) continue;
    known.add(server);
    rows.push({
      server,
      source: "calls-only",
      perReq: tokFor(inv[server]?.chars, scan.host),
      requests: null,
      occupancy: null,
      calls: perServer[server],
      tools: inv[server]?.tools ?? null,
    });
  }
  rows.sort((a, b) => (b.perReq ?? -1) - (a.perReq ?? -1));

  const avgCtx = requests ? Math.round((fresh + cached) / requests) : 0;
  console.log(
    `\n${C.b(scan.host)}  ` +
      C.dim(
        `${scan.sessions} sessions · ${requests.toLocaleString()} requests · headers ${headerCount}` +
          (avgCtx ? ` · avg ctx/req ${k(avgCtx)} (fresh ${k(Math.round(fresh / requests))} + cache ${k(Math.round(cached / requests))})` : ""),
      ),
  );
  console.log(
    C.dim(
      `  ${"server".padEnd(30)}${"tools".padStart(6)}${"tok/req".padStart(9)}${"reqs".padStart(7)}${"calls".padStart(7)}${"occupancy".padStart(11)}${"billed≈".padStart(9)}   share`,
    ),
  );

  let totalOccupancy = 0;
  let wasted = 0;
  for (const r of rows) {
    const billed = r.occupancy != null ? r.occupancy * CACHE_RATE : null;
    const share = r.perReq && avgCtx ? ((r.perReq / avgCtx) * 100).toFixed(0) + "%" : "-";
    let verdict;
    let color = C.g;
    if (!r.calls && (r.perReq ?? 0) >= 100) {   // same threshold as the panel
      const dead = r.occupancy ?? r.perReq * (r.requests ?? requests);
      verdict = r.occupancy ? `WASTE ${k(dead)} ctx, 0 calls` : `cold, never called — ${k(dead)} ctx over ${(r.requests ?? requests).toLocaleString()} requests`;
      color = C.r;
      wasted += dead;
    } else if (!r.calls) {
      verdict = "cold, negligible";
      color = C.y;
    } else {
      const perCall = r.occupancy ? Math.round(r.occupancy / r.calls) : null;
      if (perCall && perCall > 100000) {
        verdict = `${k(perCall)} ctx per call`;
        color = C.r;
      } else if (perCall && perCall > 20000) {
        verdict = `${k(perCall)} ctx per call`;
        color = C.y;
      } else {
        verdict = "hot";
      }
    }
    if (r.occupancy) totalOccupancy += r.occupancy;
    const name = r.server.length > 29 ? `${r.server.slice(0, 26)}...` : r.server;
    console.log(
      `  ${name.padEnd(28)}${String(r.tools ?? "-").padStart(6)}${k(r.perReq).padStart(9)}` +
        `${String(r.requests ?? "-").padStart(10)}${String(r.calls).padStart(7)}` +
        `${(r.occupancy != null ? k(r.occupancy) : "-").padStart(11)}${(billed != null ? k(billed) : "-").padStart(10)}   ${color(share)}  ${color(verdict)}`,
    );
  }
  if (!rows.length) console.log(C.dim("  (no MCP surface found)"));
  report.push({ host: scan.host, sessions: scan.sessions, requests, avgCtx, totalOccupancy, wasted, rows });
}

console.log(C.b("\n  recommendations"));
// Single rule, deliberately dumb and auditable: costs real context, never called.
const suggestions = [];
for (const r of report) {
  for (const row of r.rows) {
    if (row.perReq == null) continue;
    if (!row.calls && row.perReq >= 100) {
      suggestions.push({
        host: r.host,
        server: row.server,
        perReq: row.perReq,
        requests: row.requests ?? 0,
        // a server never seen in the headers is charged against every request
        saves: row.perReq * (row.requests ?? r.requests),
        why: `0 calls in ${r.sessions} sessions`,
      });
    }
  }
}
suggestions.sort((a, b) => b.saves - a.saves);

if (!suggestions.length) {
  console.log(C.g("  nothing obviously dead — every loaded server was called at least once"));
} else {
  console.log(C.dim(`  ${"host".padEnd(13)}${"server".padEnd(26)}${"tok/req".padStart(9)}${"total".padStart(11)}   why`));
  for (const s of suggestions) {
    const name = s.server.length > 25 ? `${s.server.slice(0, 22)}...` : s.server;
    console.log(`  ${s.host.padEnd(13)}${name.padEnd(26)}${k(s.perReq).padStart(9)}${C.r(k(s.saves).padStart(11))}   ${C.dim(s.why)}`);
  }
  console.log(
    `
  ${C.b("removing these from their hosts frees")} ${C.g(k(suggestions.reduce((n, s) => n + s.saves, 0)))} tokens of context
` +
      C.dim(`  then: node bin/mcpoll.mjs apply`),
  );
}

// the chars→tokens factor is per host; printing one global number was wrong
const factorLine =
  "tokens = chars x factor(host) — " +
  Object.entries(loadCalibration().hosts)
    .map(([h, c]) => `${h} ${c.tokensPerChar ?? "不计价"}`)
    .join(" · ");

console.log(C.b("\n  ledger"));
for (const r of report) {
  const pct = r.totalOccupancy ? ((r.wasted / r.totalOccupancy) * 100).toFixed(0) : "0";
  console.log(
    `  ${r.host.padEnd(14)} ${k(r.avgCtx).padStart(8)} ctx/req   ` +
      `MCP occupancy ${k(r.totalOccupancy).padStart(10)}   ` +
      `wasted ${C.r(k(r.wasted)).padStart(10)}  ${C.dim(`(${pct}%)`)}`,
  );
}
console.log(
  C.dim(
    `\n  ${factorLine}. billed≈ = occupancy x ${CACHE_RATE} (prompt-cache hit).\n`,
  ),
);

if (has("json")) console.log(JSON.stringify({ report, inventory: inv }, null, 2));
