# I1 补充：Subagents 两组离线 E2E 夹具

固定普通全量已44/44；排除项补跑有17过/5失败/4 live跳过，另template suite收集失败。尚未把这两类失败计为已验证产品缺陷，也不能当行为已通过。

## 已定位与最小修正

- `packages/pi-subagents/test/agent-runner-e2e.test.ts` 的ctx缺sessionManager；该suite只观察真实session构造后的工具视图。补公开SDK SessionManager及所需当前public ctx/registry夹具，不改runAgent。保留原五组工具存在/缺失断言。catch不得吞掉session未创建的初始化错误；仅原本允许的构造后prompt失败可以与视图验证分开，明确不是完整模型回合/执行授权证明。
- `test/ext-templates-e2e.test.ts` 同样补当前public ctx；其读取的`test/fixtures/.pi/agents`从未进Git，原工作区也不存在，不能声称找回旧模板。为既有模板驱动契约补受版本控制的最小字面fixtures，保持至少六场景、真实frontmatter→loadCustomAgents→runAgent→视图/系统提示链及原断言。
- 复用已有ext-alpha/beta/lazy及e2e-probe模块，不复制SDK工具/授权实现。模板表达有意义的不同边界：builtin限制、扩展关闭、未筛选扩展、ext选择/工具子集、isolated与prompt_mode append/replace（可合并相容条件，不凑数量）。每个模板须有明确正控和否控；不从产品输出反推期待。
- `.gitignore`现有`.pi/`会吞这些数据；仅可为上述fixture目录加精确例外，不能解禁真实用户/项目`.pi`。模板名/期待写入Git，干净checkout无需额外生成步骤即可收集。

## 范围与验收

仅允许上述两个既有测试、其必要fixture模板及精确.gitignore例外；不读/改预留独立R1/R2合同，不改src、manifest/lock、默认vitest exclude、旧private-hook诊断或其它套件。不扩R3/MCP权限、不新增框架、不删/弱化断言。新发现真正产品行为红灯即停下报协调者。

独立实施Pi session修夹具，本轮I1只读验证者复验而不兼任作者。仅临时Vitest配置可选择被排除文件，放/var/tmp且保留原隔离/超时配置；不启用live场景。目标8SDK1.1/typebox1.3.27、空HOME/凭据/断网。交单独本地提交、原红灯→夹具修正→实际行为结果及类型，最终固定候选另审/复测；不因两个夹具修好就完成I1原生组合或L1。
