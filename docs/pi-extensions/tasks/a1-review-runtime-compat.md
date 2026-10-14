# A1：Review 后端兼容与依赖核验

范围仍为packages/pi-adversarial-review及其已适配Subagents运行时消费；不修改Subagents、不扩大MCP授权、不新增Review模型工具。

## 已确认结构

- src/index.ts仅注册/adversarial-review命令和消息/entry renderers，没有registerTool。因此不能凭旧计划泛化描述添加model-only元数据或虚构工具。
- src/runtime/resolve-runtime.ts在spawn前探测已加载Subagents的RPC v3后端，失败才选embedded，并在整次run固定选择；执行后的失败不能回退再跑一遍。
- external指现有Subagents扩展的事件总线RPC，不等于另起全局Pi CLI；embedded动态导入公共@zhcsyncer/pi-subagents/runtime的CallerOwnedAgentRuntime，不注册Agent工具。
- embedded-runtime.ts固定isolated:true/inheritContext:false。两条路径的review-agent-config.ts给reviewer/refuter只配read/grep/find/ls，format-repair配[]，extensions:false/skills:false。

## 第一阶段：只读核验，不改原验收范围

原DAG以R3为前置，R3逐服务MCP仍暂停。先核清A1这些本来关闭扩展的后端是否可以独立验证普通工作流；这只是可执行范围核验，不自动解除R3联验或标A1完成。

- 阅读以上边界及R1/R2公共交接；复用已有SDK/安装证据，不重复R3私有loader/auth研究。
- 检验external RPC与embedded实际复用当前R1/R2运行时、format-repair真实无工具、副作用失败后不双跑、stop/terminal/dispose语义。必要时最多1-2个聚焦离线探针，其他详细矩阵留独立测试阶段。
- 区分父会话已经配置/连接MCP与review子会话是否另装载/连接；不能只隐藏工具就声称隔离。若现有公开信息不足，报告准确缺口，不伪造可信绑定或放宽合同。
- 真实安装来源需确认包依赖解析到目标tarball/适配runtime，不能仅靠workspace alias绿灯；可先给最小独立fixture/安装方案，不新增依赖或发布版本。
- 输出目前可验证的范围、仍受R3约束的具体项、确切公开fixture接口。没有已复现缺陷不改代码；不自建调度或权限框架，不复制工具/SDK实现。

当前仅授权只读产品核验和隔离临时探针，HEAD/源/tests/manifest/lock须保持clean。源仓SDK1.1.0/TypeBox1.3.27，禁真实模型/MCP/账号/仓库mutation/终端接管，只有临时Git fixture可写。禁止push/main/release/升级宿主；第二阶段须协调者另冻结。未来独立预留tests/pi11-runtime.contract.test.ts，当前不写。
