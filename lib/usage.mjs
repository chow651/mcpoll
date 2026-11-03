// Session-log accounting: what did MCP actually cost, and was it used?
//
// Three sources, in decreasing order of fidelity:
//   claude-jsonl : ~/.claude/projects/<slug>/<session>.jsonl
//                  has `api-request-shape` = the real {system,tools} payload that
//                  was sent. Ground truth for context tax, no probing needed.
//   codex-jsonl  : ~/.codex/sessions/**.jsonl  (rollout format, function_call items)
//   dsh-jsonl    : ~/.dsh/sessions/**/session.v4.jsonl.zstd
//
// We measure per host:
//   perServer[server].schemaChars   -> from request shape (claude) or probe
//   perServer[server].calls         -> from tool_use / function_call names
//   sessions                        -> number of sessions where it was installed

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { zstdDecompressSync } from "node:zlib";

const HOME = homedir();

// DSH-calibrated: tokens ≈ chars × 0.2293 (measured against real inputTokens).
export const TOK_PER_CHAR = 0.2293;
export const estTokens = (chars) => Math.round(chars * TOK_PER_CHAR);

function* walk(dir, filter, max = Infinity) {
  if (!existsSync(dir)) return;
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".git") continue;
        stack.push(p);
      } else if (filter(p)) {
        yield p;
        if (++n >= max) return;
      }
    }
  }
}

function* lines(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) if (line) yield line;
}

function parseMcpToolName(name) {
  // mcp__<server>__<tool>  (also mcp__plugin_<x>_<y>__tool forms)
  if (!name?.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  const i = rest.lastIndexOf("__");
  if (i < 0) return null;
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

function bump(map, key, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

// ---------------- claude code ----------------
// Per session we take the LARGEST shape (the full tool set) and record per-server
// schema chars. Aggregation happens later over sessions, so numbers are
// "tokens per session", not cumulative.
export function scanClaude() {
  const root = join(HOME, ".claude", "projects");
  const out = {
    host: "claude-code",
    sessions: 0,
    sessionsWithTools: 0,
    inputTokens: 0,
    calls: {},
    perSession: [], // { file, sessionId, toolsCount, toolsChars, servers: {name: chars}, calls: {server__tool: n} }
  };
  const files = [...walk(root, (p) => p.endsWith(".jsonl"))];

  for (const file of files) {
    const shapes = new Map(); // shapeHash -> {chars, servers, toolsCount}
    const calls = {};
    const headerChars = {};
    let headerCount = 0;
    let tokens = 0;
    let requestCount = 0;
    let fresh = 0;
    let cached = 0;
    let output = 0;
    let firstTs = null;
    let lastTs = null;
    let sessionId = basename(file, ".jsonl");

    for (const line of lines(file)) {
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d.sessionId) sessionId = d.sessionId;
      if (d.type === "api-request-shape" && d.shape?.tools) {
        const tools = d.shape.tools;
        const servers = {};
        for (const t of tools) {
          const name = t.name ?? t.function?.name ?? "";
          const m = parseMcpToolName(name);
          if (m) servers[m.server] = (servers[m.server] ?? 0) + JSON.stringify(t).length;
        }
        const chars = JSON.stringify(tools).length;
        const prev = shapes.get(d.shapeHash);
        if (!prev || chars > prev.chars) shapes.set(d.shapeHash, { chars, servers, toolsCount: tools.length });
        headerCount++;
        for (const [sv, sc] of Object.entries(servers)) (headerChars[sv] ??= []).push(sc);
      }
      const msg = d.message;
      if (msg?.usage) {
        const fu = msg.usage.input_tokens || 0;
        const cu = msg.usage.cache_read_input_tokens || 0;
        if (fu || cu) {
          requestCount++;
          fresh += fu;
          cached += cu;
          output += msg.usage.output_tokens || 0;
        }
      }
      if (d.timestamp) {
        firstTs = firstTs ?? d.timestamp;
        lastTs = d.timestamp;
      }
      if (Array.isArray(msg?.content)) {
        for (const c of msg.content) {
          if (c?.type === "tool_use" && c.name) {
            const m = parseMcpToolName(c.name);
            if (m) bump(calls, `${m.server}__${m.tool}`);
          }
        }
      }
    }

    let best = null;
    for (const v of shapes.values()) if (!best || v.chars > best.chars) best = v;
    if (best) out.sessionsWithTools++;
    if (best || Object.keys(calls).length) {
      out.sessions++;
      out.inputTokens += tokens;
      for (const [k2, v2] of Object.entries(calls)) bump(out.calls, k2, v2);
      out.perSession.push({
        sessionId,
        toolsCount: best?.toolsCount ?? 0,
        toolsChars: best?.chars ?? 0,
        servers: best?.servers ?? {},
        headerServerChars: headerChars, // server -> [chars per observed header]
        headerCount: headerCount,
        requests: requestCount,
        fresh,
        cached,
        output,
        start: firstTs,
        end: lastTs,
        calls,
      });
    }
  }
  return out;
}

// ---------------- codex ----------------
export function scanCodex() {
  const root = join(HOME, ".codex", "sessions");
  const out = { host: "codex", sessions: 0, calls: {}, inputTokens: 0, perSession: [] };

  for (const file of walk(root, (p) => p.endsWith(".jsonl"))) {
    const calls = {};
    let requests = 0;
    let fresh = 0;
    let cached = 0;
    let ctx = 0;
    let output = 0;
    let firstTs = null;
    let lastTs = null;
    const models = new Set();

    for (const line of lines(file)) {
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const p = d.payload;
      if (!p) continue;

      // every model response carries a usage record: this is real consumption
      if (d.timestamp) {
        firstTs = firstTs ?? d.timestamp;
        lastTs = d.timestamp;
      }
      if (d.type === "turn_context" && p.model) models.add(p.model);
      if (d.type === "token_usage_record" || d.type === "token_count") {
        const u = p.usage ?? p.info?.usage ?? null;
        if (u && typeof u.input_tokens === "number") {
          requests++;
          ctx += u.input_tokens;
          cached += u.cached_input_tokens ?? 0;
          fresh += Math.max(0, u.input_tokens - (u.cached_input_tokens ?? 0));
          output += u.output_tokens ?? 0;
        }
      }
      if (d.type === "response_item" && p.type === "function_call" && p.name) bump(calls, p.name);
    }

    out.inputTokens += ctx;
    if (requests || Object.keys(calls).length) {
      out.sessions++;
      for (const [k, v] of Object.entries(calls)) bump(out.calls, k, v);
      out.perSession.push({
        sessionId: basename(file),
        toolsCount: 0,
        toolsChars: 0,
        servers: {},            // codex 的 rollout 不记录工具定义，无法归因到 MCP
        headerServerChars: {},
        headerCount: 0,
        requests,
        fresh,
        cached,
        output,
        start: firstTs,
        end: lastTs,
        models: [...models],
        calls,
      });
    }
  }
  return out;
}

// ---------------- dsh ----------------
// session.v4.jsonl.zstd is a series of concatenated zstd frames (one per append).
// node:zlib stops after the first frame, so split on the frame magic first.
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export function decompressDshFrames(buf) {
  const offsets = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) offsets.push(i);
  }
  if (!offsets.length) return "";
  let out = "";
  for (let j = 0; j < offsets.length; j++) {
    const seg = buf.subarray(offsets[j], j + 1 < offsets.length ? offsets[j + 1] : buf.length);
    try {
      out += zstdDecompressSync(seg).toString("utf8");
    } catch {}
  }
  return out;
}

