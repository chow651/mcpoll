#!/usr/bin/env node
// The other half of the ledger.
//
//   node bin/magpie-audit.mjs                 # what the local gateway already knows
//   node bin/magpie-audit.mjs --period 7d
//   node bin/magpie-audit.mjs --recent 10     # one line per recent request
//
// mcpoll splits cost per MCP server, but only for hosts that write usable logs.
// The gateway sees every request from every client and gets real usage plus a
// real price back, so it can produce the bill mcpoll cannot. It cannot split that
// bill per server — the audit keeps counters, not the request's tool definitions.

import { probe, usageByAgent, recentRequests } from "../lib/magpie.mjs";
import { scanAll } from "../lib/usage.mjs";

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
};

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const k = (n) =>
  n == null ? "—" : Math.abs(n) >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));
const money = (n) => (n == null ? "—" : `$${n.toFixed(2)}`);

const period = arg("period", "30d");
const recent = Number(arg("recent", "0"));

const gw = await probe();
if (!gw.up) {
  console.log(C.dim(`no gateway on ${gw.base} — set MAGPIE_URL if it listens elsewhere`));
  process.exit(0);
}

const usage = await usageByAgent({ period });
const t = usage.totals;

console.log(
  `\n${C.b("gateway")}  ${C.dim(`${gw.name} ${gw.version ?? ""} · ${gw.base} · period ${usage.period} since ${usage.since ?? "?"}`)}`,
);
console.log(
  C.dim(
    `  ${"host".padEnd(14)}${"calls".padStart(7)}${"input".padStart(9)}${"cache".padStart(9)}${"output".padStart(9)}${"cost".padStart(10)}${"unpriced".padStart(10)}`,
  ),
);
for (const r of usage.rows) {
  const unp = r.calls ? Math.round((r.unpriced / r.calls) * 100) : 0;
  console.log(
    `  ${r.host.padEnd(14)}${String(r.calls).padStart(7)}${k(r.input).padStart(9)}${k(r.cacheRead).padStart(9)}${k(r.output).padStart(9)}${money(r.cost).padStart(10)}` +
      (unp ? C.y(`${String(r.unpriced).padStart(10)} ${unp}%`) : String(0).padStart(10)),
  );
}
console.log(
  C.dim(
    `  ${"total".padEnd(14)}${String(t.calls).padStart(7)}${k(t.input).padStart(9)}${k(t.cacheRead).padStart(9)}${k(t.output).padStart(9)}${money(t.cost).padStart(10)}${String(t.unpriced).padStart(10)}`,
  ),
);
if (t.unpriced) {
  console.log(C.dim(`  ${t.unpriced} calls have no price for their model — counted as calls, not as money.`));
}

// ── cross-check: does mcpoll's own scan agree that these calls exist? ────────
const scans = scanAll();
const byHost = new Map(scans.map((s) => [s.host, s]));
const overlaps = usage.rows.filter((r) => byHost.has(r.host));
if (overlaps.length) {
  console.log(`\n${C.b("logs vs gateway")}  ${C.dim("same period is not guaranteed — this only checks that both sides see traffic")}`);
  console.log(C.dim(`  ${"host".padEnd(14)}${"gateway calls".padStart(14)}${"log requests".padStart(14)}${"log sessions".padStart(14)}`));
  for (const r of overlaps) {
    const s = byHost.get(r.host);
    const reqs = (s.perSession ?? []).reduce((n, x) => n + (x.requests ?? 0), 0);
    console.log(`  ${r.host.padEnd(14)}${String(r.calls).padStart(14)}${String(reqs).padStart(14)}${String(s.sessions ?? 0).padStart(14)}`);
  }
}

// ── what one request looks like ──────────────────────────────────────────────
if (recent) {
  const rows = await recentRequests({ limit: recent });
  console.log(`\n${C.b("recent requests")}`);
  console.log(
    C.dim(`  ${"time".padEnd(9)}${"host".padEnd(14)}${"model".padEnd(24)}${"in".padStart(8)}${"cache".padStart(9)}${"out".padStart(7)}${"cost".padStart(9)}`),
  );
  for (const r of rows) {
    console.log(
      `  ${String(r.t).slice(11, 19).padEnd(9)}${String(r.host).padEnd(14)}${String(r.model ?? "").slice(0, 23).padEnd(24)}` +
        `${k(r.input).padStart(8)}${k(r.cacheRead).padStart(9)}${k(r.output).padStart(7)}${(r.priced ? money(r.cost) : "—").padStart(9)}`,
    );
  }
}

console.log(
  C.dim(
    `\n  per-server split is not possible from this endpoint: the audit stores counters, not tool definitions.\n` +
      `  that needs a gateway plugin that records each request's tools[] (namespace + chars) next to its usage.\n`,
  ),
);
