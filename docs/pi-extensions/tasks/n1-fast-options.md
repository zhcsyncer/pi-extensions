# N1：Fast 的 Pi 1.2+ 主会话请求控制

**方案已获用户确认，实施验收状态见执行编排 §0。** 本合同替代此前的 provider 包装／预算一致性方案；旧实现与验证记录可从 Git 恢复，不再作为新实现的要求。

## Goal 与决定

Fast 只控制 Pi 主会话正常模型请求的服务优先级，不拥有模型协议、预算、采样或费用算法。用户接受官方 SDK 本地费用估算与原请求选项路径之间的差异，不要求 Consult、Recap 等第三方扩展的直接 SDK 调用跟随开关。

采用公开 `before_provider_request` 钩子：保留官方请求处理链，只在符合开关条件时向请求正文注入 `service_tier: "priority"`。删除 provider 流包装与本地预算配方，不改 `models.json`。

## 行为边界

- 保留 `/fast`、`Ctrl+F`、按 `provider + model` 的内存开关，以及已有 `settings.json` 启动默认、模型切换和重载行为；不新增全局所有模型开关。
- 保留既有支持范围：OpenAI Responses、Codex Responses、xAI Responses 与自定义 xAI Completions。不更换模型、认证、URL 或计费渠道。
- 仅在已支持且开启、模型和请求正文有效时，返回带 priority 的正文浅拷贝；不原地修改输入。关闭或不适用时不注入，也不删除用户原本配置的字段。
- 不注册或接管 provider，不维护 token 估算、输出预算、采样、思考转换或费用倍率。
- 费用由官方 SDK 按其响应与选项规则估算；正文注入不回填 SDK 的请求档位，缺失响应档位及 Codex 特例可能与原包装的估算不同。此边界已获用户接受，不以改模型基础价格补偿。
- 控制范围是当前 Pi 主会话的正常 Agent 请求，不承诺覆盖第三方扩展直接调用 `ctx.modelRegistry` 的请求，也不为此修改其他扩展。

## 验证合同

重点测试自有行为，不复制官方 SDK 的预算、采样或计价测试：

- 实际 Pi 1.2.0 loader／session 与离线传输中，支持路径主请求 on/off 的 priority 字段符合开关；保持模型、渠道及无关请求内容。
- 开关按 provider/model 隔离，不支持或无模型时不注入；既有快捷键、默认设置和重载合同保留。
- 公开注册边界没有新增 provider 包装；在无额外用户 tier 配置的夹具中，主会话 Fast 开关不因 provider 覆盖而改变扩展直接 SDK 调用。
- 类型检查、真实 loader 和发布文件完整性通过。真实服务是否兑现 priority、真实账单不在离线验收中。

实现者维护自有测试，不读写独立合同。独立作者以公开契约／SDK 编写 `packages/pi-fast-mode/tests/pi12-main-session.contract.test.ts`，替换已退出范围的 `pi11-options.contract.test.ts`；不读取实现体或实现者测试。旧预算文件被删除后，不为旧测试保留死代码。

仅调整 Fast、必要双语说明、同一功能的 root/Fast changeset 与删除文件的打包清单。共享计划由协调者维护；不修改其他包或真实认证配置。目标实测版本为 1.2.0，不把它扩称为所有未来版本均已验证。
