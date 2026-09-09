# 上游 Fork 跟踪

非显然外部事实：各 fork/改编的上游钉、**已评估到哪一版**、以及已锁定的跟/不跟。实现细节以代码和 `UPSTREAM_SOURCE.md` 为准。

**版本锁定（已评估头）**：`2026-09-08T15:02:50Z` 首次全表核对；`2026-09-09T03:41:33Z` 复核 npm 头并写入讨论结论；同日补评 Glance `0.7.0`。

`last_seen_*` = 已经读过 changelog/compare、并写了跟或不跟的最新上游。下次**只打开比它新的版本**。不要重评本文件已写「不跟 / 已有 / 不搬」的旧条目，除非本地 pin 变了。

## 下次怎么跑

1. 读 Snapshot 的 `last_seen_npm` / `last_seen_git`（已评估头，不是本地 pin）。
2. 查 npm `version` 与 GitHub tags。只打开 `> last_seen` 的 changelog / compare。
3. 无更新：只改文首核对时间。有更新：写进对应包，并把 `last_seen_*` 推到新头。
4. 已写「不跟 / 已有」的旧条目不要重评，除非本地 pin 变了。

## Snapshot

| 本地包 | 本地 pin | last_seen_npm | last_seen_git | 锁定结论 | 下次只看 |
|---|---|---|---|---|---|
| `pi-todo` | `@juicesharp/rpiv-todo` 1.20.0 / `v1.20.0` | 2.9.0 | `v2.9.0` | 不 rebase。可摘 2.5.0 剥控制字符、空 update 报 `No change` | `>2.9.0` |
| `pi-ask-user-question` | `@juicesharp/rpiv-ask-user-question` 2.4.0 / `a1531ed` | 2.9.0 | `v2.9.0` | overlay 专属修复不跟。可摘粘贴全文、改键确认、BEL、全局 note | `>2.9.0` |
| `pi-glance` | `pi-glance` 0.5.3 / `v0.5.3` | **0.7.0** | `v0.7.0` | 不 rebase、不要 Working 扫光。0.7.0 的 stash/Git Summary 本地已有。可摘 CH%、Reply speed 推理计时 | `>0.7.0` |
| `pi-subagents` | `@tintinweb/pi-subagents` 0.14.3 / `v0.14.3` | 0.19.0 | `v0.19.0` | 不 rebase。不跟默认后台 / Workflow / `@handle`。`reportUsage` 给 Pi/Glance，meter 保持 pin 并忽略父会话 rollup | `>0.19.0` |
| `pi-provider-cursor-ask` | `@rahularya01/pi-cursor` 1.4.25 | 1.4.33 | `v1.4.33` | 传输已是 Node in-process。1.4.26–1.4.32 大多已在本地。不跟 Bun-only、不跟 Cursor 侧工具。剩：blob miss 勿回空包 | `>1.4.33` |
| `pi-search-hub` | `pi-search-hub` 2.8.0 / `v2.8.0` | 2.8.0 | `v2.9.0` | reader fallback 本地已有。401/403 改致命仅参考，不必须 | npm `>2.8.0` 或 git `>v2.9.0` |
| `pi-context7` | `@upstash/context7-pi` 0.1.2 / `b250c25` | 0.1.2 | `packages/pi` 仍 0.1.2 | 持平 | npm `>0.1.2` 或该路径新 commit |
| `pi-tool-display-intent` | display 0.5.0；summary 0.1.0 | display 0.5.0；summary npm 0.1.0 | display `v0.5.0`；summary `v0.1.1` | summary 把字段提前：不跟 | display `>0.5.0`；summary git `>v0.1.1` |
| `pi-herdr-companion` | `pi-herdr-btw` 0.3.0 | 0.3.1 | `v0.3.1` | 不跟（只改入口文件名） | `>0.3.1` |
| `pi-consult` | `@juicesharp/rpiv-advisor` 2.8.0 | 2.9.0 | `v2.9.0` | 不跟（空版本锁步） | `>2.9.0` |
| `pi-meter` ← tracker | `pi-tracker` 0.3.0（时间推断） | 0.3.0 | `v0.3.0` | 持平 | `>0.3.0` |
| `pi-meter` ← usage | `@pi-plugins/usage` 0.3.1（时间推断） | 0.5.1 | `@pi-plugins/usage@0.5.1` | 0.3.2–0.5.1 不搬。Z.ai GLM 套餐窗口用户明确先不用 | `>0.5.1` |

自研、无上游 fork，不扫描：`pi-recap`、`pi-plan-mode`、`pi-fast-mode`、`pi-adversarial-review`、`pi-provider-volcengine-agent-plan`。

## 已锁定的产品口径（不要下次再辩）

- **Reply speed（Glance）**：分母是服务端正在推理的时间（`thinking_*` + 正文/toolcall 流）。工具执行、问卷等人不计。第一段 delta 之前的纯等待不计。分子仍是 `usage.output`。不要做成两个数。不要用上游 0.6「thinking 停表」的语速口径。
- **子代理用量**：pi-meter 靠 pinned observer 在子会话逐条记账，已经完整。Glance / Pi `getSessionStats()` 只看父会话，缺子代理。`reportUsage` 把合计盖到父会话「这笔完成」的那条 toolResult 上，给 Pi/Glance。meter **不要拆 pin**，父会话忽略 `Agent`（以及仅当盖了 rollup 的 `get_subagent_result`）的汇总 `usage`，否则双计。
- **Cursor 传输**：本地已是 Node in-process HTTP/2，不是上游 1.4.29 的 Bun-only。不要再当「没切 in-process」。
- **meter / Z.ai**：usage 0.5.0 的智谱 Coding Plan 窗口，明确先不加。

