# Pi 扩展持久化目录统一方案

## 实现状态

已实现：仓库内所有独立配置（包括 Todo、Ask User Question 与 Subagents）均已统一路径；自动迁移升级、trust 边界、迁移通知、配置/资源边界和回归测试已落地。

本文只约束 `pi-extensions` 仓库内扩展的配置与明确纳入治理的扩展内部状态路径，不改 Pi core，也不处理仓库外第三方扩展。

## 背景

当前各扩展自行选择持久化位置，配置、状态与扩展源码目录混杂：

```text
~/.pi/agent/recap.json
~/.pi/agent/extensions/search.json
~/.pi/agent/exa-usage.json
~/.pi/agent/pi-glance/config.json
~/.pi/agent/extensions/pi-tool-display-intent/config.json
~/.pi/agent/plan-mode.json
~/.config/rpiv-todo/config.json
~/.config/rpiv-ask-user-question/config.json
~/.pi/agent/subagents.json
~/.pi/agent/plans/
```

问题不在于文件数量，而在于缺少统一的信息架构：

- 无法从一个固定根目录盘点本仓库扩展的持久化数据；
- 配置、运行状态和扩展源码混在不同层级；
- 部分实现直接拼接 `~/.pi/agent`，没有遵循 `PI_CODING_AGENT_DIR`；
- Search Hub 的配置与 Exa 用量状态分散，且路径帮助文本散落在多处。

## 已确认决策

1. **统一目录，不合并配置文件**：每个扩展继续拥有独立 schema、默认值和迁移逻辑，不引入单体 `extensions.json`。
2. **统一根目录**：仓库内扩展的独立配置，以及本方案明确列出的扩展内部状态，统一进入 `$PI_CODING_AGENT_DIR/extension-data/<extension-id>/`；标准资源、Session 数据和其他运行状态按下文边界保留原位。
3. **暂不建设共享存储层**：本期不新增 `extension-storage` 公共 package；各扩展直接完成自己的路径迁移。
4. **暂不改造密钥机制**：继续保留各扩展现有 credential 字段、环境变量、shell command 和明文值行为；不新增 `secrets.json`、OS keychain 适配或通用 Secret Store。
5. **Provider 凭证不在本方案范围**：Provider 继续使用 Pi 的 `auth.json` 与 `/login` 机制，不迁移、不复制，也不注册伪 Provider 来承载非 Provider 密钥。
6. **Plan Mode 状态是受治理状态中的目录例外**：Plan revision 与 manifest 继续保存在现有全局目录 `$PI_CODING_AGENT_DIR/plans/`，不迁入 `extension-data`；只有 `plan-mode.json` 配置迁入统一目录。
7. **Search Hub 必须修复目录实现**：配置与 Exa 用量状态迁入统一目录，并消除自行硬编码 `~/.pi/agent` 的实现。

## 目标目录

默认 `PI_CODING_AGENT_DIR=~/.pi/agent` 时：

```text
~/.pi/agent/
├── extension-data/
│   ├── pi-recap/
│   │   └── config.json
│   ├── pi-search-hub/
│   │   ├── config.json
│   │   └── state/
│   │       └── exa-usage.json
│   ├── pi-glance/
│   │   └── config.json
│   ├── pi-tool-display-intent/
│   │   ├── config.json
│   │   ├── config.legacy.json        # 已存在或 schema 迁移时生成的一次性备份
│   │   └── state/
│   │       └── debug.log
│   ├── pi-plan-mode/
│   │   └── config.json
│   ├── pi-todo/
│   │   └── config.json
│   ├── pi-ask-user-question/
│   │   └── config.json
│   └── pi-subagents/
│       ├── config.json
│       └── agent-tool-description.md # 可选的工具描述配置
└── plans/                       # Plan Mode 状态例外，保持现状
    └── <plan-id>/
        ├── manifest.json
        ├── revisions/
        └── .review/
```

`extension-id` 使用稳定 package slug，而不是展示名：

```text
pi-recap
pi-search-hub
pi-glance
pi-tool-display-intent
pi-plan-mode
pi-todo
pi-ask-user-question
pi-subagents
```

## 项目级配置

只有原本已经支持项目覆盖的扩展继续保留该能力，不为其他扩展新增项目级配置。

```text
<project>/.pi/extension-data/pi-recap/config.json
<project>/.pi/extension-data/pi-search-hub/config.json
<project>/.pi/extension-data/pi-subagents/config.json
<project>/.pi/extension-data/pi-subagents/agent-tool-description.md
```

约束：

