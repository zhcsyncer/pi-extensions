# E0：Pi 1.1 共用依赖与隔离验证基线

状态：已批准派发合同，尚未实施验收。全局状态只在[执行进度表](../pi-1.1-execution-plan.md#0-统一进度表调度-session-唯一写入)更新。

## Goal

让后续任务使用同一可重现的 Pi 1.1 开发/测试环境，不各自升级依赖或误用现有 0.86/0.87 宿主。基线工作只解决依赖、来源和验证入口，不替后续任务修改业务实现，也不以升级版本号掩盖已知适配失败。

## AC

1. 根 bundle、14 个 `packages/` 子包、2 个 `providers/` 均列出当前 dev/peer、实际使用的宿主模块、适用类型/测试/pack 命令及其结果。外部 Ollama 和全局 Herdr bridge 只记录非秘密来源、版本和后续负责人；找不到归属则明确未确认，不手改安装目录。
2. 开发/测试的实际 Pi SDK 图精确固定到目标 1.1.0 及其核验后的配套包版本；按真实使用更新根/各包 manifest、`pnpm-workspace.yaml` 和 `pnpm-lock.yaml`。宿主提供模块按目标规范声明 peer `*`，包括使用中的 TypeBox 兼容别名；不把所有第三方依赖改成 peer，也不因旧 import 名字做全仓迁移。不存在的包/版本不得编造；目标不可取得须报告阻塞，不换目标版本。
3. 可在独立工作树用冻结锁文件重装，开发副本与宿主加载语义不混淆；不删除现有发布龄/build-script 安全策略。全新安装/升级安装与 standalone/bundle smoke 的隔离验证入口存在且可复用，不依赖用户 auth 或工作区额外扩展。
4. 修复 `packages/pi-tool-display-intent/tests/helpers/aggregate-terminal.ts` 对目标 Terminal 的 fixture 契约缺失及相应纯测试适配；不改变生产渲染实现。共享检查必须覆盖所有 16 包，不把根 `pnpm check` 的子集误报为全覆盖。
5. 运行适用检查，提供每个失败的精简证据、旧/新基线归属及后续任务 ID。E0 自身新增的脚本/环境/fixture 检查须通过；其他尚未实施的生产兼容失败可以留在清单，但不得将它们伪装成通过。不得借机修 R1/C1/D1 等生产逻辑。
6. 不修改任何包发布 version，不运行 version/release/publish。用户可感知的依赖兼容性变化用语义独立 changeset 表达，bundle 联动规则保留；不把无关包的发布说明塞到同一 changeset。

## Design 与允许写范围

- E0 是共享依赖单写者：根 `package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`，`packages/*/package.json`、`providers/*/package.json`，必要 tsconfig/测试配置，以及共享 check/smoke/pack 脚本和相关测试。
- 允许修改上述 `aggregate-terminal.ts` 与必要测试夹具；新增有实际复用价值的隔离验证脚本时放现有 scripts/test-support 体系，不为一次探针建立新框架。
- 不改任意包生产 TS/JS，不改 `.github/workflows/`、全局 Pi/Herdr 配置、真实 auth、主工作区、总计划/进度表，也不删除已有目录。若共享 CI workflow 确有硬依赖，先报告，由调度者另走上下文/范围规则。
- 大依赖留在本地盘 worktree 或 `/var/tmp`，可复用 pnpm store，但不同工作树不共写同一个 node_modules。测试 agentDir/HOME 显式隔离，不复制真实凭据；安装/公开文档请求可以联网，单元/集成测试不调用真实模型、MCP 或额度服务。
- 执行宿主保持 0.87.1；目标 1.1 loader/SDK 在隔离子进程/安装树验证，不热更新正在执行的 Pi。对不同目标版本 docs 的引用明确标记，不把现有宿主文档当 1.1 依据。

## Contract / Test Impact

E0 主要为 T2 环境编排，不引入新的产品算法/授权规则。沿用既有 release-policy、smoke、pack 测试，增补实际缺少的环境合同，不断言 manifest 常量来凑数。

| 输入/场景 | 应验证的结果 |
|---|---|
| 冻结 lockfile 的干净安装 | 解析到核验后的目标图，不偷偷升级其他主版本，不改发布龄/脚本策略 |
| 根 bundle 与各 standalone 的隔离加载 | 使用实际发布形态/loader；宿主模块归属可解释，没有私有副本绕过宿主的声明风险 |
| 16 包现有检查 | 每包都有实际命令或不适用原因；失败保留非零结果，不用 `|| true` 把总结果报绿 |
| Terminal fixture | 满足 1.1 合同，原工具显示测试继续表达原行为；生产源码不顺改 |
| auth/网络隔离 | 测试使用空白 agentDir 与离线 provider/transport；no-op factory 单独注明，不算真实活动能力通过 |

真实安装验证若遇到仍未完成的生产适配，可将可运行入口和准确失败结果交付给后续任务；E0 出口是可复现环境，不是整轮升级验收通过。

## Handoff

- 必读：全局 `/root/.agent-vm-state/pi/agent/AGENTS.md`、`/root/.agent-vm-state/pi/agent/rules/coding.md`、`/root/develop/AGENTS.md`、本 worktree `AGENTS.md`；完整读取总计划 W0/范围与执行编排。本合同不扩大权限。
- 派发时先回报 cwd、origin、base SHA、允许写范围；不匹配不编辑。代码/计划 base 由调度 prompt 给出。
- 完成后在自己的任务分支本地 commit，回复提交、改动范围、实际命令/通过失败、16 包清单与下一步归属；有阻塞直报。不得 push、改 main、合并其他任务、关闭 issue、发版或改真实 profile。
- 进度表由调度者更新；正常通过 Herdr agent 回复交付，不另建任务状态账本。
