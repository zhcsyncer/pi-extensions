# H1：Herdr companion 必要兼容

依赖E0。只做Pi1.1必要兼容及已批准的model-only，不改命令体验，不删除现有桥接，不启用闲置工具。

## Goal / AC

- 实际入口`extensions/herdr-companion.ts`→`src/extension.ts`，session_start的activateCore委派`src/process/tool.ts:registerHerdrProcessTool`。为实际herdr_process定义加`exposure:"model-only"`；它原本有`executionMode:"sequential"`，保留，不把其它包“不新增sequential”误套为删除这里的既有行为。
- 顶层调用仍能使用自己的进程；嵌套调用在宿主边界拒绝，不能启动/停止pane或调用管理动作。不自己造授权系统。
- 保持outside-Herdr严格no-op、runtime注入、进程归属/退出日志、session/tree/shutdown清理、BTW及blocked适配。`src/worker.ts`中的herdr_worker目前明确未注册，不能顺手启用或扩大字段范围。
- 检查Pi1.1原生OSC与既有socket/全局herdr-agent-state v9的信息和优先级边界。session身份、socket定位、custom blocked未证明等价前，保留现有桥接；允许只读比较/隔离探针，不改真实全局扩展或profile。
- 只修复实际重现的1.1接口差异。Herdr子命令补全、空调用菜单与其它已冻结体验不做；有硬依赖先报告。

## Test Impact

最小生产改动预计仅真实tool定义，配少量SDK集成回归：真实loader激活、顶层list等无破坏性正控、native nested零管理副作用、已有session/blocked/BTW回归。原process sequential及只管理自身pane不变。

进程/CLI边界用临时fixture transport，不调用用户真实pane。完整加载前隔离HERDR_*身份/socket与PI_CODING_AGENT_DIR，不能让测试上报覆盖真实会话。原生OSC可以用精确1.1离线faux provider/测试终端观察；若需要真实Herdr集成，只允许自己新建的临时验证pane，不控制用户或其他任务pane，结束回收。不能把inactive/no-op loader说成活动路径已过。

包级完整check与真实loader，双语说明/独立changeset；明确合成与实际覆盖边界。没有模型生成需求则不调用真模型；确需实际模型时按用户偏好优先Cursor/grok-4.7，不改登录或启用其他真实服务。

## 实施边界

允许仅本包有关源码/测试/必要双语说明及changeset；不改SDK/lock、其他包、全局herdr-agent-state、账号/配置或统一进度。先核对精确1.1已有公共API和实际注册点，复用既有管理/blocked逻辑，不造框架。读取绝对coding/Herdr/worktree/testing规则及相关官方SDK文档完整链接。

任务专用Herdr worktree与独立Pi session，本地提交可；不push/main/release，不派其它实施者。通过独立审阅/集成态复验后才验收，已结束环境及时回收。
