// Who else owns these agent config files?
//
// magpie's Library installs MCP servers from its market and syncs them into every
// agent the user ticks. Those servers are magpie's to write; flipping one from
// here would be undone on its next sync. Servers that are *not* in the Library
// (hand-written `mcpServers` entries, other tools' configs) are nobody else's,
// and this app is free to write them.
//
// Read only. If there is no magpie on the machine, everything is free to write.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** where magpie keeps its library, override with MCPOLL_MAGPIE_CONFIG */
export function libraryPath() {
  if (process.env.MCPOLL_MAGPIE_CONFIG) return process.env.MCPOLL_MAGPIE_CONFIG;
  return join(homedir(), ".config", "magpie", "library.json");
}

// magpie names agents in its own vocabulary; map the ones we know
const HOST_ALIAS = {
  claude: "claude-code",
  codex: "codex",
  gemini: "gemini",
  cursor: "cursor",
  dsh: "dsh",
};

const hostOf = (agentId) => HOST_ALIAS[agentId] ?? agentId;

/**
 * @returns {{present: boolean, path: string, owners: Record<string, string[]>, routers: boolean}}
 *          owners: host → servers magpie syncs into it
 */
export function magpieLibrary() {
  const path = libraryPath();
  const none = { present: false, path, owners: {}, routers: false };
  if (!existsSync(path)) return none;

  let doc;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ...none, present: true };
  }

  const servers = Array.isArray(doc?.mcp) ? doc.mcp : [];
  const owners = {};
  for (const s of servers) {
    const name = typeof s?.name === "string" ? s.name : null;
    if (!name) continue;
    const agents = Array.isArray(s.agents) ? s.agents : [];
    for (const a of agents) {
      const host = hostOf(String(a));
      (owners[host] ??= []).push(name);
    }
  }
  for (const k of Object.keys(owners)) owners[k] = [...new Set(owners[k])].sort();

  return { present: true, path, owners, routers: Boolean(doc?.mcpHub) };
}

/** does magpie sync this server into this host? */
export function magpieOwns(host, server, lib = magpieLibrary()) {
  return (lib.owners?.[host] ?? []).includes(server);
}