export function scanDsh() {
  const root = join(HOME, ".dsh", "sessions");
  const out = { host: "dsh", sessions: 0, sessionsWithTools: 0, inputTokens: 0, calls: {}, perSession: [] };

  for (const file of walk(root, (p) => p.endsWith(".zstd") || p.endsWith(".jsonl"))) {
    let text;
    try {
      const buf = readFileSync(file);
      text = file.endsWith(".zstd") ? decompressDshFrames(buf) : buf.toString("utf8");
    } catch {
      continue;
    }
    if (!text) continue;

    const shapes = new Map(); // shapeKey -> { chars, servers, toolsCount }
    const headerChars = {}; // server -> [chars per observed header]
    const calls = {};
    let headerCount = 0;
    let requestCount = 0;
    let fresh = 0;
    let cached = 0;
    let output = 0;
    let firstTs = null;
    let lastTs = null;
    let tokens = 0;

    for (const line of text.split("\n")) {
      if (!line) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }

      if (d.type === "request/header") {
        // ground truth: the exact tools array sent to the model
        const tools = d.data?.header?.tools;
        if (Array.isArray(tools)) {
          const servers = {};
          for (const t of tools) {
            const m = parseMcpToolName(t.name ?? "");
            if (m) servers[m.server] = (servers[m.server] ?? 0) + JSON.stringify(t).length;
          }
          const chars = JSON.stringify(tools).length;
          const key = `${servers && Object.keys(servers).sort().join(",")}:${chars}`;
          if (!shapes.has(key)) shapes.set(key, { chars, servers, toolsCount: tools.length });
          headerCount++;
          for (const [sv, sc] of Object.entries(servers)) (headerChars[sv] ??= []).push(sc);
        }
      } else if (d.type === "assistant/message" && d.data?.usage) {
        const u = d.data.usage;
        const fu = u.inputTokens || 0;
        const cu = u.cacheReadTokens || 0;
        if (fu || cu) {
          requestCount++;
          fresh += fu;
          cached += cu;
          output += u.outputTokens || 0;
        }
      } else if (d.type === "tool/call") {
        const m = parseMcpToolName(d.data?.name ?? "");
        if (m) bump(calls, `${m.server}__${m.tool}`);
      }

      if (d.time) {
        firstTs = firstTs ?? d.time;
        lastTs = d.time;
      }

      // usage records
      const u = d.data?.usage ?? d.usage;
      if (u?.inputTokens) tokens += u.inputTokens;
      else if (d.type === "step/end" && d.data?.usage?.inputTokens) tokens += d.data.usage.inputTokens;
    }

    let best = null;
    for (const v of shapes.values()) if (!best || v.chars > best.chars) best = v;
    if (best) out.sessionsWithTools++;
    if (best || Object.keys(calls).length) {
      out.sessions++;
      out.inputTokens += tokens;
      for (const [k2, v2] of Object.entries(calls)) bump(out.calls, k2, v2);
      out.perSession.push({
        sessionId: basename(file),
        toolsCount: best?.toolsCount ?? 0,
        toolsChars: best?.chars ?? 0,
        servers: best?.servers ?? {},
        headerServerChars: headerChars,
        headerCount,
        requests: requestCount,
        fresh,
        cached,
        output,
        start: firstTs,
        end: lastTs,
        calls,
      });
    }
  }
  return out;
}

export function scanAll() {
  return [scanClaude(), scanCodex(), scanDsh()];
}

// ---------------- inventory (probe one server's schema size) ----------------
export const __internals = { walk, lines, parseMcpToolName, basename, statSync };
