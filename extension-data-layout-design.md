# Pi 扩展持久化目录统一方案

## 实现状态

已实现：各扩展统一路径、自动迁移升级、trust 边界、迁移通知和回归测试已落地。

本文只约束 `pi-agent-cases` 仓库内扩展的配置与状态路径，不改 Pi core，也不处理仓库外第三方扩展。

## 背景

当前各扩展自行选择持久化位置，配置、状态与扩展源码目录混杂：

```text
~/.pi/agent/recap.json
~/.pi/agent/extensions/search.json
~/.pi/agent/exa-usage.json
~/.pi/agent/pi-glance/config.json
~/.pi/agent/extensions/pi-tool-display-intent/config.json
~/.pi/agent/plan-mode.json
~/.pi/agent/plans/
```

问题不在于文件数量，而在于缺少统一的信息架构：

- 无法从一个固定根目录盘点本仓库扩展的持久化数据；
- 配置、运行状态和扩展源码混在不同层级；
- 部分实现直接拼接 `~/.pi/agent`，没有遵循 `PI_CODING_AGENT_DIR`；
- Search Hub 的配置与 Exa 用量状态分散，且路径帮助文本散落在多处。

## 已确认决策

1. **统一目录，不合并配置文件**：每个扩展继续拥有独立 schema、默认值和迁移逻辑，不引入单体 `extensions.json`。
2. **统一根目录**：仓库内扩展的持久化数据统一进入 `$PI_CODING_AGENT_DIR/extension-data/<extension-id>/`。
3. **暂不建设共享存储层**：本期不新增 `extension-storage` 公共 package；各扩展直接完成自己的路径迁移。
4. **暂不改造密钥机制**：继续保留各扩展现有 credential 字段、环境变量、shell command 和明文值行为；不新增 `secrets.json`、OS keychain 适配或通用 Secret Store。
5. **Provider 凭证不在本方案范围**：Provider 继续使用 Pi 的 `auth.json` 与 `/login` 机制，不迁移、不复制，也不注册伪 Provider 来承载非 Provider 密钥。
6. **Plan Mode 状态是唯一例外**：Plan revision 与 manifest 继续保存在现有全局目录 `$PI_CODING_AGENT_DIR/plans/`，不迁入 `extension-data`；只有 `plan-mode.json` 配置迁入统一目录。
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
│   └── pi-plan-mode/
│       └── config.json
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
```

## 项目级配置

只有当前已经支持项目覆盖的扩展继续保留该能力，本期不为其他扩展新增项目级配置。

```text
<project>/.pi/extension-data/pi-recap/config.json
<project>/.pi/extension-data/pi-search-hub/config.json
```

约束：

- 项目配置覆盖全局配置，合并语义保持各扩展当前行为；
- 项目配置只在项目受信任时读取；未受信任时不得探测、读取或提示新旧项目配置；
- 项目路径实现必须使用 Pi 导出的 `CONFIG_DIR_NAME`，不能硬编码 `.pi`；本文继续用 `.pi` 表示默认目录；
- 配置 UI 的用户编辑仍只写全局文件；但受信任项目中的旧项目配置会自动迁移到新路径。配置预览、覆盖检测、迁移通知和保存后的生效提示必须遵循同一 trust 判断；
- `pi-glance`、`pi-tool-display-intent` 和 `pi-plan-mode` 本期仍为全局配置；
- 运行状态不写入项目 `.pi/extension-data/`。

### 项目旧路径兼容与优先级

只在 `ctx.isProjectTrusted()` 为 `true` 时执行以下判断：

| 新项目路径 | 旧项目路径 | 行为 |
|---|---|---|
| 不存在 | 不存在 | 不加载项目配置 |
| 不存在 | 存在 | 自动解析、升级并原子写入新文件；验证成功后删除旧文件并通知迁移结果 |
| 存在 | 不存在 | 只读取新文件 |
| 存在 | 存在 | 只读取新文件；保留旧文件并提示其已被忽略，不做合并或自动删除 |

项目迁移只在受信任项目中执行。无法映射的旧字段允许丢弃，但通知必须列出被丢弃的字段路径；JSON 无法解析或根结构无法识别时不得删除旧文件。

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
| Pi Todo | Session JSONL custom entries | **保持不变** | 无独立配置文件 |

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

与 Pi Session branch 语义绑定的数据继续使用 `pi.appendEntry()` 或 tool result details，不搬入 `extension-data`。Pi Todo 和 Recap 历史属于此类。

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
5. 受信任项目中的旧项目配置按“项目旧路径兼容与优先级”自动迁移；未受信任时不得探测或修改。
6. 自动迁移成功后不再兼容读取旧路径；迁移失败时保留旧文件供下次重试，不形成永久双路径读取层。
7. 配置文件权限沿用各扩展现有要求；Search Hub 因可能含 credential，目录使用私有权限，配置文件和迁移临时文件必须保持 `0600`。
8. 每个 package 应提供唯一的 package-local 路径模块，供加载、保存、状态、帮助文本和迁移共同使用；“不建设共享存储层”不等于在同一 package 内重复拼接路径。
9. 迁移和状态更新必须考虑多个 Pi 进程并发，不能依赖单进程内布尔标记来证明“一次性”。

### 全局文件迁移状态机

新路径一旦存在，即为 canonical path。迁移不得静默覆盖任一已有文件：

| 新文件 | 旧文件 | 行为 |
|---|---|---|
| 不存在 | 不存在 | 使用默认值；第一次保存只写新路径 |
| 不存在 | 存在且可解析 | 在锁内按当前 schema normalize/升级，写入新文件、验证、再删除旧文件；通知迁移及被丢弃字段 |
| 不存在 | 存在但 JSON 无法解析、根结构无法识别或不可读 | 不创建新文件，不删除旧文件，按扩展现有无效配置行为回退并明确告警 |
| 存在且有效 | 不存在 | 只使用新文件 |
| 存在且有效 | 存在且语义等价 | 使用新文件；在锁内验证等价后可删除旧文件 |
| 存在且有效 | 存在但冲突或不可读 | 使用新文件，保留旧文件并明确告警；禁止自动合并或覆盖 |
| 存在但无效或不可读 | 任意 | 不用旧文件覆盖新文件，不删除任一文件，按扩展现有无效配置行为回退并明确告警 |

“语义等价”由各扩展在 parse、normalize 后比较，而不是比较原始 JSON 文本。迁移统一以当前 schema/normalize 为准：可识别字段升级到当前格式，无法映射、未知或已废弃字段直接丢弃。通知必须包含旧路径、新路径和被丢弃字段路径；字段过多时可显示计数与前若干项。

### 原子性、验证与并发

- 在目标目录创建同文件系统临时文件，完整写入并设置所需权限后，以 rename 原子替换目标；失败时清理临时文件但保留旧文件。
- 写入后必须重新读取验证。JSON 配置/状态还需执行 JSON 解析、schema/normalize 和语义 round trip；`debug.log` 等非结构化文件按字节内容或校验和验证。Search Hub 的配置与 Exa 状态还必须检查 `0600` 权限。
- 迁移、旧文件删除和状态 read-modify-write 必须使用跨进程互斥。实现可采用目标目录内通过 exclusive create 获取的 lock file；未获得锁时不得迁移、删除或基于陈旧值写回，应等待有限时间或留待下次访问，并明确告警。
- lock 必须包含可诊断的 pid/时间信息并定义过期锁恢复；恢复过期锁后仍须重新读取新旧文件并从状态机起点重新判断。
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

## 后续实施拆分

后续独立推进时建议按 package 分批完成，每批包含源码、测试、双语 README 和 changeset：

1. Search Hub：先修正 `getAgentDir()`、配置路径、Exa 状态路径及旧文件迁移。
2. Recap：迁移全局与项目配置路径。
3. Pi Glance：迁移全局配置路径。
4. Tool Display Intent：自动迁移并升级全局配置，同时迁移 `config.legacy.json` 与调试日志，并把后续调试日志写入 `state/debug.log`。
5. Plan Mode：只迁移 `plan-mode.json`，明确回归验证 `plans/` 路径完全不变。
6. 全仓扫描旧路径字面量，补齐根 README、示例和发布说明。

## 验收标准

1. 本仓库所有独立配置均可从 `$PI_CODING_AGENT_DIR/extension-data/<extension-id>/config.json` 定位。
2. Recap 与 Search Hub 的项目覆盖位于 `.pi/extension-data/<extension-id>/config.json`，且只在项目受信任时生效。
3. Search Hub 在设置 `PI_CODING_AGENT_DIR` 后，配置与 Exa 状态都写入覆盖目录，不再访问硬编码的 `~/.pi/agent`。
4. Search Hub 的旧配置、credential 与 Exa 用量可安全迁移，不静默丢失；并发迁移与 increment 的测试通过。
5. Search Hub 在不受信任项目中不探测或读取新旧项目配置；切换 cwd 或 trust 后缓存不会泄漏上一项目的 effective config。
6. Tool Display Intent 的 `config.legacy.json` 与 `debug/debug.log` 按迁移表处理，不在旧目录继续写入调试日志。
7. `$PI_CODING_AGENT_DIR/plans/` 在 Plan Mode 迁移前后保持完全相同。
8. 不产生 `secrets.json`，不改变现有 credential 解析和 Provider `auth.json` 行为。
9. 新旧路径不双写，文档、帮助文本与实现使用同一组 canonical path。
