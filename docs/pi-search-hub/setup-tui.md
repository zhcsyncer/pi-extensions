# Search Hub 路由、combine 与设置页

状态：契约已拍板

## Why

主模型只要结果，不要供应商。名单收到四家之后，如果还让模型选 backend / reader、或让配置全局强制 combine，调用面仍在做供应商决策。设置页必须是可草稿保存的 SettingsList，而不是四层 `ui.select` 向导。

## 心智模型

```text
web_search(query, numResults, compact, combine?)
        │
        ├─ combine = false（默认）
        │     按 routing 排已启用名单，一家一家试，成功即停
        │
        └─ combine = true（仅模型打开）
              同一 query 打最多 3 家有结果的源，合并去重，每条带来源

web_read(url)
        firecrawl → exa → parallel，成功即停
```

主模型不选供应商。单源和 combine 的每条结果都带来源；compact 行同样带 `[exa]`。

### 路由

`routing` 是配置，不是 tool 参数：

- `priority`：一份只含已启用的有序名单，顶上先试；挂了 / 429 / 配额换下一家。顺序在设置页改。
- `random`
- `best-latency`：读持久化 `effectiveness.json`（最近 10 次成功率 + 成功调用中位延迟）。启动即有历史，不以进程内短窗口当主排序。

没有 round-robin，没有单独的 `defaultBackend`，没有「要不要 fallback」开关。未启用任何一家时，运行时仍用 Firecrawl 作 keyless fallback。`backends` 对象的键顺序不是优先级。

### combine

只留给模型，默认 `false`。配置不得全局强制 combine。四家里 combine 固定 targeted：最多合并 3 家有结果的源。

打开 combine 只为：用户要多家或独立来源；高风险事实（版本、弃用、安全公告、定价/政策）需要对上独立索引；或一次结构良好的单源搜索结果过少、几乎同域。换 query 修角度；combine 只修索引盲区。日常文档、报错、changelog 不要开。

### `/search-setup`

首页只放 routing、（仅 `priority` 时）Priority order 入口、Providers 入口、compact。四家开关和 key 在二级 Providers 页；尝试顺序在独立的 Priority order 列表里改。

- 关掉列表搜索，避免 `s` 被搜索抢走。
- `s` 保存草稿；首页干净 Esc 直接关；脏了 Esc 只确认一次 Discard changes / Keep editing，确认框里没有 Save。二级页 Esc 只返回首页。
- 列表里没有 Save / Discard / Exit 行。
- Priority 顺序不能手填名字：进独立列表后 Enter 选中，上下键移动，再 Enter/Esc 放下。
- 提示只留顶栏（`s save · Esc close`）。SettingsList 自带底栏提示去掉，避免重复。
- Key 写在 `$PI_CODING_AGENT_DIR/extension-data/pi-search-hub/config.json` 的 `backends.<name>.apiKeys`。用 `ui.editor` 一行一个引用；没打开过编辑器的 key，保存不得覆盖磁盘上已有的值。
- 项目覆盖只提示，不在这编项目文件。
- 没有 Search mode、Selection strategy、Enable keyless bulk。网页读取顺序不在这配置。

## 红线

- 主模型不选 search backend，也不选 reader。
- 配置不能强制全局 combine；不能靠 `backends` 键顺序当 priority。
- `best-latency` 的主排序是持久化 effectiveness，不是进程内 60 秒窗口。
- 设置页不把保存塞进脏 Esc 确认框，也不在每次改 key 时写盘。
- 磁盘上已有的 key 不因 disable、未打开 key 编辑器、或丢掉 combine/reader 这类旧字段而被删。
- 不提交、不推送，除非用户之后明确要求。
