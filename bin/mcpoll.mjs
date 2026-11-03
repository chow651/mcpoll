#!/usr/bin/env node
// mcpoll — per-host MCP visibility without a resident gateway.
//
//   node bin/mcpoll.mjs status
//   node bin/mcpoll.mjs plan    [--host cursor] [--verbose]
//   node bin/mcpoll.mjs matrix
//   node bin/mcpoll.mjs apply   [--host gemini] [--dry-run]

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { adapters, project, diff, ROOT } from "../lib/hosts.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "status";
const has = (f) => argv.includes(`--${f}`);
const val = (f, d) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const registry = JSON.parse(readFileSync(join(ROOT, "registry.json"), "utf8"));
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  c: (s) => `\x1b[36m${s}\x1b[0m`,
};

function resolvePresets(host) {
  const out = structuredClone(host);
  for (const entry of Object.values(out.servers ?? {})) {
    for (const key of ["allow", "deny"]) {
      const v = entry.tools?.[key];
      if (typeof v === "string" && v.startsWith("preset:")) {
        const name = v.slice(7);
        entry.tools[key] = registry.presets?.[name];
        if (!entry.tools[key]) throw new Error(`unknown preset "${name}"`);
      }
    }
  }
  return out;
}

const targetHosts = val("host") ? [val("host")] : Object.keys(registry.hosts);
for (const h of targetHosts) {
  if (!registry.hosts[h]) {
    console.error(`unknown host "${h}" — known: ${Object.keys(registry.hosts).join(", ")}`);
    process.exit(1);
  }
}

function report(hostName, verbose) {
  const host = resolvePresets(registry.hosts[hostName]);
  const proj = project({ ...registry, hosts: { ...registry.hosts, [hostName]: host } }, hostName);
  const d = diff(proj);
  const clean = !d.add.length && !d.change.length && !d.remove.length;

  console.log(`\n${C.b(hostName)} ${C.dim(`[${proj.adapter}]`)} ${C.dim(proj.path)}`);
  console.log(
    C.g("on/off only") +
      C.dim(`  ·  present=${Object.keys(proj.current).length} managed=${Object.keys(proj.updates).length}`),
  );
  if (proj.readError) console.log(`  ${C.y("read error")}: ${proj.readError}`);
  for (const n of d.add) console.log(`  ${C.g("+ add   ")} ${n}`);
  for (const n of d.change) console.log(`  ${C.y("~ update")} ${n}`);
  for (const n of d.remove) console.log(`  ${C.r("- remove")} ${n}`);
  if (clean) console.log(`  ${C.dim("in sync")}`);
  for (const note of proj.notes) console.log(`  ${C.y("!")} ${note}`);

  if (verbose) {
    for (const [n, e] of Object.entries(proj.updates)) {
      const allow = host.servers[n]?.tools?.allow;
      const shape = e.url ?? e.httpUrl ? "http" : "stdio";
      const filtered = allow ? ` allow=${allow.length}` : "";
      console.log(`    ${C.dim("·")} ${n}: ${shape}${filtered}`);
    }
  }
  return { hostName, host, proj, d };
}

if (cmd === "status" || cmd === "plan") {
  console.log(C.b(`mcpoll ${cmd}`) + C.dim(`  ${join(ROOT, "registry.json")}`));
  for (const h of targetHosts) report(h, cmd === "plan" || has("verbose"));
  console.log();
} else if (cmd === "matrix") {
  const servers = Object.keys(registry.servers);
  const hs = Object.keys(registry.hosts);
  const w = Math.max(16, ...servers.map((s) => s.length + 2));
  console.log("".padEnd(w) + hs.map((h) => h.padEnd(16)).join(""));
  for (const s of servers) {
    let line = s.padEnd(w);
    for (const h of hs) {
      const mode = registry.hosts[h].servers?.[s]?.mode ?? "off";
      const padded = (mode === "off" ? "·" : "on").padEnd(16);
      line += mode === "off" ? C.dim(padded) : C.g(padded);
    }
    console.log(line);
  }
  console.log();
} else if (cmd === "apply") {
  let touched = 0;
  for (const h of targetHosts) {
    const r = report(h, false);
    if (!r.d.add.length && !r.d.change.length && !r.d.remove.length) continue;
    if (has("dry-run")) {
      console.log(`  ${C.dim("dry-run — nothing written")}`);
      continue;
    }
    if (!r.proj.updates || Object.keys(r.proj.updates).length === 0) {
      // nothing but drops: still hand it to the adapter below
    }
    try {
      const res = adapters[r.proj.adapter].apply(r.proj.path, r.proj.updates, r.proj.drops, r.proj.current);
      if (res?.planOnly) {
        console.log(`  ${C.y("plan-only")} — ${proj.path} carries !!js tags; edit it by hand`);
        continue;
      }
      touched++;
      console.log(`  ${C.g("written")}${res?.backup ? C.dim(`  backup=${res.backup}`) : ""}${res?.warn ? `  ${C.y(res.warn)}` : ""}`);
    } catch (e) {
      console.log(`  ${C.r("write failed")}: ${e.message}`);
    }
  }
  console.log(touched ? `\n${C.g(`${touched} host(s) updated`)}\n` : `\n${C.dim("nothing to do")}\n`);
} else {
  console.log("usage: mcpoll <status|plan|matrix|apply> [--host X] [--dry-run] [--verbose]");
  process.exit(1);
}
