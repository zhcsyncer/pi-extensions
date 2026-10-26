# I1：固定集成候选的跨包与安装核验

本阶段由新独立Pi session只读执行，不改生产、测试、manifest/lock、changeset或进度。目标是找跨包回归与实际安装问题，不是为通过检查重写实现。

## 当前可执行范围

- 精确SDK八包1.1.0/TypeBox1.3.27、目标Node24.21.0；完整16包及root适用检查。
- `node scripts/check-all.mjs <唯一证据目录>/all`逐叶执行，核对每包实际tests/modules/skips、Cursor附加检查、root loader/smoke/pack等；不以总体退出码代替覆盖清单。它自己调用run-isolated。
- 另核正式root check与各包check独有门槛，尤其Glance边界/文档等不能只凭typecheck/test替代；可复用同候选已执行且等价的叶检查，说明对应关系，不无意义重复全套。
- 实际Pi安装矩阵：`node scripts/check-install.mjs <新的证据目录>/install f48a91b8366174f2ece5d393e280641be87fbb70`。previous是明确本地Git基线，不读取用户已安装树；fresh/upgrade root+16包。核实际内容/hash/宿主真实解析，不能用workspace alias或注册成功冒充模型调用。Review显式配候选Subagents，不能宣称registry旧版已修复。
- 阅读隔离脚本后再执行：测试断网/空HOME和凭据；安装允许脚本已有的空配置public registry下载，不访问真实MCP/模型/配额服务。PI_OFFLINE单独不是sandbox。
- frozen-install与精确图/锁不变、原始E0失败分类收口。先读脚本用法，不猜参数；大依赖/解包只放/var/tmp。
- 组合证据盘点：R1/M1/G1、C1/N1/providers及未启用codemode正式路径；现有精确候选独立合同可对应复用，但必须逐项说明它们实际覆盖什么。不要开启新原生能力补绿。

## 保留门槛

R3逐服务连接前授权、P1-B可信MCP身份、A1-B父/子连接及资源联验仍阻塞。R3/K1/P1/D3与R3/A1原生组合不能用普通loader/测试通过销项；因此I1整体仍可能未完成。本轮Go/Antigravity暂缓，不新增配额来源或查询，不关闭#152。

真实服务/CLI/PTY/Mac归L1；宿主不升级，无push/main/release。发布最小依赖范围、版本计划归I2/version PR，本轮安装验证只是候选配对闭包。

若发现失败，保存精确命令/首个根因/原始日志，区分产品回归、夹具/脚本问题、既有冻结债务和环境限制；不吞错、不改断言、不顺手修代码，回协调者划定归属。最终给同一SHA的通过/失败/跳过/未测清单与原始证据，工作树tracked clean。不得将阶段绿灯标为整体升级完成。
