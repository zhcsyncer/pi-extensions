# I2：最小交付材料修订

只修已确认的用户说明和既有changeset覆盖，不改变生产、包版本、依赖范围、锁或发布流程。I2完成不等于整轮验收或发布授权。

## 已核实范围

- root双语：Pi0.86及旧transcript支持承诺改为本轮Pi1.1+；Search已独立公开，删除only/private矛盾并加单包安装入口。
- Plan双语：统一Pi1.1+下限，不宣传未完成的P1-B。
- Review双语：删`>=0.84.0 <1`旧范围，写Pi1.1+；外部Subagents须使用支持Pi1.1的适配版本，仅protocol-v3不是兼容保证。不要提前写死0.2.4或说已发布；manifest最低版本由未来version PR按用户确认后的版本核对。
- Meter/Search双语：明确本版本仅支持Pi1.1+，保留既有用法和计费/订阅边界。
- Subagents双语：说明Agent/get_subagent_result/steer_subagent为model-only，模型直接调用保留、另一工具/脚本经工具层嵌套调用不允许；公开runtime API不因此被禁止。不得新增权限或原生MCP承诺。
- 五份专项changeset给root补同一功能正文：f1-question-model-only、f1-todo-model-only、glance-recorded-usage-appearance、recap-native-completion、search-hub-structured-results。前四root patch、Search root minor，均不改变现有root拟议minor结果。

审计原说六份，协调者依据root.pi.extensions和README纠正：Herdr需独立安装，root不启用，**quiet-herdr-boundary保持只列Herdr**，不能仅因files中打包源码就冒称根包提供其工具。Review/Cursor/Volcengine同样不混入root专项正文。

## 不变项与验证

只允许root、Plan、Review、Meter、Search、Subagents共六对README及上述五份changeset；不泛重写开发/存储旧章节，不修改BACKLOG或其勾选。原工作区BACKLOG的Next root bundle release未勾项为0，但其余冻结债务和用户新增条目不能被候选旧版覆盖。不要新增一份把所有不同功能混在一起的changeset。

版本表当前仅为Changesets status拟议值，未获用户发布review；不得运行version/version-packages/publish/release/tag，不push/main或合version PR，不升级宿主。

保持标题/互链双语一致，用户README只留核心功能与用法。先跑文档/包check的相关契约、release-policy/status只读、pack17；如旧硬编码版本断言冲突，报协调者明确定位，不能删断言。交本地commit后由非作者审阅，固定新SHA；README改变发布字节，需重验受影响包安装/加载，不把I1旧安装结果全量盖到新内容。

保留R3/P1-B/A1-B及I1原生组合BLOCKED，L1真实服务/CLI/PTY/Mac等UNVERIFIED，Go/Antigravity DEFERRED；不声称真实GitHub issue已关闭。最终交用户完整current→target计划与剩余门槛，本任务不是批准发布或缩减原范围。
