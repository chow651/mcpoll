// mcpoll panel — plain DOM, no framework, no build step.
//
// Interaction model: settings-page semantics. Flipping a switch edits a local
// draft and takes effect on screen immediately; a bar offers 保存 / 取消; saving
// posts the whole batch in one request. Nothing goes to disk until you save.

const $ = (s) => document.querySelector(s);

let S = null;            // server state for the active host
let activeHost = null;
let openRow = null;
let selected = -1;
let query = "";
let draft = new Map();   // "host|server" -> mode
let busy = false;
let GW = null;            // local gateway audit (money per client), if one is running
let settings = { theme: "system", density: "cozy" };
let lastSave = [];

const fmt = (n) =>
  n == null ? "—" : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pctText = (n, d) => {
  if (!d) return "—";
  const v = (n / d) * 100;
  if (v > 0 && v < 1) return "<1%";
  return `${Math.round(v)}%`;
};
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const key = (host, server) => `${host}|${server}`;

// each host tokenises differently — never borrow another host's factor
const calOf = (host) => S?.calibration?.hosts?.[host] ?? { tokensPerChar: null, source: "none", method: "" };
const factorOf = (host) => calOf(host).tokensPerChar;
const toTok = (chars, host) => {
  const f = factorOf(host);
  return f == null ? null : Math.round((chars ?? 0) * f);
};
const priceable = (host) => factorOf(host) != null;

const REFRESH_GLYPH =
  '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7" /><path d="M13.4 2.6v3.2H10.2" /></svg>';

// ── settings ──────────────────────────────────────────────────
function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(localStorage.getItem("mcpoll.settings") || "{}") };
  } catch {}
}
function applySettings() {
  const dark = settings.theme === "dark" || (settings.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.density = settings.density;
  localStorage.setItem("mcpoll.settings", JSON.stringify(settings));
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (settings.theme === "system") applySettings();
});

// ── api ───────────────────────────────────────────────────────
async function loadGateway() {
  try {
    const g = await api("/api/gateway");
    GW = g?.up ? g : null;
  } catch {
    GW = null;
  }
  renderKpis();
}

const gwRow = (host) => GW?.usage?.rows?.find((r) => r.host === host) ?? null;

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const hostOf = (name) => S?.hosts.find((h) => h.name === name);
const usageOf = (name) => S?.usage[name] ?? null;

function effectiveMode(host, server) {
  const k = key(host, server);
  if (draft.has(k)) return draft.get(k);
  return hostOf(host)?.modes?.[server] ?? "off";
}

function rowData(hostName, server) {
  const u = usageOf(hostName);
  const m = u?.perServer?.[server];
  const inv = S.servers[server];
  return {
    server,
    mode: effectiveMode(hostName, server),
    savedMode: hostOf(hostName)?.modes?.[server] ?? "off",
    perReq: m?.perReq ?? (inv?.chars != null ? toTok(inv.chars, hostName) : null),
    calls: m?.calls ?? 0,
    requests: m?.requests ?? 0,
    occupancy: m?.occupancy ?? 0,
    tools: inv?.tools ?? null,
    chars: inv?.chars ?? null,
    transport: inv?.transport ?? null,
    seenInLogs: Boolean(m),
  };
}

function hostStats(hostName) {
  const u = usageOf(hostName);
  const rows = [...new Set([...Object.keys(hostOf(hostName)?.modes ?? {}), ...Object.keys(u?.perServer ?? {})])]
    .map((s) => rowData(hostName, s))
    .sort((a, b) => (b.perReq ?? -1) - (a.perReq ?? -1));
  const live = rows.filter((r) => r.mode !== "off" && r.perReq != null);
  const dead = live.filter((r) => !r.calls && (r.perReq ?? 0) >= 100);
  return {
    rows,
    dead,
    tax: live.reduce((n, r) => n + (r.perReq ?? 0), 0),
    deadTokens: dead.reduce((n, r) => n + r.perReq, 0),
    avgCtx: u?.avgCtx ?? 0,
    requests: u?.requests ?? 0,
    sessions: u?.sessions ?? 0,
  };
}

