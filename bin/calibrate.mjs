#!/usr/bin/env node
// Measure a host's chars→tokens coefficient for real.
//
// Method: serve a fake MCP server with a known schema size, ask the host one
// trivial question, and read the real inputTokens it reports. Repeat with two
// or three sizes; the slope between points is tokens-per-char for that host's
// tokeniser. No estimation, no borrowed constants.
//
//   node bin/calibrate.mjs --host claude-code
//   node bin/calibrate.mjs --host dsh
//   node bin/calibrate.mjs --list
//
// Writes the result into calibration.json with source:"measured".

import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeServer } from "../lib/inventory.mjs";
import { setFactor, loadCalibration } from "../lib/calibration.mjs";

const NODE = process.execPath;
const FAKE = join(import.meta.dirname, "..", "test", "fake-tax.mjs");
const SIZES = [0, 12, 48];
const DESC = 200;

const argv = process.argv.slice(2);
const val = (f, d) => {
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const C = { dim: (s) => `\x1b[2m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` };

if (argv.includes("--list") || !val("host")) {
  const cal = loadCalibration();
  console.log(C.b("\n  分词系数\n"));
  for (const [h, v] of Object.entries(cal.hosts)) {
    const badge = typeof v.tokensPerChar === "number" ? C.g("实测") : C.y("无数据");
    console.log(`  ${h.padEnd(13)} ${String(v.tokensPerChar).padEnd(8)} ${badge}  ${C.dim(v.method ?? "")}`);
  }
  console.log(C.dim("\n  可自动校准：claude-code / dsh。其余宿主没有可驱动的 CLI 会话日志。\n"));
  process.exit(0);
}

const host = val("host");

// ── fake server definition (same shape the ledger prices) ──────────
function fakeDef(n) {
  return { transport: "stdio", command: NODE, args: [FAKE, String(n), String(DESC)] };
}

async function measureChars(n) {
  const r = await probeServer(`cal${n}`, fakeDef(n), { timeoutMs: 30_000 });
  return { chars: r.chars ?? 0, tools: r.tools ?? 0, error: r.error };
}

// ── driver: claude code ────────────────────────────────────────────
async function runClaude(n) {
  const cfg = JSON.stringify({ mcpServers: { cal: { command: NODE, args: [FAKE, String(n), String(DESC)] } } });
  const dir = mkdtempSync(join(tmpdir(), "mcpoll-cal-"));
  const cfgPath = join(dir, "mcp.json");
  writeFileSync(cfgPath, cfg);
  try {
    const out = await new Promise((resolve, reject) => {
      const p = spawn(
        "cmd",
        ["/c", "claude", "-p", "reply with exactly: ok", "--output-format", "json", "--mcp-config", cfgPath, "--strict-mcp-config"],
        { windowsHide: true },
      );
      let s = "";
      p.stdout.on("data", (c) => (s += c));
      p.stderr.on("data", () => {});
      p.on("exit", () => resolve(s));
      p.on("error", reject);
      setTimeout(() => p.kill(), 150_000);
    });
    for (const line of out.split("\n").reverse()) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const j = JSON.parse(t);
        if (j.usage?.input_tokens != null) {
          const u = j.usage;
          // total context actually carried = fresh + cache write + cache read
          const total = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          return { tokens: total, raw: u };
        }
      } catch {}
    }
    throw new Error("no usage in claude output");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── driver: dsh headless ───────────────────────────────────────────
async function runDsh(n) {
  const dir = mkdtempSync(join(tmpdir(), "mcpoll-cal-"));
  const overlay = join(dir, "o.yml");
  writeFileSync(
    overlay,
    `- id: cal-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: cal
    transport: stdio
    command: '${NODE.replace(/\\/g, "\\\\")}'
    args:
      - '${FAKE.replace(/\\/g, "\\\\")}'
      - '${n}'
      - '${DESC}'
`,
    "utf8",
  );
  try {
    const out = await new Promise((resolve) => {
      const p = spawn("cmd", ["/c", "dsh", "--profile", "headless", "--patch", overlay, "--json", "reply with exactly: ok"], {
        windowsHide: true,
      });
      let s = "";
      p.stdout.on("data", (c) => (s += c));
      p.stderr.on("data", () => {});
      p.on("exit", () => resolve(s));
      setTimeout(() => p.kill(), 180_000);
    });
    let total = 0;
    let found = false;
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "status" && ev.phase === "step_end" && ev.usage) {
          total += (ev.usage.inputTokens ?? 0) + (ev.usage.cacheReadTokens ?? 0);
          found = true;
        }
      } catch {}
    }
    if (!found) throw new Error("no usage events from dsh");
    return { tokens: total };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const drivers = { "claude-code": runClaude, dsh: runDsh };
const driver = drivers[host];
if (!driver) {
  console.error(`${host}: 没有可用的驱动方式。可校准：${Object.keys(drivers).join(", ")}`);
  process.exit(2);
}

console.log(C.b(`\n  校准 ${host}`) + C.dim("  每个尺寸一次真实调用\n"));
const points = [];
for (const n of SIZES) {
  const { chars, tools } = await measureChars(n);
  process.stdout.write(`  ${String(tools).padStart(3)} 个工具 / ${String(chars).padStart(7)} 字符 … `);
  const r = await driver(n);
  points.push({ n, tools, chars, tokens: r.tokens });
  console.log(`${String(r.tokens).padStart(7)} tokens`);
}

// least squares through the points, forced through a shared intercept
const xs = points.map((p) => p.chars);
const ys = points.map((p) => p.tokens);
const nPts = xs.length;
const mx = xs.reduce((a, b) => a + b, 0) / nPts;
const my = ys.reduce((a, b) => a + b, 0) / nPts;
let num = 0;
let den = 0;
for (let i = 0; i < nPts; i++) {
  num += (xs[i] - mx) * (ys[i] - my);
  den += (xs[i] - mx) ** 2;
}
const slope = den ? num / den : 0;

console.log(C.dim("\n  点："));
for (const p of points) console.log(C.dim(`    ${String(p.chars).padStart(7)} chars → ${String(p.tokens).padStart(7)} tok`));

if (!(slope > 0.05 && slope < 2)) {
  console.error(`  拟合失败：斜率 ${slope.toFixed(4)} 不合理`);
  process.exit(1);
}

setFactor(host, Number(slope.toFixed(4)), {
  source: "measured",
  method:
    `假 MCP server ${SIZES.length} 个尺寸（0/${SIZES[1]}/${SIZES[2]} 工具，${DESC} 字描述），` +
    `对真实上下文 token 数拟合` +
    (host === "claude-code" ? "；该宿主会延迟加载 MCP 工具，schema 通常不进 prompt，斜率接近「只发名字」" : ""),
});

console.log(
  C.b(`\n  ${host}: ${slope.toFixed(4)} tokens/char`) + C.dim(`  （原先 ${loadCalibration().hosts[host]?.tokensPerChar ?? "?"}，已写入 calibration.json）\n`),
);
