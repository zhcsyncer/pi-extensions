# X1：外部 Ollama Cloud 0.13.0 的 Pi 1.1 兼容

来源已确认：fgrehm/pi-ollama-cloud，官方v0.13.0解引用为09c5d573ed5790c25e31228520d693924848245b，与当前安装包0.13.0一致。只在该来源仓库的专用Herdr worktree/Pi session交付；不改本仓产品代码或全局node_modules冒充外包交付，不安装到运行宿主。

## 保留边界

- 开发验证目标Pi1.1.0、TypeBox1.3.27；运行宿主0.87.1不升级。0.12.2的旧诊断不是当前证据。
- 保留ollama-cloud身份、固定cloud服务路由、现有Pi credential/env优先级、fallback/live catalog/partial-failure/取消语义、推理等级及禁用思考的既有约束。
- 保留普通direct web工具/缓存/额度显示及配置行为。不得新增收费推断、替换账号或通道、扩大工具默认曝光；是否需要额外适配以当前版本真实SDK证据为准。
- 不调用真实models/web/usage/inference端点，不执行live smoke或生成器；不读取真实profile/凭据。全用合成HTTP/离线模型；Go已另行暂缓，与此无关。
- 维护来源仓库模块划分及生成数据，禁止手改*.generated.ts，不更新catalog/价格/限额。若迁移确需触及源仓明确规则，先报告具体冲突，不直接绕过。

## 第一阶段：当前版本复现与最小公共接线（只读产品）

主调度已定向读：index.ts的双参数registerProvider及refreshModels接线；models.ts的ChatModelConfig、显式OpenAI compat、assembleModels和refreshOllamaCatalog；thinking-levels.ts从ProviderModelConfig派生类型。web-tools仍用@sinclair/typebox且无outputSchema/structuredContent，但不能仅凭这些名字宣称不兼容。

- 源仓lock锁Pi0.87.1；在自己的node_modules准备精确1.1验证依赖，不修改tracked manifest/lock。允许npm install --no-save --package-lock=false --ignore-scripts的临时本地依赖准备，必须核实际SDK/TypeBox版本、共享SDK图和Git clean。依赖/缓存放/var/tmp或worktree，不能放大到/tmp。
- 只运行非写入lint/typecheck与至多必要的真实SDK注册/请求形状离线探针。源仓check包含biome --write，第一阶段无代码变更不要运行它；禁止build/generate/live smoke。类型问题逐项归类为真实1.1缺口/夹具配置，不盲目修。
- 使用公开SDK loader/registry与合成凭据、临时agentDir/cwd；清除环境中的真实认证来源，禁未知请求，必要探针放ignored临时路径或/var/tmp，不提交。
- 输出最小接线方案、确切SDK公开声明、普通请求/推理/工具/已有usage入口的公共独立fixture接口，以及源仓规则冲突（如TypeBox包名、生成文件、API语义）需确认之处。不要复制SDK provider/auth实现或造适配框架，不穷举网络服务矩阵。
- 报告后停止，生产源/测试/manifest/lock保持clean；第二阶段由协调者根据当前证据另行冻结，再派独立作者。

## 第二阶段冻结：验证交付，不进行产品迁移

第一阶段未复现0.13.0的阻断性1.1兼容问题。双参数registerProvider、ProviderModelConfig派生、legacy refresh返回列表仍受公共SDK支持；无outputSchema的web工具返回文本是合法边界。不重写provider，不增加结构化输出或改现有功能。

协调者已核八个Pi包（含agent-core/telemetry/codemode/mcp/chord）全部1.1.0，且官方tag与已安装包15个声明文件字节一致。第一阶段TypeBox验证用了ignored npm别名：@sinclair/typebox→typebox@1.3.27；它不是已提交的依赖迁移。第二阶段必须增加原声明peer的忠实对照，不能用临时别名掩盖原包问题。

- 当前worker只补源仓全套离线check/test与精确环境证据，不改产品/manifest/lock/生成文件；源仓check包含--write，先确保固定Biome2.5.4的只读lint通过；若它改动既有tracked文件立即报告，不能顺手提交或隐藏。
- 独立作者仅新增`test/pi11-sdk.contract.test.ts`，进入原vitest机制；本地测试提交用于目标SDK验收，不声称已更改上游开发锁或形成发布。上游package-lock仍旧版本，重建目标环境的精确no-save命令必须记录在证据中，不偷偷升级默认依赖。
- 主矩阵为Pi1.1.0/typebox1.3.27。额外对照保留源码声明的@sinclair/typebox原版peer，核types及官方loader；随后可重建原别名验证树。明确区分类型结果、真实SDK loader官方映射与原包实际行为，失败时先报告，不主动迁移包名。
- 独立合同以真实SDK loader/session/registry、合成HTTP及临时持久store驱动，不调用产品assembly生成期望，不复制工具定义。保留普通请求/系统与工具/推理off/high和off-null限制、实际usage桶、cloud与credential/env边界。
- 覆盖web工具direct与合法nested/codemode文本返回、缓存、越界及401/429/取消；以SDK真实参数转换为准，2.5转2不是产品缺陷，越界11必须拒绝。
- 补catalog的成功/最后良好目录、部分失败、预取消及中途取消、cooldown/force与真实store恢复；不要求改成native Provider.refreshModels的void合同。错误集合是Map；modelsPath:null不构成文件恢复证据。
- 既有usage命令、显式启用的TUI状态开关/关闭/切模型或shutdown后迟到结果不写旧UI，需要真实生命周期或公共UI正控。可用假时钟，不运行真实账号/定时轮询。生成费用仍是等价参考价，不称真实收费。
- buildCompat少显式列出十个可选键属于维护约定缺项，尚无请求异常；当前不改清单/默认或生成文件，也不把可选字段缺项写成协议失败。出现真实wire差异再由协调者冻结最小修复。

独立作者不得读取产品实现体或现有实现者测试，只读公开SDK声明、用户README和协调者公开fixture交接。收到提交后固定候选审阅，完整check/types/test/真实loader及pack确认通过才能把X1标为已验收（官方0.13.0无产品变更）；真实Ollama服务和终端仍另列未验。

所有阶段禁止push/upstream PR/main merge/release/tag；源仓发布规则不构成授权。当前仅本地源码与验证，未决定将任何外包版本发布到npm或替换用户安装。
