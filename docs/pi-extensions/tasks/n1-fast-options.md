# N1：Fast 的 Pi 1.1 options 与预算适配

执行合同；依赖 E0 已验收。进度仅在执行编排 §0 更新。

## Goal / AC

Fast 仍只为同一模型选择服务优先级，不应因包一层 provider 就丢掉宿主的选项、采样规则或上下文安全预算。沿用用户已有开关/计费渠道，收缩重复底层配方。

1. 保留目标 SDK 的完整 stream options，尤其 E0 已复现缺失的 `onProviderStreamEvent`；signal、认证/headers/env、payload/response、telemetry、session、timeout/retry 等原行为无新增丢失。
2. 采样遵循“模型默认 < 当前思考档默认 < 请求显式设置”；不能把模型默认提前复制成请求 override，从而覆盖思考档。off 与缺省字段按官方合同处理。
3. 上下文预算与精确 1.1 官方算法一致，包括 3.5 字符/token 的估算；不得用旧 4 字符配方放大输出空间。只计算真实适用的 transcript 范围，不额外发 tokenizer/模型请求。
4. 先验证官方 helper 是否可由真实 Pi 1.1 extension loader 安全导入。可复用则复用；确实无公开 loader-safe 入口才保留一份最薄本地配方并用真实 SDK 对照，不使用脆弱绝对安装路径作为产品 import。
5. OpenAI/Codex/内置 xAI Responses 的官方序列化、service tier 与费用语义保留；自定义 xAI Completions 的现有 payload 补位不扩散到其他 provider。不开 Fast 时不加入 priority，不换模型/账号/渠道。

## Design / 已定位边界

`packages/pi-fast-mode/extensions/stream-options.ts` 是本地 buildBaseOptions/估算配方：当前 CHARS_PER_TOKEN=4，手动枚举 option 字段，且提前合并 model.samplingParams 与 options.samplingParams。`extensions/fast-mode.ts` 的公开 buildStreamOptions(model,context,options,serviceTier) 把其结果交给官方 Responses stream，并从 reasoning 得到 reasoningEffort。围绕这些边界核验官方 helper 与采样层次，不重写 provider 或 tokenizer。

现有文档关于 0.86 loader 深路径限制仅是旧基线事实；用目标 1.1 真实加载验证决定保留/删除配方。没有验证前不能以“官方已有”删代码，也不能以旧结论继续复制所有内部实现。目标仅 1.1+，不添加双版本分支。

只写 Fast 包相关实现/测试、必要双语说明、包级架构说明与独立 changeset；不改依赖锁或其他包。不开虚拟模型路由，不做命令 UX、套餐额度、旧内存设置生命周期口径重构，也不借 raw options 保真实施 Search 的三项冻结旧债。

## Contract / Test Impact

T0 为精确预算和采样优先级，T2 为真实 loader/provider 接线。以公开 buildStreamOptions 与实际发送给离线 provider/transport 的请求为观察面，不用可变元数据假对象证明注册生效。

| 场景 | 预期 |
|---|---|
| 单条 user 含32000字符，contextWindow=20000，maxTokens=16000，无已上报 usage | 与官方 1.1 一致，输出预算 6761；不是旧配方结果 |
| 模型默认 temperature=1，high 档默认 temperature=0.3/top_k=20，无显式请求覆盖 | 实际采用0.3/20，不被模型默认1盖掉 |
| 上述条件＋请求显式 temperature=0.2 | 请求值胜出为0.2，未覆盖的档位参数保留 |
| off、无模型默认、无档位参数、显式采样设置 | 遵循真实官方合并/省略规则，不捏造值或把undefined当强制覆盖 |
| 已有可靠 assistant usage＋后续 transcript、取消/error usage、边界context | 与官方预算一致，保留安全余量与最小合法输出，不双算或使用无效回执 |
| 输入 onProviderStreamEvent 与其他真实 stream 选项 | 实际 provider 路径仍收到相应能力/回调，Fast 不截断宿主处理链 |
| Fast on/off，Responses 与自定义 xAI Completions | 仅获支持且开启的渠道加优先级，原通道、thinking、取消、错误行为保真 |
| 真实1.1 loader 加载当前 package | 被选官方 helper/本地薄配方确实可用；不靠测试进程能 deep-import 就判定扩展 loader 可用 |

独立测试作者后续按本合同编写 `packages/pi-fast-mode/tests/pi11-options.contract.test.ts`（已核对包 test 脚本为 `tsx --test tests/*.test.ts`，该路径可直接收集，使用 node:test，不改配置）。实现者不写该文件，可维护既有测试；代码交付后须与独立测试组合通过才能验收。保持测试预算集中在分支/数值合同，不复制全套框架测试。

## 派发与交付

读取全局 `/root/.agent-vm-state/pi/agent/AGENTS.md`、`/root/.agent-vm-state/pi/agent/rules/coding.md`、`/root/develop/AGENTS.md`，Herdr/worktree 和任务树 AGENTS；完整阅读本合同、总范围及目标 Pi/AI 官方 docs/相关链接。先回报 cwd/origin/base/允许写范围，再说明选用 helper 的真实 loader 证据及独立测试所需模型/档位 fixture 形状。

使用已装 E0 依赖、指定 pnpm PATH 与 scripts/run-isolated.mjs，不访问真实模型、账号或额度服务。交付本地 commit、精确测试结果、已选公开接口与失败边界；不 push/main/release，不改统一进度或自派实施者。
