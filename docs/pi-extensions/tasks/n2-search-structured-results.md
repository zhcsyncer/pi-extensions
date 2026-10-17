# N2：Search Hub 文本结果与取消边界

## 当前决定（覆盖原结构化合同）

用户于2026-10-18确认：开放式研究由主模型或已有web-research子代理负责；本轮撤回Search Hub的outputSchema/structuredContent增强，只保留取消修正。不是禁止脚本使用搜索工具，也不改子代理命名、提示词或权限。

原结构化输出合同及通过/失败记录属于历史证据，不能继续作为产品验收要求；删除相应断言是用户撤销功能，不应描述为修复产品错误或放宽现行合同。

## Goal / Design

- web_search/web_read保持原来的文本结果，普通调用和可选codemode均可用；脚本收到字符串，不自动改成对象。
- 去掉两个工具的outputSchema与三个成功分支的structuredContent。保留原content、details、专用renderer和进度信息。不设model-only，不强制sequential，不新增displaySummary或打开codemode/MCP。
- 保留新增signal检查：调用前已取消则不发请求；已取消后不再启动下一搜索来源、reader或下一批组合搜索；取消仍是失败/中止，不把它当普通失败继续fallback，也不把部分成功伪装成最后成功。
- 已开始的请求未必立即结束，已产生费用无法由此撤销。保留现有并行批次的等待和归属，不新增调度或取消框架。
- routing/combine/RRF、结果排序/去重/来源、认证/订阅/计费、quota副作用、compact和正文限制不变。web_read仍按原10000 UTF-16码元前缀及原文本截断提示返回，details中的URL/reader/length/truncated保持；不顺带改Unicode裁剪策略。
- 登录识别/认证分流、hosted usage补报、跨会话配置串用三项旧债冻结，无真实服务/额度/账号操作授权。

## Contract / Test Impact

T1取消与fallback分支、T2真实SDK接线；复用现有独立合同，删除仅服务于已撤销结构输出的断言，不另堆覆盖率。

| 场景 | 预期 |
|---|---|
| 普通搜索成功/compact开关 | 原文本及details/renderers保持；compact仍改变文本，不新增机器对象返回 |
| fallback、RRF、多源部分失败 | 来源、结果顺序、去重与既有诊断保持，不串换认证 |
| 单路0结果/组合全部空或失败 | 单路空结果仍正常，组合不可用仍失败 |
| 普通读取/bare domain/reader fallback/长正文 | 请求URL规范化、实际reader、原长、前缀与原截断提示保持 |
| 已取消入口/请求中取消/批次间取消 | 不新增后续业务请求，不伪装成功；正在执行的请求不承诺撤销账单 |
| 真实codemode搜索和读取 | 工具仍可调用，返回字符串；旧式文本处理可继续。不要增加model-only限制 |
| 生命周期收尾 | 实际发送session_shutdown后再dispose，不假定dispose会清理扩展激活 |

## 独立测试所有权

独立作者维护原 `packages/pi-search-hub/tests/pi11-structured-results.contract.test.ts`，可重命名为 `search-text-cancellation.contract.test.ts`。新旧两路径均为保留独立文件，实现者不得读写。必须保留普通调用、顺序/去重、fallback、正常空结果、错误、reader、正文限制和取消的有效正负控；原结构化断言中的有效行为移到文本/details或实际HTTP请求观察，不随schema断言一起丢掉。

独立作者仅可读本合同、原独立文件、公开SDK文档/声明及通用fixture，不读实现者源码或 `structured-runtime.test.ts` 等自有测试。实现者可以改/重命名自己的runtime测试，但不得借此替代独立验收。协调者唯一串行集成，原红灯保留。

## 独立公共夹具

真实入口是 `extensions/search-hub.ts` default export，经DefaultResourceLoader和createAgentSession执行。faux模型与HTTP边界可替换；不得mock产品路由、formatter、注册器或结果来证明自身。

临时 `$PI_CODING_AGENT_DIR/extension-data/pi-search-hub/config.json` 使用priority/exa、firecrawl和合成凭据，其余后端禁用。每场景独立进程，不能把冻结的模块配置旧债纳入本次隔离承诺。

公开HTTP响应：Exa search为 `{results:[{title,url,text,highlights:[]}]}`；contents为 `{results:[{title,url,text}],statuses:[]}`。Firecrawl search为 `{data:{web:[{title,url,description}]}}`；scrape为 `{data:{markdown,metadata:{title,sourceURL}}}`。保留已定义的GET `/v2/team/credit-usage`合成响应，不测试或改变既有quota逻辑。未登记请求直接失败，真实网络不可放行。

## 交付边界

实现只改Search Hub必要源码、自有测试、双语README及原Search changeset；原changeset改为取消修复的patch说明，不能仍宣传结构化增强。不改包自身版本、依赖、锁、Fast、全局配置或其它包。总计划与本文由协调者维护。

主候选继续用现有精确SDK1.2.0；独立验证可在专用树应用已归档的1.3审计目标a3c806e，仅作验证，不合入PR。真实版本/路径须核实；所有执行通过run-isolated空profile与断网。若需要依赖获取，先ignore-scripts，必要lifecycle单独隔离，不重演联网安装脚本偏差。

最终验收Search Hub自身check/类型、独立合同、真实loader及必要pack/release policy；不跑全仓44/34，不做真实搜索或账户操作。旧输入与新的文本合同先红后绿，政策红、fixture问题和产品回归分开记录。独立测试环境交付后归档清理；全局Fast引用的实施树必须保留。
