# 当前集成分支：逐扩展变更与必要性审计

> **比较输入固定**：`upgrade/pi-1.2-compat` 的产品快照 [`24ac1da`](https://github.com/zhcsyncer/pi-extensions/tree/24ac1da88692ed2b0b2dd07c195e4e393f9a727b)，对照主线 [`f48a91b`](https://github.com/zhcsyncer/pi-extensions/tree/f48a91b8366174f2ece5d393e280641be87fbb70)。本文记录最终实际差异和当前判断，不把过程中已撤方案算进去。文档提交本身不改变该产品快照。
>
> **覆盖14个仍维护的子包，以及根包/共享验证设施。** 只排除已明确停止维护的Context7、Plan；Cursor没有停止维护，必须列明其零差异。外部Ollama不属于本仓产品差异，不在本清单。这里不是发布许可、全局切换许可或新修复授权。

## 先读结论

- 不是所有包都改了运行行为：Review无生产源码差异，Cursor包整体已回撤，Volcengine只改运行源码中的类型；Todo、Question、Herdr各只有一行调用范围限制；Search Hub最终只加9处取消检查。
- **“内部状态不同”“测试能变红”“已经实现/被授权”都不等于改动必要。** 要指出既有承诺哪里被破坏、用户实际影响是什么，或明确说明这是新增功能、产品政策、维护简化。
- 当前最应降级的旧判断：Glance关闭后旧对象费用重算只是内部一致性加固，持久账和新界面本来正常；Tool Display内部owner被替换不等于样式被抢，真实共享主题符合用户预期。本次不自动改回代码，但不再以“必修用户故障”给它们背书。
- 复核也纠正了旧描述：Meter主线已有`costKnown`，缺费用本来可标未知；本轮加强非法金额/混合完整度与显隐，不是从零发明未知费用。Tool Display生产路径已向aggregate传入同一NestedStore，重复register会短路，不能以“两个生产存储”要求合并。
- 合成输入并不自动无效：如负费用输入会直接拉低预算、公开readonly接口缺可选方法会漏补读，都有可描述的契约影响；但不能把边界复现写成默认用户已经遭遇的事故。

### 必要性用语

| 判断 | 本文含义 |
|---|---|
| **契约适配** | 为既定目标SDK/公开接口或已承诺输入范围正确工作所需；必须指明契约，不能仅因API更新就套此标签 |
| **合理修复** | 有具体可观察行为错误/失效证据；仍区分真实SDK离线、合成边界、历史与本轮结果，并非一定是升级造成 |
| **产品选择** | 改调用方式、展示范围或默认策略；由用户选择，不是SDK强制 |
| **可选维护** | 公共API替代私有探测、去重复配方、类型收敛等，有维护价值，但未证明旧功能坏掉 |
| **加固／必要性不足** | 内部一致性或额外容错，没有默认用户影响证据；不能以此自动扩大修复范围 |
| **无产品改动** | 仅验证/说明/依赖，或包已完全回撤；不得把历史方案当当前实现 |

“已确认”与“技术必需”是两个维度。下文列的未解决点也不是实施清单；未得到对应授权前不顺手修复。

## 范围索引

各包章节中的源码名相对该节目录；依赖共通项见下一节，避免每包重复长清单。需要恢复精确代码时，以固定SHA的git diff为准，而不是用本文代替实现。

| 包 | 当前主要差异 | 最关键的必要性边界 |
|---|---|---|
| [Fast Mode](#fast-mode) | 请求payload钩子替代provider包装，删除本地参数/预算配方 | 已选范围收缩与简化；副调用和费用估算并非等价 |
| [Subagents](#subagents) | 公共运行时、执行权限、任务配置隔离、恢复、嵌套结算 | 真实权限/时序问题与恢复政策分别判断 |
| [Consult](#consult) | 公开registry调用、取消、watchdog、model-only；预算单位仅澄清 | API整理、行为保护和入口策略不混称SDK必需 |
| [Meter](#meter) | 标准usage读取、持久身份/来源、并发账本、未知金额、边界回退 | 数据完整性、展示政策、兼容加固分开 |
| [Glance](#glance) | 持久费用刷新、未知显示、明暗适配、两个小修、删除说明行 | 旧实例内部费用不是实际计费故障 |
| [Tool Display](#tool-display) | 官方渲染接入、有界缓存、嵌套展示、消息样式与导航 | 性能/展示增强不等适配必需；内部owner不列待修问题 |
| [Search Hub](#search-hub) | 9处取消检查；结构化返回已撤回 | 保留文本与原路由，不再造返回协议 |
| [Recap](#recap) | 公开complete、规范system消息、费用边界说明 | 旧调用/旧systemPrompt本来可用；不入账是已接受限制 |
| [Todo](#todo) | model-only | 有嵌套修改后reload丢任务证据，但限制包含只读查询 |
| [Question](#question) | model-only | 人机交互入口选择，不是Todo那种数据恢复故障 |
| [Herdr Companion](#herdr-companion) | model-only | 长进程继续存活可符合预期，不能单凭此称泄漏 |
| Adversarial Review | 依赖、说明、独立合同 | 没有生产源码改造；发布依赖与原生MCP未验仍需明确 |
| [Cursor Provider](#cursor-provider) | 包内零差异 | 仅回撤本轮改造，不停维护、不卸载 |
| [Volcengine Agent Plan](#volcengine-agent-plan-provider) | 显式compat/目录类型、环境声明 | 运行参数/价格/认证未改，没有线上套餐故障修复 |

## 共通依赖、根包及交付设施

目录：根`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`scripts/`。这些也是集成差异，但不是新增扩展业务能力。正式开发目标为1.2；多数包README写1.1+，Subagents写1.2+，本文不把二者混同，也不因历史任务文件名含1.1就改称当前依赖为1.1。

| 改了什么 | 为什么改 | 是否必要 | 影响与限制 |
|---|---|---|---|
| 开发依赖由Pi 0.86.1转到1.2.0；root overrides固定coding-agent/agent-core/ai/tui/codemode/mcp/telemetry七包 | SDK内部caret依赖不能让不同worker在同一验证中漂移版本 | **既定1.2验证目标的环境对齐** | 正式目标不是1.3，更不是自动更新用户宿主；固定版本本身不保证运行时只有一个副本，还需loader别名/来源验证 |
| 移除旧0.80.3定向override与0.85.0缺pi-server的packageExtension，锁文件更新 | 不把旧SDK补丁带入新解析图 | **目标版本维护** | 旧版本安装兼容不再由这些工作区补丁保证；不是新功能 |
| 新版SDK/TypeBox host peer统一为`*`，开发TypeBox 1.3.27；旧`@sinclair/typebox`开发槽用npm别名映射 | 运行时使用Pi提供的SDK/schema实例，不随插件带私有运行副本 | **宿主加载契约/打包选择** | `*`不是承诺支持任意Pi版本，实际最低版本看文档/SDK。Root与Subagents移走旧TypeBox runtime依赖，Search移走typebox runtime依赖；没有替用户升级全局schema库 |
| 对七个明确的1.2.0 SDK版本更新minimumReleaseAgeExclude | 允许安装已选定但可能尚未达到观察期的目标版本 | **安装策略选择，非功能必需** | 这几个固定版本豁免发布时间等待；不是整个registry都豁免，既有allowBuilds未改 |
| `check-sdk`检查实际物理解析图；`check-loader`检查真实资源发现、宿主警告和模块来源；`check-pack`禁止运行依赖携带宿主包 | 不用manifest字符串/磁盘存在代替真实加载证据 | **验收设施**，有工程价值，不是用户功能 | loader仅注册加载，不触发session_start/工具执行/MCP连接。Cursor仅旧peer范围豁免，物理SDK/运行副本检查不跳过 |
| 冒烟环境由继承process.env改为最小白名单；`run-isolated`使用Linux网络namespace、空profile与loopback | 防止测试读取真实密钥、Herdr socket、用户配置或连外部服务 | **验证安全隔离** | 不是产品运行时沙箱；非Linux不无保护降级。`PI_OFFLINE`只用在明确的目录发现smoke，不替代断网 |
| 增加全包逐叶检查、冻结安装prepare/verify、真实Pi管理的fresh/upgrade安装矩阵 | 分开发现类型/运行/打包问题，并检验实际tarball内容与loader | **验收设施** | 安装准备可联网到公共registry且ignore-scripts；verify使用准备快照，调用方还要确认它匹配被审候选。Review配对安装不能替代正式发布的依赖版本检查 |
| `.gitignore`仅放行受控的Subagents `.pi/agents`测试夹具 | 把模板发现/授权回归纳入版本控制，不误提交其它本地Pi资料 | **测试基础设施** | 不是扩大生产资源发现或开放所有`.pi`文件 |
| 根README、各包双语说明、changesets与计划文档 | 写清兼容范围、用户影响与发布说明 | **交付说明** | 根聚合入口集合未因此删改；停维护包仍在根组成中是另一个发布决策。所有包版本号尚未升级，没有合main/发版 |

### 每包manifest差异定位

| 包 | 相对main的声明变化（不重复源码行为） |
|---|---|
| Fast | 三项Pi dev→1.2，三项host peer→`*` |
| Subagents | 三项Pi dev→1.2；旧TypeBox runtime移除，改host peer＋开发npm别名；Pi peer→`*` |
| Consult | 三项Pi dev→1.2，补TypeBox dev1.3.27；Pi/TypeBox peer→`*` |
| Meter | coding-agent/tui dev→1.2，相关peer→`*` |
| Glance | 三项Pi dev→1.2、peer→`*`；Node20→22.19；正式test:dev加入两份独立脚本 |
| Tool Display | coding-agent/tui dev→1.2，相关peer→`*` |
| Search Hub | 三项Pi dev→1.2、peer→`*`；typebox从runtime移到host peer＋dev1.3.27 |
| Recap | 三项Pi dev→1.2；peer声明本轮未改 |
| Todo | 三项Pi dev→1.2，补TypeBox dev；Pi/TypeBox peer→`*` |
| Question | 三项Pi dev→1.2、TypeBox dev→1.3.27；仅TypeBox peer本轮放宽，Pi peer本来已为`*` |
| Herdr | 三项Pi dev→1.2、TypeBox dev→1.3.27；对应peer→`*` |
| [Review](#adversarial-review) | 三项Pi dev→1.2、TypeBox dev→1.3.27；对应peer→`*`；Subagents依赖范围未随之调整 |
| Cursor | 包内manifest无改；root override影响仓内验证解析，不等于改了本包独立发布依赖 |
| Volcengine | ai/coding-agent dev→1.2、peer→`*`，Node20→22.19 |

## Fast Mode

目录：`packages/pi-fast-mode/`。用户已确认当前范围；仅此前Fast切换了本机来源，其它包没有因此切换。

| 改了什么（旧→新） | 为什么改 | 是否必要 | 影响与代价 |
|---|---|---|---|
| 用`before_provider_request`写请求payload的`service_tier: priority`，替代OpenAI/Codex/xAI的provider重注册；原来只有自定义xAI Completions走payload钩子 | 把“这次请求要求优先级”交还会话请求入口，不替换整条provider实现 | **已选方案＋合理简化**。公开钩子适合该职责，但不能说SDK强制所有Fast扩展这样写或旧普通请求全部失败 | 启用且provider/API受支持时才写priority；关闭/不支持/非对象payload时不覆盖已有tier。模型目录、认证、端点不另改 |
| 删除本地`stream-options.ts`、上下文token估算、4096余量/maxTokens裁剪、reasoning/options拼装 | 不再复制宿主的流参数配方，减少跟随SDK内部变动的维护 | **可选维护，已有明确减复杂收益**；不是修复已证越界计费事故 | 这些边界由宿主接管，不再保证本地旧估算/输出预算公式；不重新定义模型价格 |
| 覆盖范围从provider包装收窄到会话请求钩子 | 明确Fast只控制发出该hook的会话请求，不替所有扩展副调用决定优先级 | **已确认产品选择**，不是免费获得的等价替换 | Recap/Consult直接SDK请求不随之开启；SDK记录费用未必带priority加价，UI估算可能与账单不同。子会话是否加载Fast、读取何种默认值取决于自身资源/设置，不保证父开关传播 |

源码：`extensions/fast-mode.ts`、删除的`extensions/stream-options.ts`。`supportsApi`的provider/API范围、`/fast`/Ctrl+F、逐模型默认名单、原设置迁移并非本轮新增。测试重心转到真实主会话钩子，新增`tests/pi12-main-session.contract.test.ts`，不再保留本地流参数配方测试。依赖见共通表。

证据：`c700228`阶段37项及loader/打包验证；旧代码不是整体不能运行。真实priority服务权限、调度提速和实际账单未验；不要以“FAST”标记或测试通过保证供应商一定执行优先级。

## Subagents

目录：`packages/pi-subagents/`。普通直接子任务在旧实现+SDK1.2上本来能跑；以下把权限、恢复政策、终态和记账分别列出。

### S1 三个编排工具保持直接可调用，因此也能被可选 codemode 调用

| 项 | 内容 |
|---|---|
| 改动前 → 后 | main 的 `Agent`、`get_subagent_result`、`steer_subagent` 没有 `exposure`，SDK 默认是 `direct`：模型看得到，其它工具在它们处于激活集时也能调用。中间提交 `42941ef` 曾给三个工具加上 `model-only`；`8a2ae49` 又删掉。最终相对 main 没有暴露字段变化。 |
| 当时动机 | 1.1 阶段一度不想让脚本编排子任务。后来用户确认直接调用和 codemode 并存，不强制开启 codemode。 |
| 当前必要性 | 用户产品选择。不是 SDK 要求。SDK 把 `model-only` 推荐给“编排其它工具或询问用户”的工具，但默认 `direct` 在 1.2 本来就能被 codemode 调用。撤回 model-only 是拒绝一项升级中新增的限制，不是修好一个旧故障。 |
| 影响与代价 | 父会话里，不开 codemode 时仍是原来的直接调用。若用户自己启用 codemode，脚本可以批量启动、取结果和追加消息。子会话仍把这三个名字放进拒绝名单，不能递归创建子任务。没有新调度器，也没有自动打开 codemode 或 MCP。 |
| 路径与证据 | 暴露字段的加入/删除见 `42941ef`、`8a2ae49` 的 `src/index.ts`；最终 `index.ts` 无 `exposure`。子会话拒绝名单：`agent-runner.ts` 的 `EXCLUDED_TOOL_NAMES`，并进入 `authorization.ts` 的 `deniedTools`。运行证据：`/var/tmp/pi-1.2-review/subagents-orchestration/` 在旧产品上原生 codemode 停在 model-only；后续协调记录称 `fdf9a43` 的编排合同已通过。限制：本审计没有重跑原生脚本，也没有证明“所有脚本失败都会回滚已完成调用”。合同明确不新增自动停止后台任务。 |

### S2 工具子集对嵌套和晚注册调用仍然有效

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 旧执行拒绝装在 `session.agent.beforeToolCall`，并先调用原来的宿主 hook。1.2 的 `ctx.executeTool` 嵌套调用走公开 `tool_call`，不经过这个外层包装。现在子会话加载隐藏扩展，在公开 `tool_call` 上按当前授权拒绝；`turn_end` 再收窄模型可见列表。可见列表不是授权。匹配的是实际胜出的注册、定义和来源，不凭工具名、`readOnlyHint` 或 `mcp` 前缀。 |
| 当时动机 | 保留“角色没允许的工具不能执行”，并覆盖动态注册。 |
| 当前必要性 | 有明确行为理由的修复，但只覆盖已复现的嵌套授权缺口。不是“旧版在 1.2 完全不能跑”。 |
| 影响与代价 | 用户若让子会话通过另一个工具间接执行被禁止的工具，1.2 上旧代码可能真的写入；新代码在该公开路径上拒绝。直接调用的允许读、禁止写，旧 1.2 已经正确，这项不改变那条正路径。代价是授权逻辑比原来的名字集合复杂；静态从注册表排除的内置工具，旧报告没有证明也能绕过，不能把结论扩成所有只读配置都曾失守。`+name` 工具修饰是为了不在构造时冻死晚注册，不是单独的产品功能。旧报告同时记录：这套改动放到 0.86.1 上，连允许的 read 也会变成 tool not found，所以它不是反向兼容 0.86。 |
| 路径与证据 | `src/authorization.ts` 的 `tool_call` 与 `allowsInfo`；`agent-runner.ts` 构造时强制该 hook 已加载，否则拒绝执行。已保存对照：`/var/tmp/pi-1.2-review/old-baseline-report.md`。旧 1.2 嵌套写入留下 `baseline/nested/1.2.0-old/workspace/nested-forbidden.txt`，内容 `FORBIDDEN_WRITE_EXECUTED`。同一配置的直接禁止写没有文件。0.86.1 的公开 router 没有 `ctx.executeTool` / `pi.executeTool`，同一嵌套路径没有跑成，不能说 0.86 上这类绕过已经存在或全部失败。适配版 1.2 的对应写入被拒绝，允许读仍返回见证字符串。限制：这是扩展子集的动态授权，不是 OS 沙箱；本审计没有重放该探针。 |

### S3 恢复时按当前配置授权，显式隔离和角色默认分开，不做旧任务迁移

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 中间实现曾把历史工具清单、deny 和 isolated 继承成恢复上限。最终删除这层交集。named 角色按原配置目录的当前同名定义重新读取；角色缺失或禁用则失败，不回退别的角色。inline 优先调用方这次给出的定义，否则用仍持有的或保存的任务定义，不变成全权限默认角色。`taskIsolated` 只在调用方显式要求且当时确实生效时写入任务约束；角色文件后来取消默认隔离，未显式隔离的任务冷恢复可以使用当前允许的扩展。模型、cwd、system prompt、历史和轮次限额不随授权一起换。已注册工具的放宽或撤销在热续跑生效；需要新加载尚未出现的扩展时，热续跑明确失败，冷恢复或新任务才按当前配置装配。不猜测旧 archive 的扩展所有者，不改 SDK 会话解析器。 |
| 当时动机 | 用户不要历史权限上限，也不要旧版本任务迁移。隔离来源混淆是实施中先红后绿的定点问题。 |
| 当前必要性 | 用户产品选择。角色默认被误存成任务约束，有明确行为理由的修复；“不用历史交集”本身不是 1.2 故障的必修。 |
| 影响与代价 | 同一版本里，用户放宽角色后，热续跑可以使用已经加载的新工具，收窄会拒绝。显式隔离的任务不会因为角色文件后来放开而在冷恢复中获得扩展。用户看不到自动迁移旧 0.86 任务；损坏或路由错误仍失败，不会静默新建会话。代价是热续跑不能魔法加载新扩展，必须看懂“需要新会话”的错误。 |
| 路径与证据 | `authorization.ts` 只保存非秘密身份与当前授权快照；`agent-runner.ts` 的 `currentAuthority`、`savedRole`、`resumeAgent` 的加载面检查；`index.ts` 的 `taskIsolated = params.isolated === true && isolated`；`agent-manager.ts` 透传。隔离来源先红后绿：`/var/tmp/pi-1.2-review/subagents-orchestration/isolation-and-meter-report.md`，固定提交 `6e7b12b`。限制：该红灯是角色默认隔离被固化，不是历史交集在 1.2 上的崩溃日志。旧 0.86 任务迁移没有矩阵，本审计也不声称做过。 |

### S4 每个激活持有自己的角色和设置

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 角色表、pins、默认轮次、worktree 开关等曾是模块级全局，后一个激活或嵌入运行时可以改到前一个。现在 `loadRuntimeConfig` 按调用方 cwd 建立一份配置，manager、构造和 caller-owned runtime 共用这一份。展示名优先用任务自己保存的名称，不再去读另一个激活的注册表。session 绑定到另一个 cwd 时，只重载这一份并重新注册本激活的 Agent 工具。 |
| 当时动机 | 父会话和 Review 的嵌入运行时、或两个目录的任务，不应互相改角色和 pins。用户明确选择不同任务配置隔离。 |
| 当前必要性 | **配置隔离有明确功能理由，但组织成按激活实例不是SDK强制。** 不同cwd原本就可有不同角色和pins，不能像全局同一主题那样简单视为同一配置。本审计没有改前用户事故日志，不能写成已复现生产故障；也不能只因缺线上样本就抹掉维护不同配置的契约价值。 |
| 影响与代价 | 一个仓库里的角色、pins 和设置不会被另一个 cwd 的子运行时覆盖。读旧报告时，展示名来自保存的任务，而不是“谁最后加载了角色表”。代价是实现更多按激活传递配置；没有新增动态 loader。 |
| 路径与证据 | `runtime-config.ts`、`runtime.ts`、`agent-types.ts` 的 registry 参数、`index.ts` 的 `applyRuntimeSettings`、`agent-widget.ts`、`session-archive.ts`。独立合同里有两个 cwd 交错的断言，见 `pi11-permissions.contract.test.ts` 的用例名。限制：本审计没有重跑该合同，也没有旧的串扰现场。 |

### S5 回合上限的收尾提示进入最终请求

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 软上限到达后，旧代码装饰 `prepareNextTurnWithContext` / `prepareNextTurn`。1.2 在那之后用会话条目重建请求，注入进不了模型看到的最终上下文。现在改装饰 `prepareRequest`，不把提示写进持久历史，也不因此多开一轮或消费用户队列。软上限、宽限轮数和硬停止政策没有改。 |
| 当时动机 | 1.2 上“快到轮次上限就收尾”的提示消失，但结果仍可能报告已经 steered。 |
| 当前必要性 | 有明确行为理由的修复。只证明提示丢失，不证明硬上限失效。 |
| 影响与代价 | 同样 `max_turns: 1` 且第一轮调用工具后，旧 0.86 有 “Wrap up immediately”；旧 1.2 没有这句，但仍报 `steered: true`；适配后的 1.2 有这句并正常完成。用户看到的收尾行为回到升级前的意图。没有改默认宽限轮数。 |
| 路径与证据 | `agent-runner.ts` 的 `executeAgentSession`。SDK：`@earendil-works/pi-agent-core` 1.2 README 写明每次对话请求前跑 `prepareRequest`，并用它安装最终上下文。对照报告：`/var/tmp/pi-1.2-review/old-baseline-report.md` 第 3 节。限制：该对照只验提示是否出现，没有覆盖所有模型的请求投影。 |

### S6 追加消息区分“已排队”和“被扩展吃掉”

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 旧 `steer` 被当成没有结果的 Promise。1.2 公开返回 `"queued"` 或 `"handled"`。现在保留这个结果：扩展已处理则告诉用户没有排队给模型；SDK 排队则告诉用户会在当前回合和工具调用之后进入。拒绝仍是错误，不新增一个成功的 rejected 值。同步 `manager.steer()` 只表示接纳，不是送达回执。投递 Promise 在成功或失败后才从占位集合移除。 |
| 当时动机 | 避免把已处理的输入说成已送给模型，或在投递尚未结束时放行下一次执行。 |
| 当前必要性 | 有明确行为理由的修复，仅限回执失真。旧 steering 本身在 1.2 不是不能用。 |
| 影响与代价 | 用户和父模型能区分“扩展消费了”和“已排队”。旧对照里，两种结果都返回 `undefined`，但排队消息仍进入 provider，被 input handler 消费的消息仍不进入。所以这不是“旧版追加消息失效”。命令 `/blocked` 在新旧上都拒绝排队。 |
| 路径与证据 | `agent-manager.ts` 的 `queueSteer`、`sendMessage`；`index.ts` 的 steer 工具文案；`agent-runner.ts` 的 `steerAgent` 改为返回 SDK 结果。对照：old-baseline-report 第 4 节。SDK `docs/sdk.md`：`steer()` 返回 queued 或 handled。限制：该对照没有跑 manager 的并发停止和恢复竞态。 |

### S7 父脚本取消时，等当前嵌套 Agent 真正结束

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 原生 codemode 取消时，外层结果可以在子 Agent 的 provider 还被挡住时就返回。现在每个激活按公开 `tool_execution_start/end` 的父子链，只把带 `parentToolCallId` 的 `Agent` 调用放进该 root 的等待集合。root 的 `tool_result` 等到这些调用的 `tool_execution_end`。已返回 ID 的后台任务自然离开集合，后台 child 本身不进入 helper；`get_subagent_result` 的等待也不进入。另一个 root、直接的 root Agent 不会等待自己或全局任务。 |
| 当时动机 | 取消后再记账或放行后继时，子调用的用量和状态还没落定。 |
| 当前必要性 | 有明确行为理由的修复。范围就是这条时序，不是所有取消政策。 |
| 影响与代价 | 用户取消一个还在跑的前台嵌套 Agent 时，父调用会等到该子调用的执行结束事件，而不是在虚拟机已停、provider 尚未放开时就返回。已经拿到 ID 的后台任务不会被这个等待拖住，取消取结果的等待也不会杀掉后台 child。1.3 复验仍看到 root 结果先到、child provider 后放开的窗口，所以不能用“1.3 已修好”删除它。代价是前台嵌套取消变长；它不等待整个 manager。 |
| 路径与证据 | `nested-agent-settlement.ts`；`index.ts` 三处公开事件。先红后绿：`/var/tmp/pi-1.2-review/subagents-orchestration/cancel-barrier-report.md`，提交 `923045a`。改前真实 SDK 2 失败 / 4 通过，失败是 codemode → Agent 以及中间层 → Agent 的 `parent.abort` 提前返回。1.3 同一窗口：`/var/tmp/pi-1.3-review/REPORT.md`。限制：本审计没有重跑；没有测第三个 worker 容量或 Bun 终止。 |

### S8 取消状态、资源释放和文案

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 旧代码把 `aborted` 文案写成“超过轮次上限”，把 `stopped` 写成用户停止。现在内部取消、外部 abort 和硬上限都可以表现为 aborted；没有明确轮次原因时，通知、状态注记、对话查看和工具结果都只说已中止。`agent_settled` 只标记取消意图。真正放行要等 `waitForIdle` 和已经发出的 abort。`abortAndWait` 在停止已经发出但执行尚未结束时也会等。关闭会话仍先 `abortAll`，然后 `waitForAll` 再 `dispose`。旧代迟到的停止或用量不能改写新一代。失败或中止的任务不能靠 `sendMessage` 自动续跑，必须显式 resume。 |
| 当时动机 | 1.1 的 abort 不再只表示轮次上限；通知到达不等于 prompt、abort 和 idle 都结束。 |
| 当前必要性 | 文案：有明确行为理由的修复，因为同一状态现在覆盖非轮次取消；没有单独的用户截图。资源等待：有代码上的时序理由；manager 级旧缺陷没有在 old-baseline 里完整复现，不能说旧 1.2 manager 已全面失败。 |
| 影响与代价 | 用户取消时，界面可以先显示已中止，但结果等待、关闭和会冲突的后继要等实际停稳。关闭路径会中止子任务并等待执行承诺结束；若abort/provider本身不结束，关闭可能被拖住。这里不是已证明所有平台、所有外部资源都能及时退出的保证。这不是新的“退出时保留后台任务”政策。 |
| 路径与证据 | `status-note.ts`、三处 UI、`completion-notification.ts`、`agent-runner.ts` 的 `abortSession` / `waitForIdle`、`agent-manager.ts` 的 `abortAndWait` 与代次守卫、`index.ts` 的 `session_shutdown`。old-baseline 只看到公开 `session.abort()` 后 provider 收到 signal，并明确没有跑 manager 并发停止。限制：关闭等待没有单独的挂起事故记录。 |

### S9 用量按持久条目计一次，混合父结果另带本次增量

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 旧累计主要把 assistant `message_end` 当增量相加。现在从子会话 journal 重建累计：assistant、外层 toolResult、独立 usage，以及 compaction / branch_summary 上明确的生成费用。身份是子会话 ID 加 entry ID。重复打开同一条目得到同一累计，不产生新的可计费增量。水位只升不降。父工具结果仍带 cumulative 水位；新增 `reportedUsage`，内容是这次 claim 返回的 native usage 增量，不是累计。嵌套结果不另加一份 usage，只在 SDK 已经汇总到父 message 时附上收据。 |
| 当时动机 | 避免 reload 再加一遍，避免把 nested 分解和外层汇总加两次；Meter 不认识 codemode 父结果里的子份额，会把混合费用再加子账。 |
| 当前必要性 | `reportedUsage` 增量：有明确行为理由的修复，但是 Meter 配套，不是 Subagents 单独能完成的账。journal 身份和水位：有明确的重复记账理由，但没有旧 1.2 日常任务已经重复扣费的失败日志。把工具结果和摘要生成费纳入子账，是记账范围选择，不是已证明的“旧 assistant 累加在 1.2 上算错了每一笔”。 |
| 影响与代价 | 用户在父会话看到的子任务费用应能包含已持久的工具和摘要费用，并且重复查询、重启不重复加。子累计读取整个子会话journal；父侧“已报告多少”的水位原本就按当前父分支收据重建。本轮新增识别收据刚落盘就离开分支的路径，并清理相应内存预留，不能把这两种范围混称跨整个父会话的永久去重。混合 codemode 结果若只有新字段、Meter 仍按整笔父结果再加子账，用户仍会看到重复。本分支另有 Meter 扣份额改动；对应见Meter M15。已保存探针：子 0.05 加父工具 0.02，SDK 总额 0.07，旧 Meter 记 0.12；续跑后 SDK 0.09，旧 Meter 0.16。配套后两边都是 0.07 然后 0.09。缺增量或增量无效时不猜、不拿累计相减。SDK 原始 usage 和历史日志不改。 |
| 路径与证据 | `usage.ts` 的 `readSessionUsage`、`usageWatermark`；`usage-reporting.ts` 的 `observeToolResult`、`finalizeMessage`、`reportedUsage`；`index.ts` 的事件接线。探针：`isolation-and-meter-report.md`、`meter-companion-report.md`。1.3 报告确认 codemode details 仍不是子增量收据，SDK 没有替代这个生产者。限制：费用是离线 fixture，不是服务商账单。本审计没有去掉配套再跑对照。 |

### S10 当前版本的合法压缩历史可以恢复，损坏仍失败

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 旧校验要求 compaction 的 `firstKeptEntryId` 已经在先前条目里。1.2 会话格式允许 retain-none：该字段等于 compaction 自己的 ID，表示不保留更早消息。现在允许这个自身 ID，也按版本接受旧的 `firstKeptEntryIndex`。损坏 JSONL、未知类型、非法前向引用、cwd 或 ID 不匹配仍失败，不新建会话。恢复前去掉 SDK 会再次追加的 cwd 后缀，避免提示里出现两段工作目录。会话 ID 额外要求字母数字和 `._-`。 |
| 当时动机 | 合法的 retain-none 历史不应被自己的校验拒绝；恢复不应把 SDK 追加的 cwd 再嵌一次。 |
| 当前必要性 | retain-none 与旧索引：有明确行为理由的修复。依据是 SDK 格式和旧校验的互斥，不是一份真实用户会话失败。ID字符集收紧：防御性输入约束。它会拒绝集合以外的自定义ID；其必要性应依据格式/路径安全契约，而不是要求先有事故。本次没有给出该正则不可替代的理由，也不据此建议删除。 |
| 影响与代价 | 用户可以把“压缩后没有保留旧消息”的当前版本子会话恢复出来。损坏或指错目录仍得到明确错误。若 SDK 把 cwd 渲染成末尾的 `<cwd>` 块，旧剥离只认识 “Current working directory:” 行，恢复后可能重复工作目录；新代码两种后缀都剥一次。1.2 `system-prompt.js` 确实把 cwd 渲染成 `<cwd>` 节。限制是本审计没有跑一次双后缀恢复来观察用户可见文本。 |
| 路径与证据 | `agent-runner.ts` 的 `validateSessionFile` 与 restore 后缀剥离。SDK `docs/session-format.md`：retain-none 把自身 ID 放进 `firstKeptEntryId`。`system-prompt.js` 第 110–126 行附近渲染 `<cwd>`。限制：没有旧用户会话样本。 |

### S11 内部用量回调不从 RPC 选项里传出

| 项 | 内容 |
|---|---|
| 改动前 → 后 | `onSessionUsage` 是新增的内部累计回调。RPC spawn 选项类型把它和既有内部回调一起排除。 |
| 当时动机 | 不让内部回调穿过已有传输边界。 |
| 当前必要性 | 可选维护。它保持“RPC 不携带函数回调”的既有边界，不是用户可见功能，也没有单独的失败日志。 |
| 影响与代价 | 跨扩展调用方不会看到或必须实现这个回调。不改变 RPC 协议字段的用户语义。 |
| 路径与证据 | `cross-extension-rpc.ts` 的 `RpcSpawnOptions`。限制：本审计没有跑跨进程 RPC。 |

## Consult

目录：`packages/pi-consult/`。

生产源码行数：`execute.ts` +19/−92，`messages.ts` −2，删除 `pi-compat.ts` 55 行，`consult.ts` +3，`context.ts` 净 0。合计 −127。README、文档、package.json 和测试不计入这 127。

### C1 用公开 registry 流接口替换私有探测和 pi-ai 回退

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 旧代码先探 `modelRegistry.runtime.streamSimple`。探到时，请求不带预检 key/headers，由 runtime 在请求时解析认证。探不到才动态 import `@earendil-works/pi-ai/compat` 或包根的 `streamSimple`，并把预检得到的 key/headers 传进去。没有 key 且没走 runtime 时，返回 no API key。现在生产路径使用 `ctx.modelRegistry.streamSimple`，请求只带 signal 和 effort。预检仍调用 `getApiKeyAndHeaders`，但只用于提前失败，不把 key 回灌。删除 no API key 文案和整份 `pi-compat.ts`。 |
| 当时动机 | 用户要求不再探私有对象，改用扩展公开入口，同时保留所选 provider 和账号/订阅认证。 |
| 当前必要性 | 可选维护。它有公共 API 整理价值，不是已复现的认证故障修复。旧主路径在 runtime 存在时已经是请求时认证。1.3 `ModelRegistry` 仍有实例字段 `runtime`，`streamSimple` 仍调用 `this.runtime.streamSimple`。TypeScript private 不会在运行时抹掉该字段，旧探测在 1.3 上仍可能成功。 |
| 影响与代价 | 正常宿主上，顾问仍走所选模型的 registry 认证，包括凭据派生的 endpoint/headers。不再有一条“公开入口失败就改用裸 pi-ai”的退路；若有人依赖那条退路绕过 registry，现在会失败。把预检 key 传进请求可能改掉 OAuth 渠道，旧 runtime 路径本来就没有这么做，新路径保持不传。缺失或错误配置仍失败，不改去另一个账号。测试注入的 `opts.streamSimple` 仍在，不能用它代替生产路径已经迁移的证据。 |
| 路径与证据 | 删除的 `src/pi-compat.ts`；`src/execute.ts` 的 `requestOptions` 与 `streamSimple` 选择。1.2/1.3 `model-registry.d.ts` 写明公开 `streamSimple` 使用 request-time authentication。1.3 `model-registry.js` 第 9 和 75 行仍保存并调用 `this.runtime`。扩展文档要求嵌套模型调用使用 `ctx.modelRegistry.streamSimple()`。限制：没有真实账号或网络请求。离线认证测试观察的是假 provider 收到的字段，不能外推所有 OAuth 厂商。 |

### C2 顾问工具改为 model-only

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 注册没有 exposure，默认 direct，嵌套工具可以调用它。现在 `exposure: "model-only"`。普通直接调用仍可用。安装本包不开启 codemode。 |
| 当时动机 | 合同要求顾问只由主模型直接调用，脚本或其它工具不能启动顾问请求。 |
| 当前必要性 | 用户产品选择。SDK 说明 model-only 适合编排或询问用户的工具，但没有要求 Consult 必须使用它。0.86 文档没有这个暴露级别。它不是 Todo 那种“撤限后状态恢复失败”的实测结果，不能套用。 |
| 影响与代价 | 用户仍可直接让主模型 consult。codemode 或其它工具里的嵌套调用由宿主拒绝，顾问请求不会发出。若用户希望脚本征求第二意见，现在做不到。不开 codemode 的直接路径不变。 |
| 路径与证据 | `extensions/consult.ts` 的 `registerTool`。SDK 1.2 `docs/extensions.md` Tool exposure：model-only 对模型可见，但 `ctx.executeTool` 不能调用。限制：本审计没有重跑嵌套拒绝用例。 |

### C3 watchdog 只计顶层工具事件

| 项 | 内容 |
|---|---|
| 改动前 → 后 | `tool_execution_start/end` 不看父调用。现在有 `parentToolCallId` 就返回，不进入 tracker。阈值、Consult 自身不自触发、结束后清空 fingerprint，这些规则没有改。 |
| 当时动机 | 避免嵌套子事件和外层事件各计一次，也避免嵌套 Consult 的结束事件清掉顶层状态。 |
| 当前必要性 | 用户产品选择。它有清楚的重复计数理由，但本审计没有改前失败日志。不是 SDK 要求 Consult 必须过滤；0.86 扩展声明里没有这个父调用字段，过滤在旧宿主上应是空操作。 |
| 影响与代价 | 一个外层工具里的多次嵌套调用，不会提前逼用户去 consult。外层自己的重复或连续错误仍计数。若用户把嵌套失败也想计入 watchdog，现在不会。 |
| 路径与证据 | `extensions/consult.ts` 两个 handler。限制：没有保存的旧 watchdog 误触发记录。 |

### C4 取消后不再开始新的顾问请求

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 旧请求把 signal 传给流，但空响应重试前不检查是否已取消；认证等待结束后仍会占预算并进入 panel。现在每次物理调用前、认证循环前、占预算前都检查 signal。已取消的抛错记成 cancelled，而不是普通 throw。已开始的调用失败或取消仍占已记下的那一次预算。 |
| 当时动机 | 合同要求取消后不新发请求，包括空响应重试。 |
| 当前必要性 | 有明确行为理由的修复，仅限“取消后的下一次 call()”。证据是旧重试路径没有 abort 检查，不是一份改前用户日志。不要把它写成整个 Consult 迁移都由 SDK 强制。 |
| 影响与代价 | 用户取消后，不应再看到一次新的顾问请求或空响应重试。认证尚未完成就取消，现在不占调用预算；已经进入请求阶段后取消仍占一次。用量仍汇总已实际发生的请求。 |
| 路径与证据 | `execute.ts` 的 `call()`、`executeConsult` 认证循环和占预算前检查。限制：没有改前红灯日志。信号是否真到达厂商，只在离线合同里用假 provider 观察过，本审计未重跑。 |

### C5 一次 consult 占一个调用预算：代码未改

| 项 | 内容 |
|---|---|
| 改动前 → 后 | `tracker.recordConsult()` 仍在进入 panel 前调用一次。fanout 和内部空响应重试不另调用它。README 和扩展文档把“按已开始的顾问请求计数”写成“每次进入请求阶段的 consult() 占一个单位，fanout 和空响应重试包含在这个单位内”。 |
| 当时动机 | 独立测试曾把 perRun 理解成物理请求次数。合同要求纠正测试解释，不改产品计数。 |
| 当前必要性 | 无产品改动。文档澄清有维护价值，不能写成预算政策修复或 SDK 要求。 |
| 影响与代价 | 用户看到的次数限制与改前代码一致：一次调用里的多路顾问和一次空响应重试，仍只占一个名额；所有物理请求的 token 仍汇总。唯一相邻的行为差是 C4：认证期间取消不再占这一次。 |
| 路径与证据 | `src/tracker.ts`、`src/budget.ts` 不在 diff。`execute.ts` 仍是一处 `recordConsult()`。文档 diff 在 README 与 `docs/pi-consult/extension.md`。限制：没有用真实 panel 复测次数。 |

## Meter

目录：`packages/pi-meter/`。

跨会话本地账本。旧路径已经会记 assistant、带 usage 的 toolResult、Consult 原始顾问用量、带 usage 的 compaction / branch summary，并排除整个 `Agent` 结果和带 version 1 marker 的 `get_subagent_result`。新改动是在这之上换持久身份、补独立 usage、以及若干读侧/去重策略。



### M1. 读取标准日志里的独立 usage

| 项 | 内容 |
|---|---|
| 前 | 实时只在 `message_end` 拆消息，在 compact/tree 事件上拆摘要。`parseSession` 不认识 `type:"usage"`。Pi 已写入的独立用量条目被跳过。 |
| 后 | `usageRecordsFromSessionEntry` 读取持久 `type:"usage"`，保留 `usageKind`，未知 kind 也计。费用仍来自该条目的 `usage.cost`。 |
| 动机 | Pi 1.1 的 `UsageEntry` 是公开持久记录，kind 可以是 `cache_warm` 或尚未认识的字符串；旧消息路径根本看不到它。 |
| 当前必要性 | **公开契约必需**。这是补读已有日志，不是新定价器。 |
| 用户影响 | 会话里已经写下的独立操作会出现在本地账本、看板和预算里。没有被 Pi 写入日志的旁路费用仍然没有。空闲期间新写入的 usage，要到下一次捕获边界或 `/usage` 才出现，不承诺瞬间刷新。 |
| 工程代价 | 解析多一个分支；捕获必须看 entries，不能只看事件里的 message。没有新增预热请求、轮询或价目。 |
| 源码 | `session-parser.ts` 的 `usageRecordsFromSessionEntry`；SDK `session-manager.d.ts` 的 `UsageEntry.kind`。 |
| 证据与限制 | 合同用真实 `SessionManager.appendUsage`。三模型审阅确认这是补漏，不是自定价。用户暂不做缓存预热专项；README 里的 “standalone usage” 只表示这类标准条目会被读到。 |

### M2. 用持久化之后的生命周期边界入账，不再吃 message_end

| 项 | 内容 |
|---|---|
| 前 | `message_end` 立刻把事件里的 message 入账。此时宿主还没 `appendMessage`。compact/tree 只记事件上的那一条摘要。 |
| 后 | 去掉 `message_end` 入账。改为 `session_start`、`turn_end`、`agent_settled`、`session_compact`、`session_before_tree`、`session_tree`、`session_before_switch`、`session_before_fork`、`session_shutdown` 和 `/usage` 命令读取已持久 entries。底栏空闲轮询仍只刷新配额缓存，不扫会话。 |
| 动机 | SDK 先把 `message_end` 交给扩展，允许原地替换 message，然后才 `appendMessage`。`turn_end` 才用已持久的 `messageEntryId`。在 message_end 入账可能记下最终不会落盘的中间值，也还没有 entry id。 |
| 当前必要性 | **有直接行为理由修复**的是“不要在落盘前入账”。具体挂哪些边界是为了在切会话、fork、tree 之前把已落盘尾部收进来，属于配套，不是另一套轮询产品。 |
| 用户影响 | 同一回合的最终落盘值只进账一次。扩展若在 message_end 改了 usage，账本跟随落盘结果，不跟随中间对象。没有公共事件时，空闲新增 usage 不会立刻出现。 |
| 工程代价 | 每次上述边界读 entries 副本。失败会提示并留到下一边界重试，游标不前移。不是每帧扫描。 |
| 源码 | `extensions/meter.ts` 事件表；`agent-session.js` 约 756–768 行先扩展、后 `appendMessage`；`_dispatchTurnEndBoundary` 约 488–514 行要求已持久 id。 |
| 证据与限制 | 顺序是 SDK 源码事实。本仓库生产里没有发现会改 usage 的后置 message_end handler，不能写成已经发生的用户事故。Grok 提出的“只靠 turn_end 几个 id 就删掉捕获层”没有证明能覆盖独立 usage、摘要、复制来源和切会话，本条不据此宣称捕获类不可简化，也不宣称它整层必需。 |

### M3. 新记录用 entry id，相同内容不再并成一笔

| 项 | 内容 |
|---|---|
| 前 | 身份由时间、sid、模型、sourceId组合。内容/金额相同会被旧 legacy 匹配拿去抵扣。时间或 responseId 不是持久记录身份。 |
| 后 | 有 `entryId` 时，身份是 `sid + entryId + part`。两条 entry id 不同、其余完全相同，记两笔。同一 entry 重复读取、live 后再 import、顺序相反，只记一次。 |
| 动机 | 两笔合法消耗可以有相同 payload；同一笔消耗被 live 和 import 各看一次时，不能靠时间和金额猜它们是不是同一笔。 |
| 当前必要性 | **公开契约必需**，限于新记录。旧行没有 entry id，不能靠这条把历史重复全部修好。 |
| 用户影响 | 重载、改名副本、再次 import 不会把同一条新 entry 再记一笔。两条真不同的相同请求都会留下。 |
| 工程代价 | 账本多一个可选身份字段。新行序列化在数组第 14 位带 `{entryId,part,usageKind}`。旧行没有该字段时仍走旧 key。 |
| 源码 | `session-parser.ts` `recordKey` / `usageRecordsFromSessionEntry`；`types.ts` `entryId`；`store.ts` `serializeUsageRecord`。 |
| 证据与限制 | `pi11-ledger.contract.test.ts` 的 stable identity 组。这不是 M4 的会话 id，也不是 M5 的 Consult 槽位。 |

### M4. 会话身份用 header id，文件名只做别名

| 项 | 内容 |
|---|---|
| 前 | 实时 `sessionIdFrom(会话文件名)`。import 用文件 basename 当 sid。文件改名或 live/import 身份不一致时，同一会话会拆开或重计。 |
| 后 | 新记录用 `getSessionId()` / 会话头 id。已读文件把 basename 映射到 header id。读旧行时，若该行没有 entry id 且 sid 是已知文件名别名，读侧改挂到 header id。不改磁盘上的旧行。 |
| 动机 | 文件名不是会话身份。Pi 1.1 的稳定身份在 session header。 |
| 当前必要性 | **有直接行为理由修复**，限于“同一 header 经不同文件名或 live/import 两条路径”。从不改名、且文件名本来就等于 header id 的用户，看不出差异。 |
| 用户影响 | 重命名副本再 import，不会变成第二笔新消耗。旧账本行仍在。不能承诺所有历史漏记或历史重复都被修好。 |
| 工程代价 | import 和会话启动会读文件头。别名表只活在本次捕获/导入，不是全局来源库。 |
| 源码 | `meter.ts` `getSessionId()`；`session-source.ts` `fileAlias` / `aliases.set`；`store.ts` `readAll` 的无 entryId 别名替换；`diffRecords` 的 `sessionAliases`。 |
| 证据与限制 | 合同 “same header through two filenames”。来源文件读不到时不会猜。与 M6 的复制来源不是同一件事：这里只统一会话 id，不判断条目是不是从父会话复制来的。 |

### M5. Consult 拆分用原始 raw 下标

| 项 | 内容 |
|---|---|
| 前 | 已经按顾问模型拆分，不用主模型顶替。sourceId 用过滤后的序号：没有 usage 的 raw 槽会被跳过，后面的槽位编号前移。 |
| 后 | sourceId 和 `part:"raw:N"` 都用原始数组下标。没有 usage 的槽不产生记录，但它占用的下标不会被后面的顾问复用。外层 tool usage 在有 raw 时不另加。 |
| 动机 | 同一顾问槽位后来补上 usage，或中间有未付费/失败槽时，过滤序号会把同一次 fanout 看成新消耗。 |
| 当前必要性 | **有直接行为理由修复**，只针对 raw 数组有空洞的 Consult。普通整条 entry、非 Consult 工具不受影响。 |
| 用户影响 | 同一条结果的raw槽位在过滤前后保持身份，不把后面的顾问槽位错并或错当新槽。不同tool调用、不同entry产生的新消耗仍应分别计入；不能概括成“顾问重试不再计费”。 |
| 工程代价 | 多一个 `part` 字段。身份比“模型+金额”更细，也更依赖 raw 数组顺序稳定。 |
| 源码 | `session-parser.ts` `toolResultRawUsage` 的 `index`，以及 `part: raw:${raw[index].index}`。 |
| 证据与限制 | 合同用 slot 0 无 usage、slot 1/2 有 usage，断言与后来三槽都有 usage 的后两槽 key 相同。没有真实 Consult 账单样本。旧的“按顾问归属”本身不是新功能。 |

### M6. fork / 分支克隆沿复制结构归回来源，而不是归给新项目

| 项 | 内容 |
|---|---|
| 前 | 没有读 `parentSession`。fork 若保留 entry id 但使用新 header，按新 sid 会把复制来的旧消耗再记进新项目。 |
| 后 | 读父会话文件。仅当 id、类型相同，且父链一致（中间可以去掉 label 并重接 parent）时，把该条算作来源会话/目录的消耗。新尾部仍算目标项目。父链接但 entry id 是新的普通子会话，不继承历史。来源对不上不猜。 |
| 动机 | SDK `forkFrom` / `createBranchedSession` 会保留 id 并写下 `parentSession`。Meter 是跨会话账本，sid 又参与身份，不认复制结构就会把旧账算进新 cwd。 |
| 当前必要性 | **有直接行为理由修复**，限于真的走了 fork/克隆并且之后被 Meter import 或启动捕获。Glance 不需要这层，因为它只显示当前会话内存。 |
| 用户影响 | 跨项目 fork 时，复制部分留在来源项目，新尾部留在目标项目。两个互不链接、只是碰巧 id 相同的文件仍然各记各的。 |
| 工程代价 | 启动和 import 会顺着 parentSession 读文件，有环则停。不是每帧 IO，也不是全局证明库。纯解析函数不隐式读盘；读盘在 `readSessionSource`。 |
| 源码 | `session-source.ts` `copiedOrigins` / `readSessionSource`；`capture.ts` 初次捕获填 `origins`。 |
| 证据与限制 | 合同用真实 `SessionManager.forkFrom` 和 `createBranchedSession`。来源断链时跨 fork 归并有限，Kimi 审阅已指出。不能写成所有历史归属都已精确修复。 |

### M7. 同一身份跨进程只追加一次

| 项 | 内容 |
|---|---|
| 前 | `append` 直接 `appendFile`，没有账本锁。两个 store 或 live 与 import 同时写，可能各写一行。 |
| 后 | 进程内队列串行，目录锁 `.usage.lock` 内再读再写。同一 `recordKey` 已在账本或本批出现则跳过。 |
| 动机 | 本地账本可以被另一个 Meter 实例、import 和实时捕获同时追加。没有锁时，相同新身份会变成两行。 |
| 当前必要性 | **有直接行为理由修复**。这是单机文件锁，不是分布式账本框架。 |
| 用户影响 | 两个正常 store 对同一临时账本追加同一新身份，只有一次有效。用户看不到“锁”，只看到不重复。 |
| 工程代价 | 每次追加或读取都要进队列并可能抢目录锁。锁失败会让这次捕获失败并留到下一边界。 |
| 源码 | `store.ts` `serial` / `appendRecords` / `withDirectoryLock`。 |
| 证据与限制 | 合同 “two normal store instances”。不证明多机共享目录安全。与 M8 的“旧重复行是否删掉”是两件事。 |

### M8. 旧重复行只在读时折叠，不再改写或删除原账

| 项 | 内容 |
|---|---|
| 前 | 启动 `compactDuplicates` 会重写账本并删重复行。import 发现重复时 `replaceAll`。迁移复制旧文件后 `unlink` 原文件。import 报告会说删除了多少重复行。 |
| 后 | 读时 `collapseDuplicateRecords`，预算仍按折叠后的旧口径。`compactDuplicates` 固定返回 0。import 只追加新行。迁移复制后保留原 legacy 文件。 |
| 动机 | 换新身份时不能借机重写或删掉用户已有账本；旧重复行若被重新计入，又会抬高既有预算。 |
| 当前必要性 | **有直接行为理由修复**的是“不要因为新身份把旧重复行重新加进预算”。不删除原文件是 **可选维护**：避免适应身份变成破坏性迁移。 |
| 用户影响 | 磁盘上的旧重复行还在。预算小计仍按旧的读侧折叠，不突然变大。import 不再报告“removed duplicate ledger rows”。legacy 原路径文件还在，但不会被当成第二本活动账，只要新路径已经有副本。 |
| 工程代价 | 账本文件可能比旧逻辑更长。读侧要继续懂旧格式。不能把“不回写”宣传成历史已经逐笔修复。 |
| 源码 | `store.ts` `refresh`、`compactDuplicates`、`migrateLegacyLedger`；`meter.ts` import 不再 `replaceAll`。 |
| 证据与限制 | 合同把重复旧行写回文件后，读侧小计仍是一笔，文件字节保持重复。没有迁移用户真实账本。 |

### M9. 只读门面没有 getEntryCount 时，不能只顺着当前叶往回走

| 项 | 内容 |
|---|---|
| 前 | 新捕获层若不做这个分支，两次捕获之间如果先追加、再切到别的旧分支或切回旧叶，叶行走看不到那条新 entry，要等以后再访问那片叶才补上。 |
| 后 | `Readonly` 类型上没有 `getEntryCount` 时，用 `getEntries()` 过滤尚未见过的 id，而不是只走当前叶。默认宿主实际有 `getEntryCount()`，那条快路径仍走叶行走。 |
| 动机 | 追加可以发生在当前叶以外。没有总数时，不能用“叶没变”判断没有新条目。 |
| 当前必要性 | **有直接行为理由修复**，仅限缺少计数方法的只读门面。对默认 Pi 是 **防御性加固**。不能说默认 Pi 已经丢账：默认宿主有 count，而且 `session_before_tree` 会在切树前先捕获。 |
| 用户影响 | 只有宿主把 SessionManager 收成没有 count 的只读面、并且两次捕获之间改了分支时，才会少记到下一次访问。默认界面不在这个条件里。 |
| 工程代价 | 该分支每次捕获全量过滤 id。正常有 count 且条数未变时直接返回，不全量扫。 |
| 源码 | `capture.ts`：`getEntryCount` 缺失时 `getEntries().filter(id 未见)`。注释写明 public SessionManager 有该方法，readonly Pick 省略了它。 |
| 证据与限制 | 边界报告：真实 SessionManager 加只读门面，基线 4 红里有 2 红是这条；修后合同 11/11。这是采集延迟/完整性，不是已经发生的重复收费，也不外推默认 before-tree 路径。 |

### M10. 有计数但叶行走长度对不上时，才全量补读

| 项 | 内容 |
|---|---|
| 前 | 新捕获层的叶行走只看见当前叶到已见节点之间的链。宿主可以在两次观察之间追加并立刻导航离开那条链。 |
| 后 | 有 `getEntryCount` 时，先走当前叶。只有 `count !== seen.size + 本次新链长度` 才改成全量过滤未见 id。条数没变则直接返回。 |
| 动机 | 有总数时，叶行走结果和总数不一致说明中间发生过离分支追加，只走当前叶会漏。 |
| 当前必要性 | **防御性加固**。默认路径有 count，且多数边界在导航前已经捕获。它不是 M9：M9 是根本没有计数方法。 |
| 用户影响 | 正常顺序追加不触发全量读。只有捕获间隙里又追加又离开该分支，才会在下一次边界补上，而不是永远丢掉。 |
| 工程代价 | 不连续时多一次 `getEntries()`。没有为这个场景另做事件优先双路径。 |
| 源码 | `capture.ts` 叶行走后的 `count !== this.seen.size + entries.length`。 |
| 证据与限制 | 机制来自 SessionManager 可以 branch 离开刚追加的叶。没有把默认 Pi 的每次 turn 都证成会走这条全量路径。三模型阶段没有把整层捕获判成不可简化；本条只说明这个分支为什么存在，不证明队列、seen、模型缓存都必须保持现在的形状。 |

### M11. 旧行负费用不再拉低小计和预算

| 项 | 内容 |
|---|---|
| 前 | 数组/对象旧行用 `asNumber` 保留有限负 cost。`costKnown` 仍可能为真。合计无条件加 `rec.cost`。例如已知 0.10 加旧行 -0.04，小计变成 0.06，并把 0.08 的预算提醒压下去。 |
| 后 | 读侧只接受有限且 `>= 0` 的 cost。负值读成 0，并标未知。原文件字节不改。正费用和明确的 0 仍按已知处理。 |
| 动机 | 旧行格式可以被读取，但其负费用金额无效，仍会改变小计和预算提醒。这是读侧行为，不是新的计费算法。 |
| 当前必要性 | **有直接行为理由修复**。没有真实账户负账样本，不能写成用户已经少付或多付。 |
| 用户影响 | 谁的本地账本里真有负 cost 行，修复后小计会回到不含该负数的值，未知标记出现，原先被压住的预算提醒可能重新出现。没有这种行的用户无差异。 |
| 工程代价 | 两处读取判断。不迁移、不重写历史文件。token 字段仍按有限数字读取，本条只收口费用。 |
| 源码 | `store.ts` `parseArrayRecord` / `parseObjectRecord` 的 `validCost`。`aggregate.ts` 仍把读出来的 `rec.cost` 相加，所以必须在读侧把负数挡掉。 |
| 证据与限制 | 独立合同两种旧格式，-0.04 不再把 0.10 拉成 0.06，原字节不变。边界报告写明没有真实负账样本。本轮审计没有重跑该测试。 |

### M12. 未知费用和确认零分开

| 项 | 内容 |
|---|---|
| 前 | **旧版已有`costKnown`**：缺费用时数字占位0但标未知，看板可显示n/a，不能说旧版一律把缺失当已知零。旧解析只检查`typeof number`，负值/NaN/Infinity也可能标已知；混合汇总只保留“是否有已知项”，没有未知条数。 |
| 后 | 总价必须有限且非负才标已知；原来的缺失未知与明确零区分保持，另加`unknownCosts`，使已知小计旁可说明仍有缺价记录。 |
| 动机 | 收紧非法金额判断，并避免已知记录掩盖混合汇总里的未知部分。 |
| 当前必要性 | **非法金额校验有直接行为理由；混合完整度表达是已认可原则的实现**。不是从零新增“未知”概念，也不自动批准M13/M14的具体文案和显隐。 |
| 用户影响 | 明确写出的0仍按有效记录值处理，不等于供应商确认免费；混合汇总可标注不完整。token仍计入，未上报usage的请求不能凭空补计。 |
| 工程代价 | 记录上继续用数字占位加 `costKnown`。汇总增加 `unknownCosts`。没有伪造完整度。 |
| 源码 | `session-parser.ts` `validCost` / `recordFromUsage`；`types.ts` `unknownCosts`；`aggregate.ts`。 |
| 证据与限制 | 合同覆盖 assistant、tool、usage、compaction、branch summary 的明确 0 与缺失/负/非数字。零值本身不能区分“免费”和“未定价”；这里只区分“字段明确写出 0”和“字段无效/缺失”。 |

### M13. 总价无效时仍把有效分项加进数字小计

| 项 | 内容 |
|---|---|
| 前 | 总价不是有限数字时，费用记 0。 |
| 后 | 总价无效但 `usage.cost` 是对象时，把其中有限且非负的 input/output/cacheRead/cacheWrite 相加，放进数字小计，同时 `costKnown=false`。缺的分项不加，也不补成 0 后宣称完整。 |
| 动机 | 想在总价坏掉时仍保留“已经知道的那一部分钱”。 |
| 当前必要性 | **产品选择**。三模型审阅写明这是额外容错，不是 SDK 适配必需。用户认可未知标记，不等于批准分项累加。当前未获整包确认。 |
| 用户影响 | 总价缺失但分项有正数时，看板/底栏会显示一个带未知标记的非零小计，而不是未知或 0。四个分项齐全时，Meter 仍标未知；Glance 会把同一形状当成已知，见 G4。 |
| 工程代价 | 读侧多一次分项归约。不回写原记录。 |
| 源码 | `session-parser.ts` `recordFromUsage` 的分项 reduce。 |
| 证据与限制 | 合同的无效总价夹具大多没有正分项，所以通过测试并不等于批准这条。不能和 Glance 一起宣传成同一费用口径。 |

### M14. 零金额显隐，以及 recorded / +? 文案

| 项 | 内容 |
|---|---|
| 前 | 底栏 today-cost 只在 `costKnown && cost > 0` 时出现。看板未知显示 `n/a`。标题是 “usage”，没有 recorded。 |
| 后 | 有已知费用或正小计才显示金额；若还有未知条，金额后加 `+?`，并加单词 `recorded`。只有未知、金额为 0 时，底栏写 `cost unknown recorded`，看板写 `unknown`。完全没有费用信息则仍可隐藏该格。说明行写 recorded subtotal，不是完整账单。 |
| 动机 | 想让人看出这是已记录小计，不是供应商账单。 |
| 当前必要性 | **产品选择**。固定 `recorded` 后缀、`+?`、以及“正小计即使含未知也显示”都不是把缺失价格标成未知所必需的。审阅已把文案和零显隐从数据修正里分开。 |
| 用户影响 | 底栏固定多一个recorded；已有明确零费用也会显示金额（旧today-cost要求>0，today-spend也不显示纯零费用）。未知和正小计混合时显示如`$0.18+? recorded`。看板原本就能表达已知零，不应把整个零显示都称为新增。 |
| 工程代价 | 只改渲染和 README。不改账本数字。 |
| 源码 | `footer.ts` `todayLine` / `today-cost`；`dashboard.ts` `costCell`；两份 README 的底栏样例。 |
| 证据与限制 | `chrome.test.ts` 跟随了新文案。测试绿只说明实现与断言一致。零费用显隐和 M12 的记账语义不是同一决定。 |

### M15. 原生 codemode 父结果只扣本条已上报的子份额

| 项 | 内容 |
|---|---|
| 前 | 整个 `Agent` 结果、以及带 version 1 marker 的 `get_subagent_result` 整条不计入。其它 toolResult 按整份 `usage` 计入。原生 codemode 父结果可以同时含父工具自己的用量和 `subagentUsageRollups` 子份额；子会话若再记一遍，本地账会把子份额加两次。 |
| 后 | 不把累计水位相加。只从本条父 usage 里减去有效的 `reportedUsage` 份额，保留父工具自己的 token 和费用。份额大于父值、收据缺字段、版本不对、父价格本身未知时，不猜、不扣、不制造已知零。SDK 会话总计和会话日志不改。 |
| 动机 | 子账本已经按子消息记过的那一份，不应再从父工具的混合 usage 里整份再加一次。 |
| 当前必要性 | **有直接行为理由修复**，限于父 toolResult 同时带有效子份额、且子消耗已由子会话记账。旧的 Agent / get_subagent_result 整条排除本来就有，不是本条。 |
| 用户影响 | 本地 Meter 不再把那份子份额重复加进预算。供应商是否扣费、Pi 原生会话统计，都不因本条改变。缺子日志时仍可能不完整，找到一部分子用量也不等于全部覆盖。 |
| 工程代价 | 解析时做有界扣减。不新建子日志扫描器。 |
| 源码 | `session-parser.ts` `withoutSubagentShares`。旧排除仍在 `isSubagentUsageRollup`。 |
| 证据与限制 | `native-rollup-shares.test.ts` 与 `pi12-codemode-rollup.contract.test.ts`。进度表里的 0.12/0.16 是合成记录的本地重复统计，最终本地账是 0.07/0.07/0.09，不是服务商重复扣款。Glance 没有这条扣减。 |

#### M16. 捕获层组织与摘要模型归属

`SessionUsageCapture` 的队列、seen、父链模型缓存、启动读来源，是 M2/M6/M7/M9/M10 的实现容器。三模型没有证明它可以收成“只读 turn_end 的几个 id”，也没有证明现在每一层都必需。进度表保留统一捕获，是因为事件加补读没被证明更简单，不是因为复杂度已经审完。本审计不提出删代码方案。

摘要模型沿 `parentId` 而不是文件顺序走，是解析附带行为：分支文件顺序和树顺序不一致时，摘要会归到父链上的模型，而不是文件里上一条 model_change。它改变的是看板归行，不改变总金额。没有单独的用户事故样本。把它看成 M2 的配套，不另升成必需修复。

---

## Glance

目录：`packages/pi-glance/`。

当前会话的内存展示。它不是 Meter 那种跨文件账本。

本来就有、这次不能写成新修复的三件事：

- 全会话范围：启动/可靠快照已经用 `getEntries()` 求和，`getBranch()` 只用于压缩后的上下文是否未知。这次没有把“当前分支”改成“全会话”。
- Context：仍然来自 `ctx.getContextUsage()`，独立 usage 不进入模型上下文。这是原设计，不是新分离。
- Reply speed：仍然由 `ThroughputRunTracker` 按生成过程计算。独立 usage 本来就不是一次回复。测试只是确认新计入的 usage 没有漏进速度。

### G1. 把已持久的独立 usage 算进当前会话费用和 token

| 项 | 内容 |
|---|---|
| 前 | `usageTotalsFromEntries` 只加 message，以及带 usage 的 compaction / branch summary。实时增量只在 `message_end` 上加 assistant/toolResult。`type:"usage"` 不进费用条。 |
| 后 | 持久条目里的 `type:"usage"` 计入当前会话费用和对应 token 桶。live 不再从 message_end 对象加钱，而在持久边界用 entries 对齐。独立 usage 不进入 Context，也不进入 Reply speed。 |
| 动机 | 独立 usage 已经写在会话日志里，旧费用条看不到。 |
| 当前必要性 | **公开契约必需**，仅限“读到标准 usage 条目”。全会话范围、Context、速度分离不是本条修出来的。 |
| 用户影响 | 缓存预热或其它已落盘的独立操作会出现在 Cost / Tokens。未落盘的不出现。切分支仍显示整个会话已记录累计，这是旧口径。没有公共事件时不瞬间刷新。 |
| 工程代价 | `turn_end`、`agent_end`、`agent_settled`、`turn_start`、`model_select` 等会读一次 entries 副本。`message_end`、工具结束、thinking 选择不读。render/resize 不读。不是新账本，也不扫子会话文件。 |
| 源码 | `runtime-snapshot.ts` `usageTotalsFromEntries`；`runtime-refresh-session.ts` `syncRecordedUsage`；`runtime.ts` 把 ctx 交给 settled。 |
| 证据与限制 | 原独立合同用真实 `appendUsage`，并断言 `buildSessionContext()` 不变。README 写 “including cache warming” 容易读成做了预热专项；代码没有预热追踪，只是 kind 不限。所谓 “without nested double accounting” 的合同只是在 toolResult.details 里放了一个 Glance 从不读取的 `nested.usage`。Glance 不实现 Meter 的子份额扣减。同一会话里若父 usage 已含子费用、子消息又是独立 entry，Glance 会两笔都加。不能把 changeset 这句话当成与 Meter 相同的嵌套政策。 |

### G2. 统计单位改成持久 entry，不再用 responseId 或对象身份

| 项 | 内容 |
|---|---|
| 前 | 实时用 responseId 集合或对象 WeakSet 挡重复 `message_end`。两个不同 entry 若合法地共用 responseId，实时路径会少加。启动、tree、compact 会按 entries 重算，所以不是永久账本损失。 |
| 后 | 以 entry id 为统计单位。相同 payload / responseId、不同 id，两笔都计。同一 id 重复观察不加。长度变短、tree/compact、或 entryCount 已清零时整段重建。 |
| 动机 | responseId 不是记录身份。旧实时过滤在“不同 entry、相同 responseId”时有少计机制。 |
| 当前必要性 | **有直接行为理由修复**的是统计单位。它不是已证实的用户少计事故：三模型没有跑旧路径对照，agent loop 不制造重复 id 也不能证明上游绝不返回。旧重算路径限制了损失是否永久。 |
| 用户影响 | 重载、tree、compact 与 live 对齐到同一份持久快照。只在内存里重复投递同一个 id，费用条不加第二次。 |
| 工程代价 | 每次纳入统计的边界读 entries。追加路径只处理长度后缀。 |
| 源码 | `runtime-refresh-session.ts` 的 `entryCount` 与 `appliedEntryIds`；`runtime-snapshot.ts` 里还有一个函数内 `seen`。 |
| 证据与限制 | 两个 Set 不是兼容必需。公开 append-only 路径上，长度后缀就够识别新记录。`appliedEntryIds`可挡住追加后缀里的已见id，但同长度替换不会被后缀扫描主动发现。快照函数里的`seen`在输入重复id时改变结果。两者仍保留，净价值未证明，本条不提出删除方案。后缀路径先把id放入Set再累加；若累加抛错，长度游标虽尚未推进，已见集合却已变化，可能影响重试。这是静态风险，没有注入失败实证，不能写成默认路径已经漏账。正常 `session_start` 会重置。 |

### G3. 未知价格不显示成确认零

| 项 | 内容 |
|---|---|
| 前 | 没有 cost 对象就是 0。总价只要 `Number.isFinite` 就采用，负数也会显示成费用。缺总价时把缺失分项当 0 相加。Hide zero 会把 `<= 0` 的费用条藏掉。 |
| 后 | 明确写出的非负总价仍是已知，包括 0。缺失、非有限、负数总价标 `costUnknown`。费用条在未知时加 `?`。已知小计保留。Hide zero 不再藏掉带未知标记的条。 |
| 动机 | 不知道价格时，不能让费用条看起来像确认没花钱。 |
| 当前必要性 | **有直接行为理由修复**的是“缺失不是已知零”。`?` 的具体拼法、以及 Hide zero 对未知开例外，是 **产品选择**，没有因为原则被认可就自动获批。 |
| 用户影响 | 确认零显示 `$0.000`，不带问号。未知显示 `$0.000?`。小于 `$0.001` 的已知正数仍是 `<$0.001`，未知则是 `<$0.001?`。开了 Hide zero 时，纯零仍隐藏，带未知标记的零或小计仍可见。 |
| 工程代价 | `UsageTotals` 多一个可选标记。相等比较必须带上它，否则未知状态变化不会刷新。 |
| 源码 | `runtime-snapshot.ts` `usageCost` 的总价分支；`cost-segment-feature.ts`；`segment-display-primitives.ts` `formatCost` 未改，问号是拼接上去的。 |
| 证据与限制 | 原独立合同区分明确 0 和缺失/NaN。没有真实未定价账号样本。G4 的四分项规则是另一决定，不要写进本条。 |

### G4. 没有总价时，四个分项齐全才当成已知和

| 项 | 内容 |
|---|---|
| 前 | 总价不是有限数时，分项缺失按 0 相加，结果当成已知费用。 |
| 后 | 总价字段存在但无效：直接未知，不回退分项。总价字段不存在：四个分项都必须是有限非负数，才把它们的和当成已知费用，不加问号。任一缺失或无效则整笔未知，数字贡献 0。 |
| 动机 | 把旧的“缺啥当 0”收紧，只在四个分项都在时保留求和。 |
| 当前必要性 | **产品选择**。这是旧容错的严格化，不是新定价，也不是 SDK 要求的唯一合法读法。 |
| 用户影响 | 四个分项齐全、没有 total 时，Glance 显示已知金额且无问号。Meter 对同一形状仍是未知小计加标记。总价是负数时，Glance 整笔未知且不采用正分项；Meter 会把有效分项加进带标记的小计。 |
| 工程代价 | 一个局部判断。没有价目，也不补未上报费用。 |
| 源码 | `runtime-snapshot.ts` `usageCost`。对照 `packages/pi-meter/src/ledger/session-parser.ts` `recordFromUsage`。 |
| 证据与限制 | 不能宣传两包全数据口径一致。完整合法、带非负 total 的记录，两边都采用 total，只有这个交集和 Core 的“有 total 就用 total”相符。残缺记录、零显隐、问号格式都不相同。 |

### G5. 同名主题的明暗跟随 appearance，默认缓存键带上它

| 项 | 内容 |
|---|---|
| 前 | 只认主题名恰好是 `light` 或 `dark`。`system` 即使 SDK 已给出 appearance，内置配色仍走 unknown。缓存键是名称、颜色模式、sourcePath，同名明暗翻转不会换 spinner 缓存。 |
| 后 | `theme.appearance` 为 light/dark 时优先使用。没有 appearance 时仍按精确名称回退。默认缓存键在有 appearance 时把它放进 JSON。手动 cacheKey 不在本条。 |
| 动机 | Pi 1.1 的 system 主题可以不改名只改明暗。旧名称判断会让内置 Glance 配色走错档；spinner 按 cacheKey 决定是否重装。 |
| 当前必要性 | **有直接行为理由修复**。旧的精确 light/dark 名称本来就正常，本条修的是“有 appearance 字段时名称不再够用”。 |
| 用户影响 | 同名 system 从浅色改到深色，或反过来，内置配色和正在跑的 spinner 会换色。同明暗只换 palette、名称和 appearance 都不变时，仍不刷新。这不在修复范围。 |
| 工程代价 | 默认键多一个字段。编辑器本来就每次向主题对象取色，所以编辑器变色不能用来证明 spinner 重装。 |
| 源码 | `theme-tone.ts` `readPiAmbientTone`；`theme-adapter.ts` `piThemeCacheKey` 的默认分支；未改动的 `working-indicator.ts` 108–112 行按 cacheKey 调用 `setWorkingIndicator`。 |
| 证据与限制 | 新 3 项里的两项目使用真实 controller、真实 adapter、真实 tone。UI 接收端、受控时钟、稳定同名主题 proxy 是替身。不是真实 TTY，也不是系统明暗通知。原独立 14 里的编辑器/样式测试覆盖可见输出，同样不是 TTY。 |

### G6. 手动 cacheKey 相对基线没有净变化；关闭后旧实例重建是待重评项

这两件都落在主题/状态收口里，但动机必须分开。

#### 手动 cacheKey

| 项 | 内容 |
|---|---|
| 前 | f48a91b：显式 `cacheKey` 原样覆盖，返回 `pi:${cacheKey}`。中间候选曾把 appearance 追加到手动键上。 |
| 后 | 最终代码恢复为显式键完整覆盖，不追加 appearance。 |
| 动机 | 撤回一个没有仓内生产调用的附带语义。不是新功能。 |
| 当前必要性 | **无产品改动**（相对 f48a91b）。相对中间候选，这是撤回，不是再加一层修复。 |
| 用户影响 | 没有任何生产调用方依赖手动键。测试夹具若传入 `cacheKey: "manual"`，明暗变化不会改这个键。默认 appearance 配套仍保留，见 G5。 |
| 工程代价 | 一行条件。没有生产调用面。 |
| 源码 | `theme-adapter.ts`：`if (options.cacheKey !== undefined) return \`pi:${options.cacheKey}\``。 |
| 证据与限制 | 新合同第 1 项专门锁住覆盖。仓内 `cacheKey` 生产赋值只有默认键和内置 glance 键。不能把这 1 项绿测说成用户路径被修好。 |

#### 关闭后旧实例内存 2→4

| 项 | 内容 |
|---|---|
| 前 | `sessionShutdown` 把 `entryCount` 清零并清空已见集合，但内存里的费用数字还在。若同一实例随后又处理 agent_end/settled，后缀路径会把整段 entries 再加一次。 |
| 后 | `entryCount === 0` 时改为 `setUsageTotals` 重建，不在旧数字上再加。最终行为是 2→2，不是把晚到事件丢掉。 |
| 动机 | 真实 SDK 允许同一旧实例在 shutdown handler 之后再收到已发出的 agent_end/settled。 |
| 当前必要性 | **防御性加固，必要性待重评，不自动回滚**。不能列为实际账目 bug，也不能因为测试曾变红就写成必需修复。 |
| 用户影响 | 旧 UI 此时已经卸载。会话 JSONL 始终是 2。新实例 new 为 0，reload/switch/fork 的新实例为 2。用户看到的新界面和持久账都没有变成 4。被改掉的是已卸载实例内存里的数字。 |
| 工程代价 | 一个分支。晚到事件仍然会到达旧实例，只是不再把数字加上去。没有新状态机。 |
| 源码 | `runtime-refresh-session.ts` `syncRecordedUsage` 的 `this.entryCount === 0`；`sessionShutdown` 只清游标。生命周期报告指向 SDK `agent-session-runtime.js` 与 runner 没有跨 emit 锁。 |
| 证据与限制 | 真实 SDK 1.2 与 1.3 各 6 个场景：dispose 悬停 agent_end、dispose 悬停 settled、reload、newSession、switch、fork。事件由 SDK 发出，不是手发 shutdown。异步 observer 固定了契约允许的交错，不证明默认裸 CLI 的发生频率。真实 TTY 和进程信号没做。这与 Tool Display 的内部 owner 更换同一类：内部一致性变了，没有实际用户错误。协调者不应把它写成优先必修复，也不应在重评前自动回滚。 |

### G7. 删掉 Cost 设置里的说明行

| 项 | 内容 |
|---|---|
| 前 | Cost 设置有一条不可操作的 Display 行，值是 `compact USD`，提示 “Compact session cost.”。它不改变格式。 |
| 后 | 该行删除。`formatCost` 未改。 |
| 动机 | 一条不会改行为的说明，占着设置位置。 |
| 当前必要性 | **可选维护**。与 Pi 1.1、独立 usage、明暗都无关。 |
| 用户影响 | 设置里少一行。金额格式函数仍是：非正数 `$0.000`，小于 0.001 为 `<$0.001`，再往上按原规则。问号来自 G3，不是这条说明行提供的。 |
| 工程代价 | 设置目录少一个 info 项。 |
| 源码 | `cost-segment-feature.ts` 删除 `cost.display`。 |
| 证据与限制 | changeset 写 “displayed amount format is unchanged” 只对 `formatCost` 成立。不要用这句话覆盖 G3 的问号或 G4 的求和变化。 |

## Tool Display

目录：`packages/pi-tool-display-intent/`。仍保留本地试用门槛。官方接入、根计数、性能保护、额外展示与生命周期组织不是同一类必要性。

### TD1. 官方renderer接入

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 扩展加载时 `registerTool` 重造 read/grep/find/ls/edit/bash/write，并在 individual 下拦截后续 `registerTool`。候选改为 `registerToolRenderer(name, next)`；上述工具的展示定义只放进 `builtInDisplays`。只有仍属 builtin 的 bash/write 在 `session_start` 后才 `registerTool`。 |
| 为什么改 | 显示归 resolver，避免用改元数据冒充改真实定义，也避免显示扩展在工厂阶段抢 Bash/Write 名字。 |
| 是否必要 | **合理的显示契约适配与减耦合**：用官方入口最直接地支持统一显示/晚到工具；SDK并未禁止完整地重注册工具，不能说这一实现形态是唯一必需。`registerToolRenderer`自1.0.1已有，旧普通路径也并非全部失效。 |
| 影响与代价 | 安装后，read/grep/find/ls/edit 继续走宿主原执行。自定义、晚到的 MCP、只存在于历史里的工具按解析结果画统一行，专用内容可委托。代价是新的外壳选择链（见 TD7），以及 bash/write 仍会在会话开始后替换 builtin。 |
| 源码及证据边界 | `tool-overrides.ts` `registerOwnedTool` 只 `builtInDisplays.set`；`session_start` 约 2016 行；`registerToolRenderer` 约 2049 行。旧路径是 `registerRuntimeTool` → `pi.registerTool`。未在 TTY 复看。 |

### TD2. 完整执行定义与context透传

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 旧 `createBuiltinToolBase` 手工挑字段，`execute` 只传四参，丢掉第五个 context。候选对不再重注册的工具直接留下宿主定义；Write 包装会把 `ctx` 传回去。 |
| 为什么改 | 采样、prepare、exposure、loadout、`outputSchema` 和带 context 的执行不被显示包装拆掉。 |
| 是否必要 | 对“被旧代码重注册的工具”这是真实语义差，不是文案。本审计没有复现某个具体工具因此失败的用户事故，所以不能写成“旧包因此不可用”。与 TD3、TD4 分开。 |
| 影响与代价 | 普通 read/grep/find/ls/edit 不再经过四参包装。Write 仍经过包装，但 context 会传到原 `execute`。不改变权限，不自动开 codemode/MCP。 |
| 源码及证据边界 | 候选 `createBuiltinToolBase` 约 1746 行是 `{ ...bootstrapTools[name] }`。旧函数在 `registerToolDisplayOverrides` 内手写四参 `execute`。证据停在源码对照，没有新跑执行。 |

### TD3. Bash既有意图fallback的注册时机

| 项 | 内容 |
|---|---|
| 改动前 → 后 | Bash 仍用既有 `withDisplaySummary`：缺 `displaySummary` 时 fallback，非法参数仍拒绝，`preserveRendererArgs` 仍要求显示字段不进底层。变化是注册从加载期挪到 `session_start`，且只在当前 owner 仍是 builtin 时做。 |
| 为什么改 | 保住已有意图契约，同时不在别的扩展已经注册 Bash 时抢名。 |
| 是否必要 | 保留既有 fallback 是必要的。它不是执行保真（TD2），也不是 1.2 新需求。没有已确认的缺字段故障被本轮新发现。 |
| 影响与代价 | 直接调用或脚本省略意图时，仍可看到 fallback；其它非法参数仍失败。若 Bash 已不是 builtin，候选不再替换它。进行中的 fallback 是否显示，仍看 live id；live 集合改成按 owner 记，避免一个会话清掉另一个会话的标记。 |
| 源码及证据边界 | `tool-overrides.ts` 约 2033 行。`display-summary` 实现文件不在这 58 个差异里，本审计只确认调用点仍请求原契约。`live-tool-call.ts` 的 owner 集合是隔离，不是新的意图规则。 |

### TD4. Write写入前捕获

| 项 | 内容 |
|---|---|
| 改动前 → 后 | Write 仍在自己的 `execute` 里、调用原 execute 之前读工作区旧内容，记到本次 toolCallId。候选额外把第五参传回。没有把捕获挪到 `tool_call`。 |
| 为什么改 | 展开 diff 要比的是写入前的 A 和本次的 B，而不是写后的 B 或后来的 C。 |
| 是否必要 | 紧邻 execute 的捕获要留。把它提前到 `tool_call` 不是已证等价：审批或其它拦截可能还没发生。本审计不建议前移。 |
| 影响与代价 | 同一次调用展开后仍是 A→B；新文件不造旧正文。未持久化的捕获不要求 reload 后重建。执行结果本身不因捕获而改写。 |
| 源码及证据边界 | Write 包装在 `registerIfOwned("write")` 的 `execute`。展示读取 `getWriteExecutionMeta`。旧 main 同样在 execute 内捕获，只是不传 `ctx`。 |

### TD5. 晚到工具和MCP的显示发现

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 旧 individual 有两条 MCP/自定义路：`getAllTools()` 循环上原地改 renderer，以及包一层 `registerTool`。候选不再写回 `getAllTools()`；解析时读元数据，用 resolver 画行。合作装饰只改明确请求装饰的那个对象，并在清理时不覆盖后来的 owner。 |
| 为什么改 | 晚连接 MCP 和历史行需要统一展示，但不能假装改到了真实工具定义。 |
| 是否必要 | 必要的是停止修改投影副本。旧 `getAllTools` 在 0.86 也是投影副本，改副本不会生效；这不等于旧包整个坏，也不等于旧拦截器路径已证明全死。拦截器是否改到宿主留存的同一对象，本审计和最新验证都没有重证。 |
| 影响与代价 | 用户能在不替换执行定义的情况下看到 MCP/自定义/历史的统一行；passthrough 仍留原 renderer。已知原生 codemode 即使 passthrough，进度副本仍走展示预算。aggregate 仍按根折叠，不靠替换工具。 |
| 源码及证据边界 | `drainPendingToolDisplayDecorations` 写明不碰 `getAllTools()`。`registerToolRenderer` 用 `tryGetAllTools` 只做查找。旧 `registerMcpToolOverrides` / `installMcpRegistrationInterceptor` 已删除。 |

### TD6. call/result状态与一次padding

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 新增 composer：call/result 可分开委托；own 与 delegate 各有 state 和 lastComponent；self 外壳自己补一次 `outputPad`，default 外壳把留白留给宿主。HTML 对 call/result 两次 resolve 时，行状态挂在宿主 state 上，不依赖同一个组合器实例还活着。 |
| 为什么改 | 专用内容、委托状态和留白不要串，也不要补两次。 |
| 是否必要 | 状态隔离和一次 padding 有展示契约价值。它不是 SDK 规定的缓存或硬上限，也不能和 TD7 的框差异混成“升级必需”。 |
| 影响与代价 | 合作 renderer 的专用内容和鼠标处理留在自己的组件里。generic 结果才套统一前缀。代价是外壳由 style 和 delegate 的 `renderShell` 决定，不看 own 上声明的 `renderShell`。 |
| 源码及证据边界 | `renderer-shell.ts` `composeToolRenderers`。`edit` 仍写 `renderShell: "default"`，composer 不读 own 的这个字段。 |

### TD7. 内部compact外框差异

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 没有独立的 compact 产品开关变化。公开 v2 加载仍把 `toolCallStyle` 固定成 `claude`，文件里写 compact 无效。内部若把运行时 getter 设成 compact，edit 内容已是扩展自己的行，但 shell 跟随内置 edit 的 `self`，宿主变成 Container，默认状态框和 `toolPendingBg` 消失。旧 main 在自己的 0.86 宿主上把注册定义改成 `default`，同一场景是 Box。 |
| 为什么改 | 新 composer 用 `style === "claude" \|\| delegate.renderShell === "self"` 选壳。内置 edit 本来就是 self。 |
| 是否必要 | 不是当前公开模式故障，不必要按“用户切了 compact”来修。也不必要给一行公式：call/result 可以一个委托、一个不委托，两种改法的可见结果不同，且未验证哪种才是要的。 |
| 影响与代价 | 普通文件配置用户仍是 claude/self，看不到这条内部差异。只有绕过公开加载器改 getter 才会丢 edit 默认框。无 shell 的自定义工具在公开入口上也是 self，因为 style 被固定成 claude。 |
| 源码及证据边界 | 最新 `render/REPORT.md`：真实 resolver + `ToolExecutionComponent.render(100)`，SDK 1.2。不是旧源码塞进 1.2 解析链，也不是 TTY。`config-store.ts` `normalizeToolDisplayConfigV2` 仍写死 default style；这行不在本 diff 的行为变更里。 |

### TD8. 当前布局缓存与设置刷新

| 项 | 内容 |
|---|---|
| 改动前 → 后 | `PreviewText` 与 `ClaudeToolResultComponent` 各留一份当前布局。内容、宽度、展开、主题签名、配置变化会失效。面板改预览行数或结果模式时，对真实 TUI 调用 `invalidate` + `requestRender`。同对象静默改内容仍不承诺零扫描发现。 |
| 为什么改 | 已完成文本历史不要每帧重做布局/高亮/测宽；进行中输出不冻结。 |
| 是否必要 | 有性能价值，但不是 SDK 强制，也不是本轮要调的参数。不能把早期合成毫秒数当成当前收益证明。 |
| 影响与代价 | 已完成文本行重绘应少做重复布局。改预览/结果模式后，已有历史行会刷新。同主题换色的组件层缓存仍可能留旧色直到换宽；这是旧机制疑点，没有证成真实 TUI 事故，不和 Glance 动画混谈。 |
| 源码及证据边界 | `preview-text.ts`、`tool-call-style.ts`、`display-theme.ts`、`config-modal.ts`。49.03/51.73 与 133.33/139.46 只属于早期 SDK 1.1 候选、Linux 合成、100/300 行固定负载。`scripts/bench-rendering.mjs` 在树内，本审计未重跑。 |

### TD9. 强制展示预算

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 新增展示用硬上限：1,000,000 UTF-16、20,000 行、1000 blocks、6000 nodes、深度 24。超限在高亮、stringify、diff 之前停，并给出明确省略。关闭展开行数限制也绕不过这些上限。 |
| 为什么改 | 避免展示路径先无界遍历再截断。 |
| 是否必要 | 用户已接受保留机制，当前不调参数。这不是 SDK 规定，也不是兼容所必需的唯一数值。 |
| 影响与代价 | 只裁展示副本。执行结果、模型输入、usage 不变。被省略的 diff 不会装成完整对比；没有真实产物就不造全文链接。超大预览即使把展开行数调到不限制，仍可能看到省略提示。 |
| 源码及证据边界 | `display-budget.ts` `DISPLAY_LIMITS`；`diff-renderer.ts`、`render-utils.ts` `extractTextOutput`、`preview-text.ts`。任意 Proxy trap、第三方 renderer 内部和宿主前置处理不在这个硬限的保证内。 |

### TD10. 对象快照防御

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 展示读取改为只拿数据属性：不调用 getter、迭代器、`toJSON`。异常或超限对象显示省略，不把截断写回原对象。 |
| 为什么改 | 恶意或带副作用的对象不应该为了画一行被执行。 |
| 是否必要 | 不是所有合法数据都需要这层防御。自定义工具可以返回普通对象，不能因“真实结果都是 JSON”删掉。它也不是任意 Proxy 的 CPU 绝对防线。 |
| 影响与代价 | 正常 JSON/字符串结果仍按预算显示。带 getter 的对象不会为了预览被触发；用户看到的是省略，不是执行失败。 |
| 源码及证据边界 | `snapshotDisplayValue`、`displayField`；`arg-preview.ts` 先快照再做行内预览。未做对抗性 Proxy 计时。 |

### TD11a. 根调用计数纠正

| 项 | 内容 |
|---|---|
| 改了什么 | live执行事件按parentToolCallId归根；aggregate只让根调用进入顶层计数，不把子操作/子模型调用再计成顶层工具。 |
| 为什么 | 新SDK会发嵌套执行事件，旧计数器可把1个根加7个后代显示成8个顶层调用，重载只剩根时又变1。 |
| 是否必要 | **有明确显示行为理由的修复**。数量修正不等于新增深层调用树必需，也不是修改真实计费。 |
| 影响 | 运行中与重载后的顶层工具数量更一致，子结果仍可失败/取消/未结束。 |
| 证据 | aggregate-activity.ts的parent过滤与D3既有聚焦probe；本次文档审计未重跑。 |

### TD11b. 深层可见性与实时展示预算

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 一次脚本调用仍是一条顶层记录。live 用 `parentToolCallId` 归到根；aggregate 不再把子执行算进顶层工具数，模型调用也不算工具数。原生 codemode 进度保留，扩展只补充原生视图里没有的后代。展示副本另限 256 次、单参 8192、总参 32768 UTF-8（compact JSON）。 |
| 为什么改 | 让用户看到真实已执行的后代而非猜测脚本源码；补充原生TUI未显示的深层记录。根计数的必要性不为这套增强自动背书。 |
| 是否必要 | 深层树和详情补充是增强，不是普通直接调用的兼容必需。256/8KiB/32KiB 是本扩展多加的显示合同，要和宿主历史记录上限分开：宿主持久 `nestedCalls` 本来就会在 256 处截断并标 `complete:false`；候选把同一数量和字节预算用到 live、原生 `details.calls` 副本、详情 Metadata/Raw。 |
| 影响与代价 | aggregate 里子调用不再多占一条顶层。根成功仍可含失败、取消或未结束的子项。缺参数、父关系、耗时、子结果正文保持不可用，不重跑、不读当前文件补历史。并行子项不累加成整轮 wall time；有宿主 `durationMs` 时，结束行优先用它，缺了不填 0。列表不完整时，可见费用明确不是全额。 |
| 源码及证据边界 | `nested-display.ts`、`nested-renderer.ts`、`native-nested-view.ts`、`aggregate-activity.ts` 对无 parent 的事件才 `markStarted`。生产 aggregate 把同一个 store 传入投影；第二次 `register` 因已注册直接返回。无参 `new AggregateProjection()` 仍会自建 store，那是测试/默认参数，不是这条生产双计费证据。不建议合并两处构造。 |

### TD12. 省略参数的单行歧义

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 原生进度副本在参数放不进预算时，交给下游 renderer 的 `args` 变成 `""`。9000 个 `x` 的合法合成字符串与真的空参数，在单行上都是 `✓ read 12ms`。总提示还在：省略组有“列表不完整 / 可见费用不是全额”，其后才是“上面是预览”。原 `details` 不改，没有执行脚本。 |
| 为什么改 | 原生 renderer 要字符串；超限不能把裁剪片段冒充完整参数。 |
| 是否必要 | 这是展示歧义，不是兼容必需，也不是 TD7 的 compact 故障。本轮没有授权改文案。 |
| 影响与代价 | 单行分不清“被省略”和“本来就空”。用户仍能从后面的总提示知道这组展示不完整。执行参数没有被改。 |
| 源码及证据边界 | 最新 render 报告 B 组；`native-nested-view.ts` 约 79 行 `args: argument.text ?? ""`。输入是公开形状的合成对象，不是生产 transcript。 |

### TD13. 完整HTML中的双视图

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 完整 HTML 导出里，SDK 的 Nested calls 区默认折叠，只见标题。展开后，自定义根的直接/深层调用，以及 codemode 的深层调用，会在扩展结果区和 SDK 区各出现一次。codemode 直接调用在不装扩展时已经是原生进度加 SDK 列表两份。 |
| 为什么改 | 扩展把保存的子调用补进结果；宿主模板在预渲染结果之后仍追加自己的 nested 区。 |
| 是否必要 | 已观察到的展示差异。是否值得改，另行决定。不是默认页双列表，不是整页框架必须重写，也不批准顺手改。 |
| 影响与代价 | 默认折叠时不能说用户已经看到两份列表。展开后，新增重复限于扩展补进去、而宿主又画了的那些调用。原生直接调用的重复不是本扩展新加的。可见 UI 不含 callId。 |
| 源码及证据边界 | 最新 `html/REPORT.md`：SDK 1.2 `exportToHtml`、真实 resolver、本机 Chromium 读计算样式。浏览器切 expanded class，不是真鼠标。未跑 1.3/TTY。`prepareCall` 对 knownNative 跳过，`prepareResult` 仍补充深层后代。 |

### TD14. 用户消息框关闭选项

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 普通用户消息框从硬编码开着，变成 `transcript.userMessageBox`，省略时仍是 true；只有明确 false 才写入并在 reload 后保持。面板有 User message box。关闭后走原生或下游 renderer。steer 的折叠、隐藏、分组仍先于这个开关。 |
| 为什么改 | 让用户能关掉自绘框，同时不改变默认外观，也不让这个开关拆掉 aggregate steer。 |
| 是否必要 | 默认 true 是延续旧行为，不是默认行为改变。新增关闭是可选项，不是升级必需。 |
| 影响与代价 | 不改设置的人仍看到既有自绘样式；individual探针实际是方框细线，不能统称所有布局都是▎。关闭后已有和新消息走下游，steer账本不变，两种布局都可关。 |
| 源码及证据边界 | `user-message-box-native.ts` `isEnabled` 改读配置；`config-store.ts` 只在 false 时序列化；schema/example/README 同步。最新实证没有把“默认框消失”证成。 |

### TD15. 消息导航标记

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 自绘路径先去掉已有 OSC 133/633，布局后再加一次：A 在首行开头，B/C 在末行。空/隐藏仍是零行。assistant 只有下游已经发出导航标记时才按同样规则放回，不给带 tool call 的 assistant 新造边界。 |
| 为什么改 | 自绘和折叠思考占位会打乱宿主标记；标记只能有一份，且不能算进可见宽度。 |
| 是否必要 | 对“继续自绘用户消息”的路径，这是导航契约，不是 TD14 的开关，也不是默认样式改版。 |
| 影响与代价 | 使用默认自绘框的人，消息导航边界应仍在行首且不重复。关掉自绘后，不再由本扩展加第二份标记。未在真实终端键盘上复验。 |
| 源码及证据边界 | `user-message-box-utils.ts` `withMessageNavigation`；`user-message-box-renderer.ts` 先处理 steer，再看 `isEnabled`；`aggregate-thinking-placeholder.ts` 只在下游已有 A 时放回。 |

### TD16. 会话scope清理与共享样式

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 用户消息、steer spacer、aggregate 鼠标补丁改成按 owner 替换。设置安装时，同进程子会话加载本扩展会换掉共享原型 owner；子会话结束后不发 shutdown，父 shutdown 也不把 owner 换回。仅 CLI `-e` 临时加载时，子会话没有这份扩展，不会换。清理从进程级 `disposeAll` 改成会话 scope；旧 owner 只卸自己仍占着的包装。 |
| 为什么改 | 避免旧会话 reload 拆掉新会话的 renderer/timer。实现上因此会替换共享原型 owner。 |
| 是否必要 | 用户已明确：全局共享主题符合预期；内部 owner 变动不是产品问题；本轮不改所有权。没有证据表明设置失效或影响后续会话。组件层同宽留旧色、换宽恢复，未证成 TUI 主题事故。 |
| 影响与代价 | 设置安装与 CLI 临时加载的内部归属不同。普通主题对照仍是同一个 theme proxy；公开切 light 后新消息跟上。不能把初稿的主题 P 颜色差写成用户可见回归。 |
| 源码及证据边界 | 总报告第 1 节覆盖 `owner/REPORT.md` 初稿。`user-message-box-patch.ts` 新 owner 会 retire 前 owner；`index.ts` 删除 reload 时的全局 `disposeAll`。未跑 1.3/TTY。 |

## Search Hub

目录：`packages/pi-search-hub/`。当前生产相对主线仅两文件新增9处取消检查；用户已确认文本输出方案。

| 改了什么（旧→新） | 为什么改 | 是否必要 | 影响与代价 |
|---|---|---|---|
| 搜索入口、逐后端尝试前、成功返回后及失败处理处检查AbortSignal | 已取消时不要继续启动后端，也不要把取消当普通失败继续fallback | **有明确行为理由的取消修复**，不是返回协议迁移所必需 | 减少取消后的多余请求/正常成功结果；已发出的请求仍可能消耗额度，不能保证即时取消与零费用 |
| combine分批前/批后检查取消 | 一批结束后取消，不再继续补批或拼成正常结果 | **合理取消修复** | 同一批已经启动的并发请求不会因新增检查而“从未发生”；仍依赖各后端对signal的支持 |
| Reader入口、每个reader前和返回后检查取消 | 避免取消后继续Reader降级链 | **合理取消修复** | reader排序、10,000 UTF-16结果上限、正文/details与原诊断逻辑不变 |

源码：`extensions/dispatch.ts`、`extensions/search-hub.ts`。早期结构化返回/schema/envelope方案已经撤回，**不是当前差异**；没有新增model-only，普通与codemode都保留文本。原routing/RRF/认证轮换/配额/收费/研究代理配置不变。新增取消与文本合同测试，迁移TypeBox runtime dependency见共通表。

证据：文本候选`8a317a8`，实际1.2及独立1.3同组合各186项（独立36），是当时的离线结果；没有本次新的真实搜索服务验收。

## Recap

目录：`packages/pi-recap/`。用户已确认保留当前副调用不入会话账的限制。

| 改了什么（旧→新） | 为什么改 | 是否必要 | 影响与代价 |
|---|---|---|---|
| 去掉直接`pi-ai/compat.complete`兜底和探测，统一使用`ctx.modelRegistry.complete`，注入类型也取自公开签名 | 遵循当前registry入口，降低多套请求入口维护 | **公开API整理，非已证旧故障修复**。旧优先路径本来就使用registry.complete | 模型选择、请求时认证、OpenCode headers等不因此更换；不再为缺该公开接口的旧宿主提供兜底 |
| `systemPrompt`字段改为messages里的system消息 | 对齐规范化transcript形状 | **契约/类型整理**，不是已证旧指令丢失。SDK1.3仍能转换旧systemPrompt | 指令内容和用户会话摘要输入不改；新增标准system时间戳，不表示模型行为完全重新定义 |
| 双语README/changeset说明Recap费用不进Pi会话累计，provider仍可能收费/扣额度 | 防止把会话费用显示误当所有后台请求总账 | **必要的信息澄清＋已选限制**，不是新加入不记账行为 | 没有新增usage记录器，也没有绕过readonly manager去写原始usage；普通自定义entry不会自动进入原生统计 |

源码：`extensions/recap.ts`；新增native completion与独立completion合同，普通测试改用当前公开入口。依赖只有SDK dev目标更新，不应笼统写成新增peer放宽。

证据：真实1.3离线探针中complete+custom entry不增加统计，宿主明确appendUsage正控才增加；这是接口能力边界验证，不是真实扣费测量。历史84通过/1tmux跳过、独立13，不作为本次重跑结果。

## Todo

目录：`packages/pi-todo/`。生产仅`todo.ts`新增`exposure: "model-only"`。

| 改了什么（旧→新） | 为什么改 | 是否必要 | 影响与代价 |
|---|---|---|---|
| 允许嵌套调用→只允许模型直接调用Todo | 现有恢复只识别直接todo结果里的checkpoint；嵌套修改能改变live状态，却没有可恢复的直接checkpoint | **有明确持久化行为理由的限制方案**，不是SDK规定所有状态工具都要model-only。用户选择不扩写嵌套持久化 | codemode/其它工具不能调用整个Todo，包括list/get；模型直接调用和独立子会话自己直接调用不因此被禁止。限制比“只禁嵌套写入”更宽，但避免增加另一套恢复协议 |

未改批量原子性、任务循环、状态迁移、ID规则或重放算法；这些既有规则不能算本轮新修复。新增`todo.sdk.test.ts`，README明确调用边界；共通依赖适配另列。

证据：SDK1.3六场景比较当前候选与**仅移除该行的候选**（不是旧0.86包全测）。嵌套写入live成功，reload后任务消失/ID复用；直接调用正控正常，保留限制时无副作用拒绝。树/压缩影响仅静态分析。具体证据`/var/tmp/pi-todo-review/REPORT.md`。

## Question

目录：`packages/pi-ask-user-question/`。生产仅`ask-user-question.ts`新增`exposure: "model-only"`。

| 改了什么（旧→新） | 为什么改 | 是否必要 | 影响与代价 |
|---|---|---|---|
| 问答工具仅供模型直接调用，脚本/工具嵌套不能弹表单 | 把向人发问保留为明确的模型交互步骤，而不是隐藏在脚本内部 | **用户已选交互策略，非SDK必需或已证恢复故障** | 少一种脚本编排方式；不增加人工审批，不改变直接TUI/RPC、预览、多选、自定义回答及取消处理 |

新增`ask-user-question.sdk.test.ts`，调整session-load夹具/清理以符合当前SDK；没有对应的生产加载故障修复，不能把新加载失败测试当成旧Question恢复坏了。SDK/TypeBox目标见共通表。历史1.3的612项仅是回归证据，本次没新运行问卷或切全局。不能套用Todo的checkpoint丢失结论。

## Herdr Companion

目录：`packages/pi-herdr-companion/`。生产仅`src/process/tool.ts`新增`exposure: "model-only"`。

| 改了什么（旧→新） | 为什么改 | 是否必要 | 影响与代价 |
|---|---|---|---|
| `herdr_process`只供模型直接调用 | 希望可见、跨步骤保留/接管的进程由模型明确操控 | **入口策略，尚不能按故障必修处理**。未证明脚本调用必然遗留进程；跨步骤继续存活可能就是设计目标 | 脚本不能使用start/list/logs/stop，包括只读查询；但不封锁Bash里的Herdr CLI，也不构成人工审批或安全权限门 |

`executionMode: sequential`、pane归属、ready/shell/cwd/lifetime、持久化和cleanup原本都有，未在本轮改写。它自己用`pi.appendEntry`保存归属，不是Todo依赖直接tool_result才能恢复的同一问题。现有session/persistent不是脚本生命周期；不能反过来把这一事实自动认作缺陷。新增假CLI fixture与真实SDK注册/执行测试，依赖和README另见共通变更。

证据：既有1.3的201通过/1Windows跳过；未跑新的真实pane/退出取消组合。当前保留model-only的建议应由产品定位确认，不能拿“finally不一定执行”单独充当必需证明。

## Adversarial Review

目录：`packages/pi-adversarial-review/`。

### R0. 无生产源码差异

相对 main，`packages/pi-adversarial-review` 下没有 `src/` 或扩展实现 diff。命令注册、external/embedded 选择、isolated reviewer/refuter 工具集、format-repair 空工具、执行后不换后端，这些都不是本轮生产改动。本审计不把“测试新增”写成运行时修复。

### R1 依赖声明和双语兼容说明

| 项 | 内容 |
|---|---|
| 改动前 → 后 | peer 从 `>=0.84.0 <1` 改为 `*`。dev SDK 从 0.86.1 改为 1.2.0，TypeBox 从 1.1.24 改为 1.3.27。双语 README 把 Pi 要求改成 1.1+，并写明 external backend 需要兼容 Pi 1.1 的 Subagents runtime，同时满足 protocol 3 和 `maxConcurrent >= 1`。仅有 protocol 3 不保证兼容。dependencies 里的 `@zhcsyncer/pi-subagents: ^0.2.0` 未改。 |
| 当时动机 | 对齐本轮宿主声明，并避免用户把协议版本当成 Pi 版本兼容。 |
| 当前必要性 | 说明文字是用户产品选择。peer `*` 是可选维护，不证明旧 Review 在 1.2 上失败。`^0.2.0` 未改，所以不能把本轮 Subagents 修复算进已发布依赖。 |
| 影响与代价 | 用户读到的安装要求变高，但 package peer 并不强制 1.1。若已发布的 0.2.x Subagents 没有本轮运行时修复，Review 的 external 路径仍可能落到旧子会话实现。embedded 路径使用当前工作区源码时，才会吃到本轮 Subagents。配对候选的安装证据不能代替发布时的依赖底线。 |
| 路径与证据 | `package.json` diff 只含 peer 与 devDependencies。README 两行要求。A1 任务文档写明发布依赖底线仍须核对，原 `^0.2.0` 未在本轮改。限制：本审计没有查询 npm，没有安装发布包，不能判断当前 registry 上的 0.2.x 是否已含 R1/R2。 |

### R2 新增独立合同，不改变产品

| 项 | 内容 |
|---|---|
| 改动前 → 后 | 新增 `tests/pi11-runtime.contract.test.ts`。对 external-v3 和 embedded 各覆盖：真实命令发布一份报告并清理临时 Git worktree；格式修补至多一次；provider 失败留在已选后端且不重跑；取消保留 Git 快照直到结算；reviewer/refuter/format-repair 的执行上限和 read 正控；pin 强制激活后仍拒绝工具副作用；active stop/dispose 等到 provider 结算，而不是只看 abort 回执。 |
| 当时动机 | 在不改产品的前提下，用真实 SDK/RPC/embedded 固定普通后端行为。 |
| 当前必要性 | 无产品改动。测试有回归价值，但通过不等于生产源码有必要改动。 |
| 影响与代价 | 不改变用户看到的 Review 行为。合同文件自己写明它不是发布包闭包，也不是 MCP 连接测试。A1-B / R3 的父会话已有 MCP 与子会话新连接之差、逐服务连接前授权、资源枚举、晚注册和 shutdown transport 清理，仍未联验。不能用这份合同确认原生 MCP。 |
| 路径与证据 | 测试文件头注释和 `describe.sequential.each` 用例名。执行计划写明 Review 对 `f48a91b` 无生产源码改动，既有 1.3 检查 363/363 为本轮未重跑的历史证据。限制：本次未重跑该合同，也没有把历史 363 当成对 `24ac1da` 的新验收。 |

## Cursor Provider

目录：`providers/pi-provider-cursor-ask/`，包名`pi-provider-cursor-ask`。**仍维护；只是撤回本轮适配。**

| 改了什么 | 为什么 | 是否必要 | 影响与代价 |
|---|---|---|---|
| 当前整个包（源码、测试、README、manifest）对f48a91b没有差异；早期迁移专用changeset/合同已撤 | 用户明确不继续该轮改造，但没有要求停维护、删包或卸载 | **无包内产品改动**，不要继续评价已撤代码为当前方案 | 旧system-section/工具重放实现继续保留；没有本轮新兼容承诺，真实账号、模型、池、计费及端点不变 |

共享打包检查对它的旧peer范围精确豁免，但runtime-copy/loader/SDK物理版本检查没有跳过；仓库root overrides仍使本地验证解析到1.2，这不是改Cursor发布manifest。回撤后的原包355项/构建/隔离安装已验，早期372项与迁移修复是历史，不代表当前保留。没有新增停维护说明或全局安装变化。

## Volcengine Agent Plan Provider

目录：`providers/pi-provider-volcengine-agent-plan/`。

| 改了什么（旧→新） | 为什么改 | 是否必要 | 影响与代价 |
|---|---|---|---|
| 给Responses/Completions compat对象显式类型；模型目录由`Model<API联合>`改为按API区分的联合类型 | 让当前SDK/TypeScript正确约束不同API的compat字段 | **为当前类型契约的合理适配**，不等于旧线上协议错误 | 类型擦除后运行值不变；`max_completion_tokens`等选项值没有改 |
| Node支持范围由20提高到22.19，README标Pi1.1+，SDK dev和peer更新 | 与当前宿主最低环境对齐并明确离线验证边界 | **环境/声明对齐**，不是套餐模型能力修复 | 旧Node20不再列为支持环境；不自动升级用户机器 |

源码仅`index.ts`的类型层。模型目录、small/medium/large/max套餐、Agent Plan专属密钥和`https://ark.cn-beijing.volces.com/api/plan/v3`端点、thinking与参考价格均未改。界面金额仍是公共API参考估算，不是Agent Plan账单或AFP扣额。新增独立provider与SDK transport测试；历史实际1.3的51项含独立16，不是在线密钥/额度验证。

## 三种用量范围不能混成一套账

“已知/未知”指已记录费用字段的有效性，不是供应商实际账单确权；SDK明确给0时也无法单凭0区分免费与未定价。没有上报usage的请求不会被本分支凭空补算。

| 问题 | Meter | Glance |
|---|---|---|
| 记到哪里 | 跨会话本地账本，参与预算 | 当前进程里的当前会话费用条 |
| 独立 usage | 读标准条目 | 读标准条目 |
| 全会话 / 当前分支 | 账本按记录归属，不随 Glance 的分支显示变化 | 本来就是 `getEntries()` 全会话；分支只影响 Context 未知判断 |
| 父工具里的子份额 | 有效 `reportedUsage` 从本条扣掉 | 不扣。只是不读取 details 里的嵌套对象 |
| 总价无效 | 有效分项进入带未知标记的小计 | 不回退分项，整笔未知 |
| 没有总价但四分项齐全 | 仍是未知小计 | 当成已知和，无问号 |
| 明确记录零 | 标为已知；当前today-cost/today-spend会显示明确零金额 | `$0.000`；Hide zero可藏。两边都不能据此确认供应商实际免费 |
| 未知展示 | `+?`、`recorded`、`unknown`、`cost unknown recorded` | 金额后直接加 `?`，如 `$0.000?` |
| 关闭/切会话后的旧数字 | 写入文件后由锁和身份去重 | 新界面和 JSONL 本来就对；旧实例内存重建必要性待重评 |
| 主题 | 不涉及 | 默认 appearance 配套保留；手动键相对基线无净变化 |

两边都没有做缓存预热专项、非标补算、quota 或认证改动。


Subagents另有两层：子累计来自整个子会话journal；父侧已报告水位原本按当前父分支收据恢复，本轮增加嵌套收据和离开分支后的预留清理。它不是Meter的跨文件来源去重，也不能据此承诺Glance、Meter、Pi在所有分支与残缺输入下显示同一数字。

## 当前需要分别作决定的事项

以下是审计结论，不是自动实施清单；不因为写在这里就回撤、增加限制或安排发版。

| 类别 | 当前结论 |
|---|---|
| 有明确行为依据，不应被“都是内部整理”一并否定 | 子任务嵌套执行绕过限制、最终请求缺收尾提示、Todo嵌套修改后reload丢状态、Meter负费用降低小计/预算、标准usage记录不被读取，都有具体契约或行为证据 |
| 有维护价值，但应去掉“旧功能坏了”的包装 | Consult/Recap公开registry入口整理、Fast移除重复provider/预算配方、Volcengine类型收敛；必要性应讲接口稳定和减少维护，不编造旧认证/计费/协议事故 |
| 应明确作为政策审阅 | Meter残缺分项小计、recorded/+?、明确零金额显隐；Herdr model-only；Tool Display深层可见性及live预算。用户已接受硬安全显示上限机制，不等于这些全部由SDK要求 |
| 已选策略，不借本次文档悄悄反转 | Fast请求范围与估算代价、Subagents按当前配置恢复且不迁移旧任务、Todo/Question/Consult调用入口选择、Recap不补账、Glance删除不可操作说明行 |
| 必要性应降级而非自动保留为“修故障” | Glance已卸载实例迟到费用重建只是内部一致性加固；其真实可达和测试红不等于账本或用户界面有错 |
| 不应制造的新任务 | Tool Display owner替换未证明产品错误，全局共享主题/配置符合用户预期；“两个生产NestedStore要合并”前提不成立；内部compact差异不能冒称当前公开模式故障；不为这些先重构 |
| 已证展示差异，是否修改另定 | HTML仅展开SDK列表后出现扩展新增重复；原生codemode直接调用重复属于宿主已有。省略参数单行像空值，但总提示仍在。这些都不是执行或收费重复 |
| 发布前仍须单独处理 | Review的Subagents依赖底线、根聚合组成/既有发布前事项、实际version PR。配对本地安装成功和本审计均不等于正式发布批准 |

### 已撤方案不要再算作当前新增功能

- Search结构化返回及相应迁移接口已撤，当前保留文本。
- Subagents三工具的model-only中间限制已撤；最终暴露相对main没有净变化。历史权限交集和旧任务迁移也不在当前方案内。
- Cursor本轮改造整体撤回，包内与main一致；不等于停维护。
- Glance显式手动cacheKey追加appearance已撤回，与main无净差异；新增合同只是防止这条附带语义再次进入。
- Fast的provider包装、本地流参数/上下文预算配方已删除，不应仍把旧适配方案列为交付。

## 已有验证证据索引与未测边界

**本次文档工作只做差异/源码/既有证据审阅，没有重新执行产品测试。** 下表是已保存的相关结果，不是新增一轮总验收；测试实现一致，不代表需求或必要性已被证明。

| 范围 | 已有相关证据 | 不能外推 |
|---|---|---|
| Fast | `c700228`的37项、真实loader/打包；`/var/tmp/pi-1.2-review/fast-main-session/` | priority实际权限、服务速度、真实加价账单 |
| Subagents | 旧1.2直接调用正控、嵌套写marker与grace对照；`fdf9a43` 1164项含独立62；后续独立1.3复验；`/var/tmp/pi-1.2-review/subagents-orchestration/` | 旧0.86同一嵌套路由、所有manager竞态、原生MCP/R3、Bun、真实服务 |
| Consult | 历史111项与公开SDK/假认证合同；生产净减127行 | 所有OAuth厂商、真实认证刷新或旧主路径必然失败 |
| Meter | 边界原4失败/7通过→11通过；实际1.2与同源码1.3各278；`/var/tmp/pi-meter-boundaries/REPORT.md` | 默认Pi分支已漏账、真实负账样本、真实账单对账 |
| Glance | 当前代码1.2/1.3完整check，原独立14＋新3；12个生命周期场景；`/var/tmp/pi-glance-boundaries/REPORT.md` | 已卸载旧状态变化等于实际费用故障、真实系统明暗通知/TTY。原生revdiff只配置验证/dump实跑 |
| Tool Display | 包套件历史1.3 1302；最新Grok具体场景仅SDK1.2；`/var/tmp/pi-tool-display-validation/REPORT.md` | 历史绿测覆盖新争议组合、默认Agent变色/框消失、当前Mac/TTY/IME与性能幅度 |
| Search Hub | 文本/取消候选实际1.2和独立1.3各186，含独立36；`/var/tmp/pi-search-cancellation-review/REPORT.md` | 在线搜索额度、所有服务对取消的实时响应 |
| Recap | 历史84通过/1tmux跳过；1.3副调用/显式usage写入离线正反控 | tmux未测路径、真实收费是否发生、自动记账已经实现 |
| Todo | 历史215项；实际1.3六场景持久化探针；`/var/tmp/pi-todo-review/REPORT.md` | 这是旧包全套对照、tree/compact也已新实测 |
| Question | 历史1.3 612项，直接/嵌套边界与UI合同 | 新生产加载故障已修、用户真实问卷/TTY再次验收 |
| Herdr | 历史1.3 201通过/1Windows跳过 | 脚本一定泄漏、当前真实pane退出组合、Windows已验证 |
| Review | 历史1.3 363含独立26，普通external/embedded合同 | 原生MCP连接授权、公开npm发布依赖闭包 |
| Cursor | 撤回后原包355、构建/loader/隔离冻结安装；`/var/tmp/pi-cursor-rollback/REPORT.md` | 已撤迁移代码仍保留、真实账号/计费或全34安装矩阵重新执行 |
| Volcengine | 历史实际1.3 51含独立16，离线transport | 真实Agent Plan密钥、套餐扣额或参考价格等于账单 |
| 根验证 | 历史1.2的44组合合同/34安装矩阵、后续若干局部loader/pack/policy；输入快照各自固定 | 对所有后续改动都重新跑过完整44/34；registration-only loader等于真实工具/MCP执行 |

临时证据路径用于本机追溯；必要的结果、条件和限制已经写入本文，不能要求读者仅凭外部临时日志理解判断。源码与既有仓库合同可按固定Git提交恢复。单独1.3审计没有改正式1.2依赖；历史曾出现的安装/lifecycle隔离偏差和夹具错误不能被后续绿测抹去，本审计没有重新制造或隐去这些运行记录。
