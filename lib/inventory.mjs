// Inventory: probe a server definition and measure its tool surface.
// Spawns the server, does the MCP handshake, collects tools/list (all pages),
// measures per-tool JSON chars. Cached in .cache/inventory.json by definition hash.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./hosts.mjs";
import { estTokens } from "./usage.mjs";
import { dataPath, ensureParent } from "./paths.mjs";

const CACHE = dataPath(".cache", "inventory.json");
const DEF_TIMEOUT_MS = 90_000;

function hash(obj) {
  return createHash("sha1").update(JSON.stringify(obj)).digest("hex").slice(0, 16);
}

export function loadCache() {
  try {
    return JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(c) {
  ensureParent(CACHE);
  writeFileSync(CACHE, JSON.stringify(c, null, 1), "utf8");
}

// What hosts actually send: {name, description, input_schema|parameters}.
// Everything else (title, outputSchema, annotations, examples) is stripped by the
// MCP SDK / client. Measured: raw rea tools/list = 3.50M chars, normalized = 295k,
// which matches the 295,066 chars observed in a real DSH request header.
export function normalizeTool(t) {
  const out = { name: t.name };
  if (t.description) out.description = t.description;
  const schema = t.inputSchema ?? t.input_schema ?? t.parameters;
  if (schema) out.parameters = schema;
  return out;
}

// Remote (streamable HTTP) servers are probed directly with fetch — no bridge
// process is needed now that the tool has no proxy layer.
async function probeHttp(name, def, timeoutMs) {
  const url = def.url;
  const base = { "content-type": "application/json", accept: "application/json, text/event-stream", ...(def.headers ?? {}) };
  let sessionId = null;
  let protocolVersion = "2025-06-18";

  async function rpc(payload) {
    const h = { ...base };
    if (sessionId) h["mcp-session-id"] = sessionId;
    if (protocolVersion) h["mcp-protocol-version"] = protocolVersion;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method: "POST", headers: h, body: JSON.stringify(payload), signal: ctrl.signal });
      const sid = res.headers.get("mcp-session-id");
      if (sid) sessionId = sid;
      if (res.status === 202 || res.status === 204) return null;
      const ctype = res.headers.get("content-type") ?? "";
      const text = await res.text();
      if (!ctype.includes("text/event-stream")) {
        const msg = JSON.parse(text);
        if (msg.result?.protocolVersion) protocolVersion = msg.result.protocolVersion;
        return msg;
      }
      let found = null;
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const msg = JSON.parse(data);
          if (msg.result?.protocolVersion) protocolVersion = msg.result.protocolVersion;
          if (msg.id === payload.id) found = msg;
        } catch {}
      }
      return found;
    } finally {
      clearTimeout(t);
    }
  }

  const init = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpoll-inventory", version: "1" } },
  });
  if (!init || init.error) return { name, tools: 0, chars: 0, rawChars: 0, tokens: 0, rawTokens: 0, pages: 0, error: init?.error?.message ?? "initialize failed" };

  const tools = [];
  let cursor = null;
  for (let page = 0; page < 50; page++) {
    const r = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: cursor ? { cursor } : {} });
    if (!r || r.error) return { name, tools: tools.length, chars: 0, rawChars: 0, tokens: 0, rawTokens: 0, pages: page, error: r?.error?.message ?? "tools/list failed" };
    tools.push(...(r.result?.tools ?? []));
    cursor = r.result?.nextCursor ?? null;
    if (!cursor) break;
  }

  const rawChars = tools.reduce((n, t) => n + JSON.stringify(t).length, 0);
  const normChars = tools.reduce((n, t) => n + JSON.stringify(normalizeTool(t)).length, 0);
  return {
    name,
    tools: tools.length,
    chars: normChars,
    rawChars,
    tokens: estTokens(normChars),
    rawTokens: estTokens(rawChars),
    pages: 1,
    perTool: tools.map((t) => ({ name: t.name, chars: JSON.stringify(normalizeTool(t)).length, rawChars: JSON.stringify(t).length, descChars: (t.description ?? "").length })),
  };
}

function toCommand(def) {
  return { command: def.command, args: def.args ?? [] };
}

export function probeServer(name, def, { timeoutMs = DEF_TIMEOUT_MS, keepRaw = false } = {}) {
  if (def.transport === "http" || (!def.command && def.url)) return probeHttp(name, def, timeoutMs);
  const { command, args } = toCommand(def);
  if (!command) return Promise.resolve({ name, error: "no command/url" });

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: def.cwd || undefined,
      env: { ...process.env, ...(def.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let buf = "";
    const tools = [];
    let pages = 0;
    let done = false;
    let stderr = "";

    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {}
      const rawChars = tools.reduce((n, t) => n + JSON.stringify(t).length, 0);
      const normChars = tools.reduce((n, t) => n + JSON.stringify(normalizeTool(t)).length, 0);
      resolve({
        name,
        tools: tools.length,
        chars: normChars,
        rawChars,
        tokens: estTokens(normChars),
        rawTokens: estTokens(rawChars),
        pages,
        error: error ?? (tools.length ? undefined : "no tools returned"),
        rawTools: keepRaw ? tools : undefined,
        perTool: tools.map((t) => ({
          name: t.name,
          chars: JSON.stringify(normalizeTool(t)).length,
          rawChars: JSON.stringify(t).length,
          descChars: (t.description ?? "").length,
        })),
      });
    };

    const timer = setTimeout(() => finish("timeout"), timeoutMs);

    const send = (o) => {
      try {
        child.stdin.write(JSON.stringify(o) + "\n");
      } catch {}
    };

    child.stdout.on("data", (c) => {
      buf += c.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1 && m.result) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (m.id === 2) {
          if (m.error) return finish(m.error.message);
          tools.push(...(m.result?.tools ?? []));
          pages++;
          if (m.result?.nextCursor && pages < 50) {
            send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { cursor: m.result.nextCursor } });
          } else {
            finish();
          }
        }
      }
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (e) => finish(e.message));
    child.on("exit", (code) => {
      if (!done && !tools.length) finish(stderr.trim().split("\n").pop() || `exit ${code}`);
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpoll-inventory", version: "1" } },
    });
  });
}

export async function inventory(registry, { refresh = false, only = null } = {}) {
  const cache = loadCache();
  const out = {};
  for (const [name, def] of Object.entries(registry.servers ?? {})) {
    if (only && name !== only) continue;
    const key = `${name}:${hash(def)}`;
    if (!refresh && cache[key]) {
      out[name] = { ...cache[key], cached: true };
      continue;
    }
    process.stderr.write(`[inventory] probing ${name} … `);
    const r = await probeServer(name, def);
    process.stderr.write(`${r.tools ?? 0} tools, ${r.chars ?? 0} chars${r.error ? ` (${r.error})` : ""}\n`);
    out[name] = r;
    cache[key] = r;
  }
  saveCache(cache);
  return out;
}
