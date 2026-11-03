# 实测结论（本机，2026-11）

## 1. 校准：token ≠ 字符数，宿主会规范化 schema

用假 server（工具数 / 描述长度可控）在 DSH 上二分实测：

| 工具数 | 工具 JSON 字符 | inputTokens | 增量 |
|---|---|---|---|
| 0 | 2 | 13,283 | — |
| 10 | 4,181 | 14,453 | +1,170 |
| 50 | 20,941 | 19,133 | +5,850 |
| 200 | 276,891 | 79,283 | +66,000 |
| 10 | 62,161 | 27,323 | +14,040 |
| 10 | 243,061 | 67,523 | +54,240 |

**换算系数 0.2293 tokens/字符**，5 个点全部吻合（误差 <1%）。
**DSH 对工具定义不截断**：243k 字符照样全量计费（54k tokens）。

## 2. 但真实成本远低于"原始 tools/list 大小"

| 量 | 字符 | tokens |
|---|---|---|
| REA 原始 `tools/list`（229 工具） | 3,504,736 | 803,636 |
| REA 规范化后（name + description + parameters） | 270,737 | 62,080 |
| **DSH 真实请求头里出现的 REA** | **295,066** | **67,659** |

原因：宿主只发 `{name, description, parameters/input_schema}`，把 `title`、`outputSchema`、
`annotations`、`examples` 全剥掉。229 个工具平均 **1,182 字符**，而原始形状是 15,305 字符/工具。

**结论：任何"按原始 schema 大小"做的账本都会高估约 13 倍。** 必须先规范化再计量。

## 2.5 单位修正（关键）

第一版账本按"会话"计价，**错了**：上下文在每一轮请求里都会被重新装进 LLM，
所以正确的乘数是**请求数**，不是会话数。

DSH 日志实测（全量 154 会话 / 8,886 次 LLM 请求）：

```
avg ctx/req = 257.9k   fresh 5.9k + cacheRead 252.0k
```

工具定义就驻在这个前缀里，每轮重读一次。所以：

```
成本 = 每请求税 × 载入期间的请求数
     ≠ 每请求税 × 会话数
```

另一个坑：`request/header` **只在工具集合变化时才记录一条**（源码 `toolsChanged()`），
221 条 header 对应 8,886 次请求，采样率约 2.5%。
必须用"该 server 出现过的会话里的请求总数"做乘数，不能用 header 条数。

## 3. 真实账本（按宿主日志实测）

数据源：
- `claude-code`：`~/.claude/projects/**/*.jsonl` 里的 `api-request-shape` = 真实 `{system,tools}` 负载
- `dsh`：`~/.dsh/sessions/**/session.v4.jsonl.zstd` 里的 `request/header` = 真实 tools 数组
- `codex`：`~/.codex/sessions/**/rollout-*.jsonl` 的 `function_call`（只有调用名，无 schema）

| 宿主 | 会话数 | MCP 固定税/会话 | 结果为纯浪费的比例 |
|---|---|---|---|
| claude-code | 73 | 19.9k tokens | 34% |
| codex | 8 | 1.1k | 100%（context7 装了 0 调用） |
| dsh | 154 | **122.8k** | 2%（几乎全是 rea） |

关键行（单位已修正为每请求）：

```
dsh   rea  229 工具  100.1k tok/req  4,682 次请求  4 次调用
     → 上下文占用 468.5M tokens（每次请求的 39%）
     → 计费当量 46.9M（按 cache 0.1 折）
     → 每次调用摊 117.1M 占用 tokens
```

REA 在 DSH 的 40 个会话里被载入 4,682 次请求、总共只被调用 4 次。
它一个人占了每次请求上下文窗口的 **39%**。

三个口径必须分开看，混用会得出相反结论：

| 口径 | 含义 | REA 在 DSH |
|---|---|---|
| **占用** | 每请求被 schema 吃掉多少上下文 | 100.1k / 257.9k = **39%** |
| **计费** | 乘以请求数、按 cache 命中打折 | 468.5M × 0.1 ≈ **46.9M** 当量 |
| **效率** | 每次真实调用摊到多少 | **117.1M** 占用 / 次 |

而高频的其实便宜（claude-code，16,506 次请求样本）：

```
firecrawl      3.6k/req = 2% of request   178 calls   59.7M occupancy
context-mode   2.9k/req                   472 calls   15.7M
windows-mcp    190/req                    141 calls    0.6M
jina           139/req                     19 calls      —
context7       1.1k/req                     0 calls      cold
```

同理 DSH 里 context7：1.1k/req × 7,372 次请求 = 8.4M 占用，只有 14 次调用。

## 4. 由此确定的动作清单

| server | 宿主 | 现状 | 动作 | 预期 |
|---|---|---|---|---|
| rea | dsh | 100.1k/会话，4 次调用 | `mode:"proxy"` + `preset:rea-lite`(8 工具 = 3,073 tok) | 每会话省 **97k** |
| rea | claude/codex | 已 off | 保持 | — |
| context7 | claude-code | 1.1k，0 调用 | 降 cold 或确认是否真用 | 省 1.1k/会话 |
| firecrawl | claude-code | 3.6k，175 调用 | 保持 native | — |
| jina-mcp-tools | claude-code | 139，19 调用 | 保持 | — |
| tax（校准用假 server） | dsh | 14.3k × 5 会话 | 删除 overlay | 清 71k 残留 |

## 5. 顺带测到的实现事实

- **DSH 的 stdio MCP 是两段式协商**：先起探测进程拿 initialize，杀掉，再起真实进程。所以任何代理实现会被拉起两次。
- **DSH 对上游启动有时间预算**：REA + proxy 组合在 8 秒内没走到 `tools/list`，DSH 就放弃并继续启动（不报错、不加工具）。
  → 代理必须**立刻自己回 initialize**，把上游启动放到后台，否则重上游会被静默丢弃。这是聚合器"不能阻塞上游启动"的实际证据。
- **DSH session 文件是多帧拼接 zstd**（每次 append 一帧）。`zstdDecompressSync` 只解第一帧，
  必须按 magic `28 B5 2F FD` 逐帧解。177 个会话文件里最大的一个 5970 帧 / 29MB / 10815 行。

## 为什么 codex / gemini / cursor 没有成本数字

- codex 的 rollout 里有 **1,364 条 `token_usage_record`**（input / cached / output 全有），能算「平均上下文 / 请求」，但**一条工具定义都不记**，所以无法把 token 归到某个 MCP server。硬算只能靠系数估，估出来的数就是假的。
- gemini / cursor 本机无会话日志。
- 结论：这两个（三）宿主只统计**调用次数**，不显示任何成本、占比、累计占用。调用次数是日志里真有的事实，可以直接数。

调用次数的归因：codex 记的是裸工具名（`resolve_library_id` / `query_docs`），用探针清单 `.cache/inventory.json` 反查 server，并归一 `-` 与 `_`；同名工具属多个 server 时丢弃不猜。

### 决定：codex 不做校准（放弃计价）

codex 的 `response_item.payload.tools` 里确实有 namespace 形态的工具定义（`mcp__context7` 5,703 字符 / `mcp__bookshelf` 1,132 / `multi_agent_v1` 10,063），所以「字符能拆到 server」这一半是通的。但全量语料里只有 **7 条**这样的记录（工具集变化时才写），token 计量在另一批 `token_usage_record` 里，两者无法逐请求配对。

要拿到 tok/char 只能跑假 server 拟合 —— 那是给这个应用造一个专用统计口径。**放弃**：只保留调用次数。判据是「能不能直接数」，不是「能不能拟合出来」。