- 项目配置覆盖全局配置，合并语义保持各扩展当前行为；
- Recap 与 Search Hub 的项目配置只在项目受信任时读取；未受信任时不得探测、读取或提示新旧项目配置；
- Subagents 保留既有项目覆盖与写入行为：`/agents` → Settings 只写项目 canonical 文件，全局文件仍由用户手工编辑；工具描述同样项目优先；
- 项目路径实现必须使用 Pi 导出的 `CONFIG_DIR_NAME`，不能硬编码 `.pi`；本文继续用 `.pi` 表示默认目录；
- Recap/Search Hub 的配置 UI 仍只写全局文件；受信任项目中的旧项目配置会自动迁移。配置预览、覆盖检测、迁移通知和保存后的生效提示必须遵循同一 trust 判断；
- `pi-glance`、`pi-tool-display-intent`、`pi-plan-mode`、`pi-todo` 和 `pi-ask-user-question` 仍只有全局配置；
- 运行状态不写入项目 `.pi/extension-data/`。

### 项目旧路径兼容与优先级

Recap 与 Search Hub 只在 `ctx.isProjectTrusted()` 为 `true` 时执行以下判断；Subagents 按其既有项目设置加载时机执行同一 canonical 优先状态机：

| 新项目路径 | 旧项目路径 | 行为 |
|---|---|---|
| 不存在 | 不存在 | 不加载项目配置 |
| 不存在 | 存在 | 自动解析、升级并原子写入新文件；验证成功后删除旧文件并通知迁移结果 |
| 存在 | 不存在 | 只读取新文件 |
| 存在 | 存在 | 只读取新文件；语义等价时验证后可删除旧文件，冲突或不可读时保留并告警；不做合并或覆盖 |

Recap/Search Hub 的项目迁移只在受信任项目中执行；Subagents 不改变原有项目配置 trust 行为。无法映射的旧字段允许丢弃，但通知必须列出被丢弃的字段路径；JSON 无法解析或根结构无法识别时不得删除旧文件。

## 路径迁移表

| 扩展 | 当前路径 | 目标路径 | 备注 |
|---|---|---|---|
| Pi Recap | `$PI_CODING_AGENT_DIR/recap.json` | `$PI_CODING_AGENT_DIR/extension-data/pi-recap/config.json` | 全局配置 |
| Pi Recap | `<project>/.pi/recap.json` | `<project>/.pi/extension-data/pi-recap/config.json` | 受信任项目覆盖 |
| Search Hub | `$PI_CODING_AGENT_DIR/extensions/search.json` | `$PI_CODING_AGENT_DIR/extension-data/pi-search-hub/config.json` | 全局配置 |
| Search Hub | `<project>/.pi/search.json` | `<project>/.pi/extension-data/pi-search-hub/config.json` | 受信任项目覆盖 |
| Search Hub | `$PI_CODING_AGENT_DIR/exa-usage.json` | `$PI_CODING_AGENT_DIR/extension-data/pi-search-hub/state/exa-usage.json` | 运行状态，不是配置 |
| Pi Glance | `$PI_CODING_AGENT_DIR/pi-glance/config.json` | `$PI_CODING_AGENT_DIR/extension-data/pi-glance/config.json` | 全局配置 |
| Tool Display Intent | `$PI_CODING_AGENT_DIR/extensions/pi-tool-display-intent/config.json` | `$PI_CODING_AGENT_DIR/extension-data/pi-tool-display-intent/config.json` | 全局配置 |
| Tool Display Intent | `$PI_CODING_AGENT_DIR/extensions/pi-tool-display-intent/config.legacy.json` | `$PI_CODING_AGENT_DIR/extension-data/pi-tool-display-intent/config.legacy.json` | 已存在或 schema 迁移生成的一次性配置备份 |
| Tool Display Intent | `$PI_CODING_AGENT_DIR/extensions/pi-tool-display-intent/debug/debug.log` | `$PI_CODING_AGENT_DIR/extension-data/pi-tool-display-intent/state/debug.log` | 调试运行状态；不存在时不创建 |
| Plan Mode | `$PI_CODING_AGENT_DIR/plan-mode.json` | `$PI_CODING_AGENT_DIR/extension-data/pi-plan-mode/config.json` | 全局配置 |
| Plan Mode | `$PI_CODING_AGENT_DIR/plans/` | **保持不变** | 全局 Plan 状态例外 |
| Pi Todo | `$XDG_CONFIG_HOME/rpiv-todo/config.json`（通常为 `~/.config/rpiv-todo/config.json`） | `$PI_CODING_AGENT_DIR/extension-data/pi-todo/config.json` | 全局展示/guidance 配置 |
| Pi Todo | Session JSONL custom entries | **保持不变** | 任务历史属于 Session 状态 |
| Ask User Question | `$XDG_CONFIG_HOME/rpiv-ask-user-question/config.json`（回退 `~/.config/rpiv-ask-user-question/config.json`） | `$PI_CODING_AGENT_DIR/extension-data/pi-ask-user-question/config.json` | 全局配置 |
| Subagents | `$PI_CODING_AGENT_DIR/subagents.json` | `$PI_CODING_AGENT_DIR/extension-data/pi-subagents/config.json` | 全局设置 |
| Subagents | `<project>/.pi/subagents.json` | `<project>/.pi/extension-data/pi-subagents/config.json` | 项目设置，仍覆盖全局且为 UI 写入目标 |
| Subagents | `$PI_CODING_AGENT_DIR/agent-tool-description.md` | `$PI_CODING_AGENT_DIR/extension-data/pi-subagents/agent-tool-description.md` | 可选全局工具描述 |
| Subagents | `<project>/.pi/agent-tool-description.md` | `<project>/.pi/extension-data/pi-subagents/agent-tool-description.md` | 可选项目工具描述，项目优先 |