const visibleRows = () => hostStats(activeHost).rows.filter((r) => !query || r.server.toLowerCase().includes(query));

// ── small ui helpers ──────────────────────────────────────────
let toastTimer = null;
function toast(text, { action = null, actionLabel = "", ms = 2600 } = {}) {
  const el = $("#toast");
  $("#toast-text").textContent = text;
  const btn = $("#toast-action");
  btn.hidden = !action;
  if (action) {
    btn.textContent = actionLabel;
    btn.onclick = () => {
      hideToast();
      action();
    };
  }
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() {
  $("#toast").classList.remove("show");
}

function countTo(el, to, duration = 320) {
  const from = Number(el.dataset.value ?? 0);
  el.dataset.value = String(to);
  if (from === to) {
    el.textContent = fmt(to);
    return;
  }
  const t0 = performance.now();
  let done = false;
  const settle = () => {
    if (done) return;
    done = true;
    el.textContent = fmt(to);
  };
  const tick = (t) => {
    if (done) return;
    const k = Math.min(1, (t - t0) / duration);
    el.textContent = fmt(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3))));
    if (k < 1) requestAnimationFrame(tick);
    else settle();
  };
  requestAnimationFrame(tick);
  setTimeout(settle, duration + 120);
}

// ── render ────────────────────────────────────────────────────
function renderRail() {
  const rail = $("#rail");
  rail.querySelectorAll(".host").forEach((n) => n.remove());
  const maxTax = Math.max(1, ...S.hosts.map((h) => hostStats(h.name).tax));
  for (const h of S.hosts) {
    const st = hostStats(h.name);
    const b = document.createElement("button");
    b.className = `host${h.name === activeHost ? " on" : ""}`;
    b.innerHTML =
      `<span class="hname">${esc(h.name)}</span><span class="htax">${priceable(h.name) ? fmt(st.tax) : "—"}</span>` +
      `<span class="hbar"><i style="width:${priceable(h.name) ? Math.max(3, (st.tax / maxTax) * 100) : 0}%"></i></span>`;
    b.onclick = () => switchHost(h.name);
    rail.appendChild(b);
  }
}

function renderKpis() {
  const st = hostStats(activeHost);
  const u = usageOf(activeHost);
  const priced = priceable(activeHost);
  const share = st.avgCtx && priced ? pctText(st.tax, st.avgCtx) : null;

  // Two kinds of numbers only: MCP cost where the host's log lets us price it,
  // and raw MCP call counts everywhere. Nothing is estimated to fill a gap.
  const cells = [];
  if (priced) {
    cells.push({ label: "MCP 固定开销 / 请求", to: st.tax, note: share != null ? `占该请求窗口 ${share}` : "未采集到请求头" });
    cells.push({ label: "零调用占用", to: st.deadTokens, note: st.dead.length ? `${st.dead.map((r) => r.server).join(" / ")} · 已开启但日志里 0 次调用` : "已开启的 server 都有调用", cls: st.deadTokens ? "danger" : "" });
    cells.push({ label: "可释放", to: st.deadTokens * st.requests, note: "关掉后累计省下的上下文", cls: st.deadTokens ? "good" : "" });
  }
  const g = gwRow(activeHost);
  if (g && g.calls) {
    const unp = g.calls ? Math.round((g.unpriced / g.calls) * 100) : 0;
    cells.push({
      label: "网关实测花费 / 30 天",
      text: `$${g.cost.toFixed(2)}`,
      note: `${g.calls.toLocaleString("en-US")} 次调用 · magpie 审计`,
    });
    if (g.unpriced) {
      cells.push({
        label: "其中无价格的调用",
        to: g.unpriced,
        note: `${unp}% 的调用所用的模型没有价目，只计入调用数`,
        cls: "danger",
      });
    }
  }

  if (!cells.length) {
    // Nothing here can be measured, so there is nothing to show above the table.
    $("#kpis").hidden = true;
    $("#kpis").innerHTML = "";
    return;
  }
  $("#kpis").hidden = false;

  const box = $("#kpis");
  if (box.children.length !== cells.length || box.dataset.sig !== cells.map((c) => c.label).join("|")) {
    box.dataset.sig = cells.map((c) => c.label).join("|");
    box.innerHTML = cells.map((c) => `<div class="kpi"><label>${c.label}</label><b data-value="0">0</b><span></span></div>`).join("");
  }
  [...box.children].forEach((node, i) => {
    const c = cells[i];
    node.className = `kpi ${c.cls ?? ""}`;
    node.querySelector("span").textContent = c.note;
    const b = node.querySelector("b");
    if (c.text != null) {
      b.textContent = c.text;
    } else if (c.mono) {
      b.dataset.value = String(c.to);
      b.textContent = fmt(c.to);
    } else countTo(b, c.to);
  });
}

