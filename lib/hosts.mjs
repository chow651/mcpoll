// Host adapters: read each agent's MCP config and write back an on/off decision.
//
// Scope is deliberately narrow — the only thing this tool changes in a host
// config is whether a given MCP server is present. No tool-level filtering, no
// schema rewriting, no proxy process.
//
// Two safety rules, both learned from real configs:
//   1. ADOPT, don't overwrite. A server already present keeps its own env /
//      headers / cwd unless the registry explicitly provides new ones, otherwise
//      a projection silently wipes API keys.
//   2. The registry is not a whitelist. Servers the registry never mentions are
//      left exactly as they are; removal happens only for an explicit mode:"off".

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "..");
import { dataPath } from "./paths.mjs";

function backup(p) {
  if (!existsSync(p)) return null;
  const dir = dataPath(".backups");
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, `${p.replace(/[:\\/]/g, "_")}.${Date.now()}.bak`);
  copyFileSync(p, dst);
  return dst;
}

function readJsonLoose(p) {
  if (!existsSync(p)) return {};
  const raw = readFileSync(p, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return JSON.parse(
      raw
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,(\s*[}\]])/g, "$1"),
    );
  }
}

function writeJson(p, obj) {
  const hadComments = existsSync(p) && /(^|\s)\/\/|\/\*/.test(readFileSync(p, "utf8"));
  const bk = backup(p);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
  return { backup: bk, warn: hadComments ? "comments in source file were dropped" : undefined };
}

function adopt(existing, desired) {
  if (!existing || typeof existing !== "object") return desired;
  const out = { ...desired };
  for (const key of ["env", "headers", "cwd", "timeout", "trust", "startup_timeout_sec"]) {
    if (out[key] === undefined && existing[key] !== undefined) out[key] = existing[key];
  }
  if (out.type === undefined && existing.type !== undefined) out.type = existing.type;
  return out;
}

function nativeEntry(adapterName, def) {
  const isHttp = def.transport === "http";
  switch (adapterName) {
    case "gemini-json":
      return isHttp
        ? { httpUrl: def.url, ...(def.headers ? { headers: def.headers } : {}) }
        : { command: def.command, ...(def.args ? { args: def.args } : {}), ...(def.env ? { env: def.env } : {}) };
    case "codex-toml":
      return isHttp ? { url: def.url } : { command: def.command, ...(def.args ? { args: def.args } : {}), ...(def.env ? { env: def.env } : {}) };
    case "cursor-json":
      return isHttp
        ? { url: def.url, ...(def.headers ? { headers: def.headers } : {}) }
        : { command: def.command, ...(def.args ? { args: def.args } : {}), ...(def.env ? { env: def.env } : {}) };
    default: // claude-json, dsh-yaml
      return isHttp
        ? { type: "http", url: def.url, ...(def.headers ? { headers: def.headers } : {}) }
        : { type: "stdio", command: def.command, ...(def.args ? { args: def.args } : {}), ...(def.env ? { env: def.env } : {}) };
  }
}

// ---- codex TOML: section-level surgery --------------------------------
const TOML_HEADER = /^\[(.+)\]\s*$/gm;

function tomlSections(raw) {
  const marks = [];
  TOML_HEADER.lastIndex = 0;
  let m;
  while ((m = TOML_HEADER.exec(raw))) marks.push({ table: m[1], at: m.index });
  return marks.map((mk, i) => ({ ...mk, text: raw.slice(mk.at, i + 1 < marks.length ? marks[i + 1].at : raw.length) }));
}

