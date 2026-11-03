// Read-only view of the local magpie gateway's own audit.
//
// mcpoll parses agent session logs, so it can only price hosts that write usable
// logs. The gateway sits in front of the models instead: it sees every request,
// gets the provider's real usage back, and knows the price table. That makes it
// the only place a *complete* bill exists.
//
// What it gives us: calls / input / cache / output / money per client, plus an
// honest `unpriced` counter for models it has no price for.
// What it does not give us: the request's tool definitions, so the bill cannot be
// split per MCP server. That needs a gateway plugin, not a log parser.

const DEFAULT_BASE = process.env.MAGPIE_URL ?? "http://127.0.0.1:3425";

// gateway client ids → mcpoll host names (anything else keeps its own id)
const HOST_ALIAS = {
  claude: "claude-code",
  codex: "codex",
  dsh: "dsh",
  gemini: "gemini",
  cursor: "cursor",
  agy: "antigravity",
};

const hostOf = (agentId) => HOST_ALIAS[agentId] ?? agentId;

async function getJSON(base, path, timeoutMs = 15_000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, { signal: ctl.signal });
    if (!res.ok) throw Object.assign(new Error(`gateway ${res.status} on ${path}`), { status: res.status });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Is a gateway listening, and what is it? */
export async function probe(base = DEFAULT_BASE) {
  try {
    const root = await getJSON(base, "/", 4000);
    return { up: true, base, name: root.name ?? "magpie", version: root.version ?? null, pid: root.pid ?? null };
  } catch {
    return { up: false, base, error: "no gateway on " + base };
  }
}

/**
 * Per-client totals for a period: the complete bill, as far as the gateway knows.
 * `unpriced` is the number of calls whose model has no price — reported, not guessed.
 */
export async function usageByAgent({ base = DEFAULT_BASE, period = "30d" } = {}) {
  const d = await getJSON(base, `/v1/magpie/usage?by=agent&period=${encodeURIComponent(period)}`);
  const rows = (d.agents ?? []).map((a) => ({
    host: hostOf(a.id),
    agent: a.id,
    agentName: a.name ?? a.id,
    calls: a.calls ?? 0,
    input: a.input ?? 0,
    cacheRead: a.cache_read ?? 0,
    cacheWrite: a.cache_write ?? 0,
    output: a.output ?? 0,
    reasoning: a.reasoning ?? 0,
    cost: a.cost ?? 0,
    unpriced: a.unpriced ?? 0,
    credits: a.credits ?? 0,
  }));
  rows.sort((x, y) => y.cost - x.cost || y.calls - x.calls);
  return {
    period: d.period ?? period,
    since: d.since ?? null,
    totals: {
      calls: d.calls ?? 0,
      input: d.input ?? 0,
      cacheRead: d.cache_read ?? 0,
      output: d.output ?? 0,
      cost: d.cost ?? 0,
      unpriced: d.unpriced ?? 0,
    },
    rows,
  };
}

/**
 * Recent requests. Only used to check that a given client really goes through the
 * gateway, and to look at what one request costs.
 */
export async function recentRequests({ base = DEFAULT_BASE, agent = null, limit = 20 } = {}) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (agent) q.set("agent", agent);
  const d = await getJSON(base, `/v1/magpie/usage/requests?${q}`);
  return (d.rows ?? []).map((r) => ({
    t: r.t,
    host: hostOf(r.agent),
    agent: r.agent,
    model: r.served ?? r.model,
    endpoint: r.ep,
    input: r.in ?? 0,
    cacheRead: r.cache_read ?? 0,
    cacheWrite: r.cache_write ?? 0,
    output: r.out ?? 0,
    reasoning: r.reasoning ?? 0,
    cost: r.cost ?? null,
    priced: Boolean(r.priced),
  }));
}

/** Read a local agent's price table straight out of the gateway's model list. */
export async function priceTable({ base = DEFAULT_BASE } = {}) {
  const d = await getJSON(base, "/v1/models");
  const out = {};
  for (const m of d.data ?? []) {
    if (!m?.id || !m.pricing) continue;
    out[m.id] = {
      input: Number(m.pricing.input ?? 0),
      output: Number(m.pricing.completion ?? 0),
      cacheRead: Number(m.pricing.input_cache_read ?? 0),
      context: m.context_length ?? m.context_window ?? null,
    };
  }
  return out;
}