function renderNote() {
  const st = hostStats(activeHost);
  const el = $("#note");
  if (!st.dead.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML =
    `<span class="grow"><strong>${esc(st.dead.map((r) => r.server).join("、"))}</strong> 在 ${st.sessions} 个会话里一次都没被调用，` +
    `但每次请求仍占 ${fmt(st.deadTokens)} tokens。</span><button class="btn" id="note-off">全部关闭</button>`;
  $("#note-off").onclick = () => {
    for (const r of st.dead) draft.set(key(activeHost, r.server), "off");
    render();
  };
}

function segHtml(server, mode) {
  const off = mode === "off";
  const dirty = draft.has(key(activeHost, server));
  return `<div class="seg" data-mode="${off ? "off" : "on"}" data-server="${esc(server)}"${dirty ? ' data-dirty="1"' : ""}>
    <span class="seg-thumb"></span>
    <button data-m="native" class="${off ? "" : "on"}">开启</button>
    <button data-m="off" class="${off ? "on" : ""}">关闭</button>
  </div>`;
}

function renderRows() {
  const st = hostStats(activeHost);
  const u = usageOf(activeHost);
  const rows = visibleRows();
  const box = $("#rows");
  const priced = priceable(activeHost);
  const hasLog = !!(u && (u.sessions || u.requests));
  const board = document.querySelector(".board");
  board.classList.toggle("nopricing", !priced);
  document.querySelector(".board-head").innerHTML = priced
    ? `<span>Server</span><span class="h-num">每次请求</span><span>占该宿主请求</span><span class="h-num">请求数</span><span class="h-num">调用</span><span class="h-num">累计占用</span><span style="text-align:right">暴露</span>`
    : `<span>Server</span><span class="h-num">调用</span><span style="text-align:right">暴露</span>`;
  $("#count").textContent = query ? `${rows.length} / ${st.rows.length}` : `${st.rows.length} 个 server`;

  if (!rows.length) {
    box.innerHTML = st.rows.length
      ? `<div class="empty">没有匹配 “${esc(query)}” 的 server。</div>`
      : `<div class="empty">这个宿主还没有 MCP 数据。确认它在 registry.json 里，并且会话日志存在。</div>`;
    return;
  }
  if (selected >= rows.length) selected = rows.length - 1;
  const maxReq = Math.max(1, ...rows.map((r) => r.perReq ?? 0));
  box.innerHTML = rows
    .map((r, i) => {
      const off = r.mode === "off";
      const waste = !off && !r.calls && (r.perReq ?? 0) >= 100;
      const share = !off && u?.avgCtx && r.perReq != null ? pct(r.perReq, u.avgCtx) : null;
      const tone = waste ? "bad" : off ? "" : r.calls ? "ok" : "";
      const nameCell = `<div class="r-name"><i class="dot ${tone}"></i><span title="${esc(r.server)}">${esc(r.server)}</span>${off ? '<span class="tag">off</span>' : ""}</div>`;
      const segCell = segHtml(r.server, r.mode);
      if (!priced) {
        return `<div class="row${off ? " off" : ""}${i === selected ? " sel" : ""}" data-server="${esc(r.server)}">
          ${nameCell}
          <div class="r-num${r.calls ? "" : " zero"}">${hasLog ? r.calls : "—"}</div>
          ${segCell}
        </div>`;
      }
      return `<div class="row${off ? " off" : ""}${i === selected ? " sel" : ""}" data-server="${esc(r.server)}">
        ${nameCell}
        <div class="r-num ${off ? "zero" : "strong"}" title="${r.perReq == null ? "未探测到 schema" : r.perReq + " tokens"}">${r.perReq == null ? "—" : fmt(r.perReq)}</div>
        <div class="share">${
          share == null
            ? '<div class="track"></div><em>—</em>'
            : `<div class="track"><i class="${waste ? "bad" : ""}" style="width:${Math.max(3, (r.perReq / maxReq) * 100)}%"></i></div><em>${pctText(r.perReq, u.avgCtx)}</em>`
        }</div>
        <div class="r-num${r.requests ? "" : " zero"}">${r.requests || "—"}</div>
        <div class="r-num${r.calls ? "" : " zero"}">${r.calls}</div>
        <div class="r-num">${r.occupancy ? fmt(r.occupancy) : "—"}</div>
        ${segCell}
      </div>`;
    })
    .join("");

  for (const el of box.querySelectorAll(".seg")) {
    el.onclick = (ev) => {
      const btn = ev.target.closest("button[data-m]");
      if (!btn) return;
      ev.stopPropagation();
      const server = el.dataset.server;
      const mode = btn.dataset.m;
      const saved = hostOf(activeHost)?.modes?.[server] ?? "off";
      if (mode === saved) draft.delete(key(activeHost, server));
      else draft.set(key(activeHost, server), mode);
      render();
    };
  }
  for (const el of box.querySelectorAll(".row")) {
    el.onclick = () => {
      selected = rows.findIndex((r) => r.server === el.dataset.server);
      if (priced) togglePeek(el.dataset.server);
      else renderRows();
    };
  }
}

function renderSaveBar() {
  const bar = $("#savebar");
  if (!draft.size) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  $("#save-count").textContent = String(draft.size);
}

function renderPeek(server) {
  const r = rowData(activeHost, server);
  const u = usageOf(activeHost);
  const share = r.mode === "off" || !u?.avgCtx ? null : pctText(r.perReq, u.avgCtx);
  $("#peek-name").textContent = server;
  const f = factorOf(activeHost);
  $("#peek-sub").textContent = [r.transport ?? "未在 registry 登记", r.tools != null ? `${r.tools} 个工具` : null, r.chars != null ? `${fmt(toTok(r.chars, activeHost))} tok 全量` : null]
    .filter(Boolean)
    .join(" · ");

  const perTool = (S.servers[server]?.perTool ?? [])
    .map((t) => ({ ...t, tokens: toTok(t.chars, activeHost) }))
    .sort((a, b) => b.tokens - a.tokens);
  const top = perTool.slice(0, 8);
  const rest = perTool.slice(8);
  $("#peek-body").innerHTML =
    `<dl class="kv">
      <dt>每次请求占用</dt><dd>${fmt(r.perReq)} tokens</dd>
      <dt>占该宿主平均请求</dt><dd>${share == null ? "—" : share}</dd>
      <dt>出现过的请求</dt><dd>${r.requests ? r.requests.toLocaleString("en-US") : "—"}</dd>
      <dt>实际调用次数</dt><dd>${r.calls}</dd>
      <dt>累计上下文占用</dt><dd>${r.occupancy ? fmt(r.occupancy) : "—"}</dd>
      <dt>当前暴露</dt><dd>${r.mode === "off" ? "关闭" : "开启"}${r.mode !== r.savedMode ? "（未保存）" : ""}</dd>
    </dl>
    ${
      top.length
        ? `<div class="sect">最占空间的工具</div>` +
          top.map((t) => `<div class="tool"><span title="${esc(t.name)}">${esc(t.name)}</span><b>${fmt(t.tokens)}</b></div>`).join("") +
          (rest.length ? `<div class="tool"><span>其余 ${rest.length} 个工具</span><b>${fmt(rest.reduce((n, t) => n + t.tokens, 0))}</b></div>` : "")
        : `<div class="sect">工具清单</div><div style="color:var(--c-fg-3);font-size:var(--fs-sm)">还没探针过这个 server，点「刷新」会重新扫描。</div>`
    }`;
  $("#peek").hidden = false;
  document.body.classList.add("peeking");
  $("#peek-reveal").onclick = async () => {
    try {
      await api("/api/reveal", { path: hostOf(activeHost).path });
    } catch {
      toast("找不到这个配置文件");
    }
  };
}

function togglePeek(server) {
  if (openRow === server) return closePeek();
  openRow = server;
  renderRows();
  renderPeek(server);
}
function closePeek() {
  openRow = null;
  document.body.classList.remove("peeking");
  $("#peek").hidden = true;
}


function render() {
  try {
    renderRail();
    renderKpis();
    renderNote();
    renderRows();
    renderSaveBar();
  } catch (e) {
    $("#rows").innerHTML = `<div class="empty">界面渲染出错：${esc(e.message)}</div>`;
    console.error(e);
  }
}

// ── data flow ─────────────────────────────────────────────────
async function load({ host = null, force = false, quiet = false } = {}) {
  if (!quiet) $("#stamp-text").textContent = "读取中…";
  try {
    const q = new URLSearchParams();
    if (host) q.set("host", host);
    if (force) q.set("force", "1");
    S = await api(`/api/state${q.toString() ? `?${q}` : ""}`);
    if (!activeHost || !S.hosts.some((h) => h.name === activeHost)) activeHost = S.hosts[0]?.name;
    render();
    loadGateway();
    const t = new Date(S.generatedAt).toLocaleTimeString("zh-CN");
    $("#stamp-text").textContent = `更新于 ${t}`;
    return S;
  } catch (e) {
    $("#stamp-text").textContent = "读取失败";
    $("#rows").innerHTML = `<div class="empty">读取数据失败：${esc(e.message)}。<button class="btn" id="retry">重试</button></div>`;
    const r = $("#retry");
    if (r) r.onclick = () => load({ force: true });
  }
}

async function switchHost(name) {
  if (name === activeHost) return;
  activeHost = name;
  openRow = null;
  selected = -1;
  closePeek();
  // incremental: only this host is recomputed, and only if its logs changed
  await load({ host: name, quiet: true });
  render();
}

let inflightRefresh = false;
async function refresh() {
  if (inflightRefresh) return;
  inflightRefresh = true;
  const btn = $("#refresh");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';
  try {
    const before = usageOf(activeHost)?.sessions ?? 0;
    const s = await load({ host: activeHost, force: false, quiet: true });
    const after = usageOf(activeHost)?.sessions ?? 0;
    if (s?.unchanged?.includes(activeHost) && after === before) toast("没有新会话，跳过重算");
    else toast(`已重算 · ${after - before > 0 ? `+${after - before} 个会话` : "数据已更新"}`);
    render();
  } catch (e) {
    toast(`刷新失败：${e.message}`);
  } finally {
    inflightRefresh = false;
    btn.disabled = false;
    btn.innerHTML = REFRESH_GLYPH;
  }
}

async function saveDraft() {
  if (!draft.size || busy) return;
  busy = true;
  const btn = $("#save");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>保存中';
  try {
    const changes = [...draft.entries()].map(([k, mode]) => {
      const [host, server] = k.split("|");
      return { host, server, mode };
    });
    const d = await api("/api/save", { changes, host: activeHost });
    S = d.state;
    const n = draft.size;
    draft.clear();
    // saving is one action: registry + the actual host config files
    const hosts = [...new Set(changes.map((c) => c.host))];
    const applied = await api("/api/apply", { hosts });
    const done = (applied.results ?? []).filter((r) => r.changed);
    const bad = (applied.results ?? []).filter((r) => r.error);
    lastSave = done.filter((r) => r.backup);
    render();
    if (bad.length) toast(`已保存 ${n} 处，但写入 ${bad.length} 个宿主失败：${bad[0].error}`, { ms: 6000 });
    else
      toast(`已保存 ${n} 处改动${done.length ? `，写入 ${done.length} 个宿主配置` : ""}`, {
        action: lastSave.length ? undoLastSave : null,
        actionLabel: "撤销",
        ms: 7000,
      });
  } catch (e) {
    toast(`保存失败：${e.message}`);
  } finally {
    busy = false;
    btn.disabled = false;
    btn.textContent = "保存";
  }
}

async function undoLastSave() {
  if (!lastSave.length) return;
  try {
    for (const r of lastSave) await api("/api/restore", { file: String(r.backup).split(/[\/]/).pop() });
    lastSave = [];
    toast("已撤销上次保存");
    await load({ force: true, quiet: true });
  } catch (e) {
    toast(`撤销失败：${e.message}`);
  }
}

function discardDraft() {
  if (!draft.size) return;
  const n = draft.size;
  draft.clear();
  render();
  toast(`已取消 ${n} 处改动`);
}

// config files are a separate, explicit step — registry and host config differ
async function applyToHosts() {
  try {
    const dry = await api("/api/apply", { dryRun: true });
    const changes = (dry.results ?? []).filter((r) => r.diff && (r.diff.add.length || r.diff.change.length || r.diff.remove.length));
    if (!changes.length) return toast("宿主配置已是最新");
    const lines = changes.map((c) => `${c.host}  新增 ${c.diff.add.length} · 更新 ${c.diff.change.length} · 移除 ${c.diff.remove.length}`);
    if (!confirm(`写入宿主配置文件（写前自动备份）：\n\n${lines.join("\n")}`)) return;
    const d = await api("/api/apply", {});
    const ok = (d.results ?? []).filter((x) => x.changed).length;
    const bad = (d.results ?? []).filter((x) => x.error);
    toast(bad.length ? `写入 ${ok}，失败 ${bad.length}：${bad[0].error}` : `已写入 ${ok} 个宿主配置`, { ms: 4000 });
    await load({ force: true, quiet: true });
  } catch (e) {
    toast(`写入失败：${e.message}`);
  }
}

// ── settings sheet ────────────────────────────────────────────
function picker(name, options, current) {
  return `<div class="picker" data-setting="${name}">${options
    .map(([v, label]) => `<button data-v="${v}" class="${v === current ? "on" : ""}">${label}</button>`)
    .join("")}</div>`;
}

async function openSettings() {
  let cacheInfo = { files: [], total: 0 };
  try {
    cacheInfo = await api("/api/cache");
  } catch {}
  $("#sheet-title").textContent = "设置";
  $("#sheet-body").innerHTML = `
    <div class="field">
      <div><label>外观</label><span class="hint">跟随系统时，切换系统主题会即时生效</span></div>
      ${picker("theme", [["system", "跟随系统"], ["dark", "深色"], ["light", "浅色"]], settings.theme)}
    </div>
    <div class="field">
      <div><label>行密度</label><span class="hint">紧凑适合一次看更多 server</span></div>
      ${picker("density", [["cozy", "标准"], ["compact", "紧凑"]], settings.density)}
    </div>
    <div class="sect" style="margin-top:var(--s-4)">分词校准</div>
    <div class="hint" style="font-size:var(--fs-sm);color:var(--c-fg-4);margin-bottom:var(--s-2)">
      每个宿主的 tokenizer 不同，所以 chars → tokens 的系数按宿主分别保存。
    </div>
    <table class="cal">
      <thead><tr><th>宿主</th><th>系数</th><th>来源</th><th></th></tr></thead>
      <tbody>
        ${S.hosts
          .filter((h) => typeof (S.calibration.hosts[h.name] ?? {}).tokensPerChar === "number")
          .map((h) => {
            const c = S.calibration.hosts[h.name];
            return `<tr data-host="${esc(h.name)}">
              <td>${esc(h.name)}</td>
              <td><input class="cal-input" type="number" step="0.001" min="0.05" max="2" value="${c.tokensPerChar}" aria-label="${esc(h.name)} 系数" /></td>
              <td><span class="badge measured">实测</span><span class="badge">${c.regime === "deferred" ? "延迟加载" : "内联"}</span></td>
              <td><button class="btn btn-quiet cal-save" data-host="${esc(h.name)}">保存</button></td>
            </tr>`;
          })
          .join("")}
      </tbody>
    </table>
    <div class="hint" style="font-size:var(--fs-sm);color:var(--c-fg-4);margin-top:var(--s-2)">
      codex、gemini、cursor 只统计调用次数：它们的日志里没有能和 token 配对的工具定义，任何成本数字都只能靠估。
    </div>
    <div class="field">
      <div><label>本地缓存</label><span class="hint">${cacheInfo.files.map((f) => `${f.file} ${f.bytes ? Math.round(f.bytes / 1024) + " KB" : "空"}`).join(" · ")}</span></div>
      <button class="btn" id="clear-cache">清除</button>
    </div>
    <div class="field">
      <div><label>重新同步宿主配置</label><span class="hint">保存时已自动写入。这里用于外部改动后发现配置不一致，写前仍会备份</span></div>
      <button class="btn" id="apply-now">同步</button>
    </div>`;
  $("#scrim").hidden = false;
  $("#sheet-ok").focus();
  $("#sheet-ok").onclick = closeSheet;
  $("#clear-cache").onclick = async () => {
    await api("/api/cache/clear", {});
    toast("缓存已清除，下次刷新会重算");
    closeSheet();
  };
  $("#apply-now").onclick = () => {
    closeSheet();
    applyToHosts();
  };
  for (const b of document.querySelectorAll(".cal-save")) {
    b.onclick = async () => {
      const host = b.dataset.host;
      const input = document.querySelector(`tr[data-host="${host}"] .cal-input`);
      try {
        const d = await api("/api/calibration", { host, tokensPerChar: Number(input.value), source: "manual", method: "设置面板手动设置" });
        S.calibration = d.calibration;
        toast(`${host} 系数已设为 ${Number(input.value)}`);
        render();
      } catch (e) {
        toast(`保存失败：${e.message}`);
      }
    };
  }

  for (const p of document.querySelectorAll(".picker")) {
    p.onclick = (ev) => {
      const b = ev.target.closest("button[data-v]");
      if (!b) return;
      settings[p.dataset.setting] = b.dataset.v;
      applySettings();
      for (const x of p.querySelectorAll("button")) x.classList.toggle("on", x === b);
    };
  }
}

function closeSheet() {
  $("#scrim").hidden = true;
}

// ── wiring ────────────────────────────────────────────────────
$("#refresh").onclick = refresh;
$("#settings").onclick = openSettings;
$("#save").onclick = saveDraft;
$("#discard").onclick = discardDraft;
$("#peek-close").onclick = closePeek;
$("#scrim").onclick = (ev) => {
  if (ev.target === $("#scrim")) closeSheet();
};
$("#filter").oninput = (ev) => {
  query = ev.target.value.trim().toLowerCase();
  selected = -1;
  renderRows();
};

document.addEventListener("keydown", (ev) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
  if (ev.key === "Escape") {
    if (!$("#scrim").hidden) return closeSheet();
    if (openRow) return closePeek();
    if (typing) document.activeElement.blur();
    return;
  }
  if (!$("#scrim").hidden) return;
  if (typing) return;
  if (ev.key === "/") {
    ev.preventDefault();
    $("#filter").focus();
    return;
  }
  if (ev.key === "r" || ev.key === "R") return refresh();
  if (ev.key === "s" && (ev.metaKey || ev.ctrlKey)) {
    ev.preventDefault();
    return saveDraft();
  }
  const rows = visibleRows();
  if (!rows.length) return;
  if (ev.key === "ArrowDown" || ev.key === "j") {
    ev.preventDefault();
    selected = Math.min(rows.length - 1, selected + 1);
    renderRows();
  } else if (ev.key === "ArrowUp" || ev.key === "k") {
    ev.preventDefault();
    selected = Math.max(0, selected - 1);
    renderRows();
  } else if (ev.key === "Enter") {
    ev.preventDefault();
    togglePeek(rows[Math.max(0, selected)].server);
  } else if (ev.key === "o" || ev.key === "n") {
    const r = rows[Math.max(0, selected)];
    const next = r.mode === "off" ? "native" : "off";
    const saved = hostOf(activeHost)?.modes?.[r.server] ?? "off";
    if (next === saved) draft.delete(key(activeHost, r.server));
    else draft.set(key(activeHost, r.server), next);
    render();
  }
});

loadSettings();
applySettings();
load();