function parseTomlEntry(text) {
  const get = (k) => {
    const m = new RegExp(`^${k}\\s*=\\s*(.+)$`, "m").exec(text);
    if (!m) return undefined;
    const v = m[1].trim();
    if (v.startsWith("[")) {
      try {
        return JSON.parse(v.replace(/'/g, '"'));
      } catch {
        return v;
      }
    }
    if (/^".*"$/.test(v)) {
      try {
        return JSON.parse(v);
      } catch {
        return v.slice(1, -1);
      }
    }
    if (/^'.*'$/.test(v)) return v.slice(1, -1);
    return v;
  };
  return { url: get("url"), command: get("command"), args: get("args") };
}

function tomlBlock(name, entry) {
  const L = [`[mcp_servers.${name}]`];
  if (entry.url) L.push(`url = ${JSON.stringify(entry.url)}`);
  if (entry.command) L.push(`command = ${JSON.stringify(entry.command)}`);
  if (entry.args?.length) L.push(`args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`);
  return L.join("\n") + "\n";
}

export const adapters = {
  "claude-json": {
    path: () => join(HOME, ".claude.json"),
    read(p) {
      return { servers: readJsonLoose(p).mcpServers ?? {} };
    },
    apply(p, updates, drops) {
      const d = readJsonLoose(p);
      const s = { ...(d.mcpServers ?? {}) };
      for (const n of drops) delete s[n];
      for (const [n, e] of Object.entries(updates)) s[n] = adopt(s[n], e);
      d.mcpServers = s;
      return writeJson(p, d);
    },
  },

  "cursor-json": {
    path: () => join(HOME, ".cursor", "mcp.json"),
    read(p) {
      return { servers: readJsonLoose(p).mcpServers ?? {} };
    },
    apply(p, updates, drops) {
      const d = readJsonLoose(p);
      const s = { ...(d.mcpServers ?? {}) };
      for (const n of drops) delete s[n];
      for (const [n, e] of Object.entries(updates)) s[n] = adopt(s[n], e);
      d.mcpServers = s;
      return writeJson(p, d);
    },
  },

  "gemini-json": {
    path: () => join(HOME, ".gemini", "settings.json"),
    read(p) {
      return { servers: readJsonLoose(p).mcpServers ?? {} };
    },
    apply(p, updates, drops) {
      const d = readJsonLoose(p);
      const s = { ...(d.mcpServers ?? {}) };
      for (const n of drops) delete s[n];
      for (const [n, e] of Object.entries(updates)) s[n] = adopt(s[n], e);
      d.mcpServers = s;
      return writeJson(p, d);
    },
  },

  "codex-toml": {
    path: () => join(HOME, ".codex", "config.toml"),
    read(p) {
      if (!existsSync(p)) return { servers: {} };
      const raw = readFileSync(p, "utf8");
      const servers = {};
      for (const sec of tomlSections(raw)) {
        const m = /^mcp_servers\.([A-Za-z0-9_-]+)$/.exec(sec.table);
        if (!m) continue; // skip [mcp_servers.x.env] sub-tables and every other table
        servers[m[1]] = { ...parseTomlEntry(sec.text), _raw: sec.text.trim() };
      }
      return { servers };
    },
    apply(p, updates, drops, current) {
      let raw = existsSync(p) ? readFileSync(p, "utf8") : "";
      const bk = backup(p);

      for (const name of drops) {
        const start = raw.indexOf(`[mcp_servers.${name}]`);
        if (start < 0) continue;
        const rest = raw.slice(start + 1);
        const nextHeader = rest.search(/^\[/m);
        const end = nextHeader < 0 ? raw.length : start + 1 + nextHeader;
        raw = raw.slice(0, start) + raw.slice(end);
      }

      for (const [name, entry] of Object.entries(updates)) {
        const block = tomlBlock(name, entry);
        const cur = current?.[name];
        if (cur?._raw) {
          const start = raw.indexOf(cur._raw);
          if (start >= 0) {
            raw = raw.slice(0, start) + block.trim() + raw.slice(start + cur._raw.length);
            continue;
          }
        }
        raw = raw.replace(/\n*$/, "\n\n") + block;
      }

      writeFileSync(p, raw.replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "\n"), "utf8");
      return { backup: bk };
    },
  },

  "dsh-yaml": {
    path: () => join(HOME, ".dsh", "profiles", "desktop", "cordis.patch.yml"),
    read(p) {
      if (!existsSync(p)) return { servers: {} };
      const raw = readFileSync(p, "utf8");
      const servers = {};
      const re = /^-\s+id:\s*(\S+)[\s\S]*?serverName:\s*['"]?([^'"\s]+)/gm;
      let m;
      while ((m = re.exec(raw))) servers[m[2]] = { _id: m[1] };
      return { servers };
    },
    // Plan-only: entries carry !!js tags and profile inheritance, so rewriting a
    // 400-line yml from a JSON projection is riskier than handing over a fragment.
    apply() {
      return { planOnly: true };
    },
  },
};

// ---- projection -------------------------------------------------------
export function project(registry, hostName) {
  const host = registry.hosts[hostName];
  const adapterName = host.adapter;
  const adapter = adapters[adapterName];
  const path = adapter.path();
  let current = {};
  let readError = null;
  try {
    current = adapter.read(path).servers ?? {};
  } catch (e) {
    readError = e.message;
  }

  const updates = {};
  const drops = [];
  const notes = [];

  for (const [serverName, entry] of Object.entries(host.servers ?? {})) {
    const def = registry.servers?.[serverName];
    const mode = entry.mode ?? "off";

    if (mode === "off") {
      if (current[serverName]) drops.push(serverName);
      continue;
    }
    if (mode !== "native") {
      notes.push(`${serverName}: mode "${mode}" is not supported any more — use "native" or "off"`);
      continue;
    }
    if (!def) {
      notes.push(`servers.${serverName} not defined in registry — skipped`);
      continue;
    }
    updates[serverName] = nativeEntry(adapterName, def);
  }

  return { hostName, adapter: adapterName, path, current, updates, drops, notes, readError };
}

export function comparable(entry) {
  if (!entry) return null;
  const keep = ["type", "command", "args", "url", "httpUrl", "env", "headers"];
  const out = {};
  for (const k of keep) if (entry[k] !== undefined) out[k] = entry[k];
  return JSON.stringify(out, Object.keys(out).sort());
}

export function diff(projection) {
  const { current, updates, drops } = projection;
  const add = [];
  const change = [];
  for (const [n, e] of Object.entries(updates)) {
    if (!current[n]) add.push(n);
    else if (comparable(adopt(current[n], e)) !== comparable(current[n])) change.push(n);
  }
  return { add, change, remove: drops };
}