## Search Hub 专项修复

Search Hub 是本次路径治理中需要额外修正的实现：

1. 删除 `packages/pi-search-hub/extensions/utils.ts` 中自行拼接 `$HOME/.pi/agent` 的 `getAgentDir()`；统一使用 Pi 导出的 `getAgentDir()`，正确遵循 `PI_CODING_AGENT_DIR`。
2. 全局配置读取、`/search-setup` 保存和帮助文本统一指向：

   ```text
   $PI_CODING_AGENT_DIR/extension-data/pi-search-hub/config.json
   ```

3. 项目配置统一指向：

   ```text
   <project>/.pi/extension-data/pi-search-hub/config.json
   ```

4. Exa 用量文件迁入：

   ```text
   $PI_CODING_AGENT_DIR/extension-data/pi-search-hub/state/exa-usage.json
   ```

5. `loadConfig`、`refreshConfig`、设置 UI 的 effective config 预览和项目覆盖提示都必须显式接收当前 `cwd` 与 `projectTrusted`；不得在缺少 trust 上下文时读取项目配置。
6. 配置缓存键至少包含 canonical config path、`cwd` 和 `projectTrusted`，Session 切换、cwd 变化或 trust 变化后不得复用旧项目的 effective config。
7. 项目路径使用 `CONFIG_DIR_NAME`，不再硬编码 `.pi`。
8. 更新 README、示例、错误消息、credential 帮助文本和测试中的旧路径，避免实现与文档再次漂移。
9. 保留当前配置内容和 credential 解析语义，不在本次工作中拆分密钥文件。

## 配置、状态与 Session 的边界

### 配置

用户可编辑、需要 schema 和默认值的设置：

```text
extension-data/<extension-id>/config.json
```

Todo 的 `statusIcons`/guidance、Ask User Question 的 `collapseKey`/guidance，以及 Subagents 的运行设置都属于这一层。Subagents 的 `agent-tool-description.md` 虽不是 JSON，也属于用户可编辑配置，因此与对应 `config.json` 同目录。

### 状态

扩展运行产生、通常不应手工编辑的数据：

```text
extension-data/<extension-id>/state/
```

当前明确迁入该层的状态包括：

- Search Hub 的 Exa 用量：`pi-search-hub/state/exa-usage.json`；
- Tool Display Intent 的调试日志：`pi-tool-display-intent/state/debug.log`。

Tool Display Intent 的 `config.legacy.json` 是一次性配置备份，不属于运行状态，保留在该扩展目录根部。

### Session 状态

与 Pi Session branch 语义绑定的数据继续使用 `pi.appendEntry()` 或 tool result details，不搬入 `extension-data`。Pi Todo 和 Recap 历史属于此类。Todo 因此同时拥有全局展示/guidance 配置与独立的 Session 任务历史，两者边界不能混淆。

### Subagents 资源与运行状态

Subagents 只有自身运行设置和 `agent-tool-description.md` 参与本次配置迁移。以下内容不是该扩展配置文件，保持原有标准/resource/state 位置与行为：

- 项目/全局 custom agents；
- Pi/native skills 与 Pi 自身 `settings.json`；
- agent memory；
- session-scoped schedules；
- Pi session、worktree 与临时 `.output` transcripts；
- 其他运行时资源。

### Plan Mode 例外

Plan revision 是用户可直接定位、review 和引用的持久产物，不按普通扩展内部状态处理。因此：

