// Per-host tokenisation calibration.
//
// The chars→tokens ratio is a property of the *host's* tokeniser, not of this
// tool: DeepSeek, Anthropic and OpenAI split text differently. One global
// constant would quietly mis-price every host except the one it was measured on.
//
// `measured` means we ran a fake MCP server with known schema sizes against that
// host and fitted the slope from real inputTokens. `estimated` is a documented
// heuristic and must be labelled as such in the UI.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./hosts.mjs";
import { dataPath, seed } from "./paths.mjs";

const FILE = seed(dataPath("calibration.json"), "calibration.example.json");

// regime decides how a host is charged:
//   inline   → the full tool schema rides in every request: cost = chars × tokensPerChar
//   deferred → the host sends only names / a placeholder: cost = toolCount × tokensPerTool
const DEFAULTS = {
  dsh: {
    regime: "inline",
    tokensPerChar: 0.2293,
    source: "measured",
    method: "假 MCP server，5 个尺寸（4k–243k 字符），对真实 inputTokens 拟合",
  },
  "claude-code": {
    regime: "deferred",
    tokensPerChar: 0.026,
    tokensPerTool: 10.5,
    source: "measured",
    method: "实测：MCP 工具被延迟加载，schema 不进 prompt；约 10.5 token/工具名",
  },
  // 这三个宿主的本地日志里没有工具定义，也没有可用的 token 记录 ——
  // 与其编一个系数，不如明确说不计价。
  codex: { regime: "unknown", tokensPerChar: null, source: "none", method: "rollout 里 tools 为空数组，无法计价（只统计调用次数）" },
  gemini: { regime: "unknown", tokensPerChar: null, source: "none", method: "没有会话日志" },
  cursor: { regime: "unknown", tokensPerChar: null, source: "none", method: "没有会话日志" },
};

export function loadCalibration() {
  let disk = {};
  try {
    disk = JSON.parse(readFileSync(FILE, "utf8")).hosts ?? {};
  } catch {}
  const hosts = {};
  for (const [h, d] of Object.entries(DEFAULTS)) hosts[h] = { ...d, ...(disk[h] ?? {}) };
  for (const [h, v] of Object.entries(disk)) if (!hosts[h]) hosts[h] = v;
  return { hosts };
}

export function saveCalibration(next) {
  const current = loadCalibration();
  const hosts = { ...current.hosts, ...(next.hosts ?? {}) };
  writeFileSync(FILE, JSON.stringify({ hosts }, null, 2) + "\n", "utf8");
  return { hosts };
}

export function factorFor(host) {
  const c = loadCalibration().hosts[host];
  return c?.tokensPerChar ?? null; // null = 这个宿主不可计价
}

export function priced(host) {
  const c = loadCalibration().hosts[host];
  return typeof c?.tokensPerChar === "number";
}

export function costModelFor(host) {
  const c = loadCalibration().hosts[host] ?? {};
  return {
    regime: c.regime ?? "inline",
    tokensPerChar: c.tokensPerChar ?? null,
    tokensPerTool: c.tokensPerTool ?? null,
    source: c.source ?? "estimated",
    method: c.method ?? "",
  };
}

export function provenanceFor(host) {
  const c = loadCalibration().hosts[host];
  return { tokensPerChar: c?.tokensPerChar ?? null, source: c?.source ?? "none", method: c?.method ?? "" };
}

export function setFactor(host, tokensPerChar, { source = "manual", method = "手动设置" } = {}) {
  const n = Number(tokensPerChar);
  if (!Number.isFinite(n) || n <= 0.05 || n >= 2) throw Object.assign(new Error("系数应在 0.05–2 之间"), { status: 400 });
  const current = loadCalibration();
  current.hosts[host] = { tokensPerChar: n, source, method };
  return saveCalibration(current);
}

export const CALIBRATION_FILE = FILE;
export const calibrationExists = () => existsSync(FILE);