---

## `pi-todo` — 已评估至 2.9.0

juicesharp 从 2.0 起整仓锁步。2.7.0–2.9.0 的 todo changelog 是空的。

**可摘（未做不阻塞下次扫描）**：2.5.0 剥 ANSI/C1/bidi；2.0.0 空 update 报 `No change`。

**不跟**：整包 2.x rebase（依赖图 vs 本地有界周期）；XDG/`~/.config`；overlay 懒加载；展开即显示全部任务。

## `pi-ask-user-question` — 已评估至 2.9.0

本地不是底栏 overlay。2.6.3 一类 overlay 专属修复对本地无效。2.8.0 / 2.9.0 无包内行为。

**可摘**：2.5.1 大粘贴全文；2.5.2 改键后的确认；2.6.0 BEL；2.6.1 `guidance.description`；2.7.0 Submit 全局 note。

## `pi-glance` — 已评估至 0.7.0

0.6.x 目录重写。跟能力不跟结构。本地已有 Reply speed 段、cache `auto/show/hide`、Bash 边框、truecolor 缓存键、Git 关闭时停 refresher、单槽 stash、Git Working Tree summary、`origin/main` 非交互 fetch。

**0.7.0**（`0b2b5aa`，相对 `v0.6.9` 一个 commit）：上游补了 prompt stash（`alt+s` 存/换）和 Git Summary（文件数 + 跟踪 `+/-`），新装和旧配置都默认 Summary；另有每 5 分钟 auto fetch（可关）、工具连发时合并 Git 刷新、瞬时失败保留上次分支。

这是上游在追本地已有的 stash / Working tree 摘要，不是新区块。快捷键和丢弃确认本地更完整（`Ctrl+Shift+S/U`、边框 `!stash`）。本地 fetch 是 session/focus + 12 分钟 stale，不是 5 分钟开关。不必为 0.7.0 rebase 或再摘一套 stash。

**相对 0.6.9 仍可摘（0.7.0 没带来）**：Tokens `rate`（CH%）；Reply speed 改成锁定的推理计时。

**不跟**：0.6.7–0.6.9 Working 边框扫光；设置页重做；整包 rebase。

## `pi-subagents` — 已评估至 0.19.0

本地已摘 0.17 默认落盘 + `isolation: off`（worktree 默认关）。后台完成用 `steer`。

**要做（相对 0.19.0，不再重选）**：`reportUsage` 给父会话 Pi/Glance；meter 保持 pin、忽略父会话 rollup；RPC 也执行 `scopeModels`；viewer Ctrl+C；表面显示实际模型；`resume` 可后台。

**不跟**：`backgroundByDefault`；`@handle` / `name:` 语义；0.19 Workflow（约 +5k prompt）；整包 rebase。

0.15 嵌套委派、fail-closed 未知类型等仍是可选小修，不是必须重评。

## `pi-provider-cursor-ask` — 已评估至 1.4.33

本地 pin 文案仍是 1.4.25，但 main 已含 in-process（#113）以及 hang/schema/slim（#110）、限 Pi 工具（#116）。

**已有，不要再当缺口**：全屏命令只 `notify`；未知 exec `ExecClientThrow`；Run 只发 `requestedModel`（Fable 双字段 `not_found`）；Node in-process HTTP/2。

**不跟**：1.4.29 Bun-only；1.4.31 Cursor 侧跑 read/ls/grep/write/shell/fetch；1.4.28 事故重发。

**仍缺**：`getBlobArgs` miss 仍回空 blob → Cursor 当合法历史 → `Connect internal`。应拒答、作废 checkpoint、本轮失败，下一轮从 Pi 历史重建。

## `pi-search-hub` — npm 已评估至 2.8.0；git 至 v2.9.0

本地已有顺序 `readerFallback`。git 2.9.0 主功能已有。401/403 改成不 fallback 仅参考。

## 已持平 / 不跟（整段锁定）

### `pi-context7`

npm 与 `packages/pi` 仍是 pin `0.1.2` / `b250c2515694`。仓库 `v1.0.x` tag 是其它包。

### `pi-tool-display-intent`

display 仍 0.5.0。summary git `v0.1.1` 只把 `displaySummary` 提前；本地有意原字段在前，不跟。

### `pi-herdr-companion` ← `pi-herdr-btw` 0.3.1

只改入口文件名。不跟。

### `pi-consult` ← `rpiv-advisor` 2.9.0

空版本锁步。不跟。

### `pi-meter`

推断基线：`pi-tracker@0.3.0` + `@pi-plugins/usage@0.3.1`（首提交 2026-08-16；次日文档对照安装）。

tracker 仍 0.3.0。usage 到 0.5.1：空闲打 API（他们 0.4.2 已撤回）、Effect 超时、倒计时带分钟（meter 已有 `2h 1m`）。**不搬。** 0.5.0 Z.ai 窗口用户先不用。

---

## 核对来源

- npm `version` + `time`；2026-09-09 复核头：todo/ask/advisor 2.9.0，subagents 0.19.0，pi-cursor 1.4.33，glance **0.7.0（已评）**，tracker 0.3.0，usage 0.5.1
- Glance `v0.6.9...v0.7.0`：1 commit `feat: add prompt stash and Git summaries`
- GitHub tags / compare 见 2026-09-08 首次核对
- 后续结论：meter 不搬、Z.ai 不用、subagents 用量两套账、Cursor in-process 已切、blob 空包仍缺