```text
$PI_CODING_AGENT_DIR/plans/
```

保持为稳定全局路径；不能因配置目录统一而迁移。

## 密钥边界

本期只整理路径，不改变安全模型：

- Search Hub 的 `apiKey` 仍可保存环境变量名、shell command 或明文值；
- OpenAI Codex backend 继续读取 Pi Provider credential；
- 不新增通用扩展 Secret Store；
- 不把非 Provider credential 写入 `auth.json`；
- 不拆出 `secrets.json`；
- 含 credential 的 Search Hub 全局配置继续以 `0600` 权限原子写入。

通用 Secret Store、OS keychain 和 typed credential reference 作为未来独立议题，不阻塞本次目录迁移。

## 迁移原则

1. 新路径是唯一写入目标，禁止新旧路径双写。
2. 实现必须识别旧全局文件并执行一次性迁移，避免升级后静默丢配置或用量状态。
3. 迁移必须在该文件第一次正常读取或写入之前完成；不能先按默认值运行、随后再迁移。
4. 迁移流程必须先在新路径完成原子写入并验证成功，再删除旧文件；失败时保留旧文件并明确告警。
5. Recap/Search Hub 只迁移受信任项目中的旧项目配置，未受信任时不得探测或修改；Subagents 保留既有项目加载行为并迁移其项目设置/工具描述。
6. 自动迁移成功后不再兼容读取旧路径；迁移失败时保留旧文件供下次重试，不形成永久双路径读取层。
7. 配置文件权限沿用各扩展现有要求；Search Hub 因可能含 credential，目录使用私有权限，配置文件和迁移临时文件必须保持 `0600`。
8. 每个 package 应提供唯一的 package-local 路径模块，供加载、保存、状态、帮助文本和迁移共同使用；“不建设共享存储层”不等于在同一 package 内重复拼接路径。
9. 迁移和状态更新必须考虑多个 Pi 进程并发，不能依赖单进程内布尔标记来证明“一次性”。

### 配置文件迁移状态机

新路径一旦存在，即为 canonical path。迁移不得静默覆盖任一已有文件：

| 新文件 | 旧文件 | 行为 |
|---|---|---|
| 不存在 | 不存在 | 使用默认值；第一次保存只写新路径 |
| 不存在 | 存在且可解析 | 在锁内按扩展既有 loader 语义保留或 normalize/升级，写入新文件、验证、再删除旧文件；如有字段丢弃则一并通知 |
| 不存在 | 存在但 JSON 无法解析、根结构无法识别、结构化文本为空，或文件不可读 | 不创建新文件，不删除旧文件，按扩展现有无效配置行为回退并明确告警 |
| 存在且有效 | 不存在 | 只使用新文件 |
| 存在且有效 | 存在且语义等价 | 使用新文件；在锁内验证等价后可删除旧文件 |
| 存在且有效 | 存在但冲突或不可读 | 使用新文件，保留旧文件并明确告警；禁止自动合并或覆盖 |
| 存在但无效或不可读 | 任意 | 不用旧文件覆盖新文件，不删除任一文件，按扩展现有无效配置行为回退并明确告警 |

“语义等价”由各扩展按既有 parse/normalize 语义比较，而不是统一比较原始文件字节。有 schema normalizer 的配置可升级可识别字段并丢弃无法映射、未知或已废弃字段；Todo 与 Ask User Question 原本就是 raw-object loader，因此迁移保留整个有效 JSON 对象及其源字节，避免 `JSON.parse` 可接受但 `JSON.stringify` 会改写的数值（如 `1e400`）静默变化。Subagents 工具描述按 trim 后的结构化文本比较。发生字段丢弃时，通知必须包含旧路径、新路径和被丢弃字段路径；字段过多时可显示计数与前若干项。

### 原子性、验证与并发

- 在目标目录创建同文件系统临时文件，完整写入并设置所需权限后，以 rename 原子替换目标；失败时清理临时文件但保留旧文件。
- 写入后必须重新读取验证。JSON 配置/状态还需执行 JSON 解析、schema/normalize 和语义 round trip；`debug.log` 等非结构化文件按字节内容或校验和验证。Search Hub 的配置与 Exa 状态还必须检查 `0600` 权限。
- 迁移、旧文件删除和状态 read-modify-write 必须使用跨进程互斥。目标目录内通过 exclusive create 建立带单调 ticket、pid 与 UUID 的唯一候选 lock file，由最早 ticket 进入临界区；未获得锁时不得迁移、删除或基于陈旧值写回，应等待有限时间或留待下次访问，并明确告警。
- 过期恢复只在候选超过租期且其 PID 已不存在时，删除对应 UUID 的唯一候选文件；暂停但仍存活的持有者不能被夺锁。禁止通过 `stat(固定路径) → unlink(固定路径)` 回收，以免误删继任者的新锁；恢复后仍须重新读取新旧文件并从状态机起点重新判断。
- 告警在有 UI 时使用 `ctx.ui.notify`，无 UI 模式写入 stderr；同一问题每个进程或 Session 最多报告一次，避免每次工具调用重复刷屏。

