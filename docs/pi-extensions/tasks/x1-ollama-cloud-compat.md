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

所有阶段禁止push/upstream PR/main merge/release/tag；源仓发布规则不构成授权。当前仅本地源码与验证，未决定将任何外包版本发布到npm或替换用户安装。