### Exa 用量专项一致性

Exa 用量是会持续变化的运行状态，迁移不能与增量更新分开处理：

1. `checkExaUsage()` 和 `incrementExaUsage()` 访问状态前都先解析 canonical agent dir，并进入同一个跨进程互斥区；必要时将现有同步接口改为异步并更新全部调用点，不能为保留同步签名而绕过互斥。
2. 锁内按上述状态机完成旧用量文件迁移，再重新读取 canonical 文件。
3. increment 的 read-modify-write 在同一锁内完成，并通过临时文件、`0600` 写入和原子 rename 提交。
4. 禁止继续吞掉读取、迁移或写入错误；检查调用可带告警继续，增量写入失败必须返回可观察告警，但不得删除旧文件或把损坏内容重置为零。
5. 测试至少覆盖两个并发进程首次迁移、迁移与 increment 交错、进程在写临时文件后退出、过期锁恢复，以及月份切换。

## 非目标

本期明确不做：

- 共享配置/状态存储 package；
- 一个 bundle 级巨型配置文件；
- 统一所有扩展的 schema 或深度合并算法；
- 通用 Secret Store；
- credential 加密、OS keychain 或 password manager 集成；
- 把非 Provider credential 塞入 Pi `auth.json`；
- 移动 `$PI_CODING_AGENT_DIR/plans/`；
- 为当前不支持项目配置的扩展新增项目覆盖；
- 修改 Pi core。

## 实施批次

各批均包含源码、测试、双语 README 和 changeset，现已完成：

1. Search Hub：修正 `getAgentDir()`、配置路径、Exa 状态路径及旧文件迁移。
2. Recap：迁移全局与项目配置路径。
3. Pi Glance：迁移全局配置路径。
4. Tool Display Intent：自动迁移并升级全局配置，同时迁移 `config.legacy.json` 与调试日志，并把后续调试日志写入 `state/debug.log`。
5. Plan Mode：只迁移 `plan-mode.json`，回归验证 `plans/` 路径完全不变。
6. Todo 与 Ask User Question：迁移 XDG/`~/.config` 全局配置，保持各自字段验证与默认语义。
7. Subagents：迁移全局/项目设置和工具描述 override，同时保持 agents、skills、memory、schedules 与 transcripts 等资源路径不变。
8. 全仓扫描旧路径字面量，补齐根 README、示例和发布说明。

## 验收标准

1. 本仓库所有独立配置均可从 `$PI_CODING_AGENT_DIR/extension-data/<extension-id>/config.json` 定位。
2. Recap 与 Search Hub 的项目覆盖位于 `.pi/extension-data/<extension-id>/config.json`，且只在项目受信任时生效；Subagents 的项目设置和工具描述位于 `.pi/extension-data/pi-subagents/`，保持原有项目优先与写入行为。
3. Search Hub 在设置 `PI_CODING_AGENT_DIR` 后，配置与 Exa 状态都写入覆盖目录，不再访问硬编码的 `~/.pi/agent`。
4. Search Hub 的旧配置、credential 与 Exa 用量可安全迁移，不静默丢失；并发迁移与 increment 的测试通过。
5. Search Hub 在不受信任项目中不探测或读取新旧项目配置；切换 cwd 或 trust 后缓存不会泄漏上一项目的 effective config。
6. Tool Display Intent 的 `config.legacy.json` 与 `debug/debug.log` 按迁移表处理，不在旧目录继续写入调试日志。
7. Todo 与 Ask User Question 的旧 XDG/`~/.config` 配置可安全迁移，字段验证、默认值和 guidance 语义不变；Todo 任务历史仍在 Session 中。
8. Subagents 的全局/项目设置及工具描述可安全迁移；custom agents、Pi/native skills/settings、memory、schedules、transcripts 和其他资源路径不变。
9. `$PI_CODING_AGENT_DIR/plans/` 在 Plan Mode 迁移前后保持完全相同。
10. 不产生 `secrets.json`，不改变现有 credential 解析和 Provider `auth.json` 行为。
11. 新旧路径不双写，文档、帮助文本与实现使用同一组 canonical path。
