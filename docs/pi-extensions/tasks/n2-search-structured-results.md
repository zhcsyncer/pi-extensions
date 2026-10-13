# N2：Search Hub 普通调用与脚本结构化结果

依赖E0。只做Pi1.1必要兼容及已批准的outputSchema/structuredContent；保持现有routing/combine/RRF/reader、认证和计费路径。登录识别/认证分流、hosted usage补报、跨会话配置串用三项旧债冻结，不顺带处理。无真实搜索服务/额度/账号授权。

## Goal / Design

`extensions/search-hub.ts`真实注册的web_search/web_read既保留当前文本预览，也返回成功结果的结构化数据，让可选codemode脚本无需解析文本。默认direct路径继续可用，不自动开启codemode/MCP、不设model-only、不增加displaySummary或强制sequential。

复用已有规范化结果和details信息，不新增backend或重新抓取网页。`withClaudeRows`包裹必须保留新增outputSchema；现有文本formatter、专用renderer和进度消息不改语义。outputSchema只描述成功终值；异常/取消仍按SDK错误路径，不包装成成功数据或返回假的空结果。

## 冻结成功输出合同

两工具均在真实ToolDefinition声明outputSchema，所有成功final return带对应structuredContent。以TypeBox/JSON Schema描述可序列化数据，不暴露原始Response、凭据、内部registry对象或未规范化backend payload。

- `web_search`：必有`query:string`、`backend:string`（真实后端ID，combine为`combined-targeted`）、`resultCount:number`、`results:Array<{title:string,url:string,snippet?:string,content?:string,backend?:string}>`。结果来自已有路由/RRF规范化列表，次序/去重/来源不变；compact只改变文本，不删除结构化结果。可带既有`warnings:string[]`、`errors:string[]`、`usableBackendCount:number`、`backendStats`诊断，但只用现有信息、不新建统计系统；缺值省略、不伪造。
- `web_read`：必有`url:string`（实际规范化请求URL）、`reader:'firecrawl'|'exa'|'parallel'`、`content:string`、`length:number`、`truncated:boolean`。content是已有10000 UTF-16 units正文上限内的前缀，不掺文本截断提示；length保留原content.length口径，truncated指示正文裁剪。可带既有warnings/fallbackErrors字符串数组。模型文本保持原来的正文及截断提示，不能为了脚本返回悄悄绕开原限额。没有取得title就不捏造title。

## Contract / Test Impact

独立预留`packages/pi-search-hub/tests/pi11-structured-results.contract.test.ts`，Vitest。

| 场景 | 预期 |
|---|---|
| 真实注册及普通direct成功 | schema可见，structuredContent符合schema，原文本/details/renderers仍在 |
| 同结果compact开关 | 文本按原选项变化，结构化数据不受格式开关影响 |
| 单路fallback及combine/RRF | 选择/次序/去重/来源不变，已有失败诊断不丢；不串换认证渠道 |
| 单路0结果、combine无可用结果 | 前者保持既有成功空列表；后者保持失败，不伪装成功 |
| reader正常、fallback、bare domain、超过正文限额 | reader/URL/原长/截断标记真实，正文前缀与文本体验一致 |
| 后端错误与取消 | SDK真实失败/终止；不把部分进度当final成功，不引入额外付费请求或取消后的下一路调用 |
| 可选codemode真实执行 | `await tools.web_search/read(...)`收到可访问字段的结构化对象，而不是需要解析的文本；普通模式无需codemode |

必要取消缺陷如基线确实存在可最小修正signal传播/退出，不借机重构认证、key rotation或旧统计。其余冻结旧债不当验收门槛。

## 独立公共夹具入口

真实入口default export来自`extensions/search-hub.ts`，经DefaultResourceLoader加载；使用createAgentSession/faux provider和可选createCodemodeExtension，执行真实tool pipeline。SDK1.1 outputSchema描述成功structuredContent，脚本收到该对象；不能mock注册定义/execute返回来证明自己。

临时配置：`$PI_CODING_AGENT_DIR/extension-data/pi-search-hub/config.json`或可信临时project的`.pi/extension-data/pi-search-hub/config.json`。形状`{routing:'priority',priority:['exa','firecrawl'],backends:{exa:{enabled:true,apiKeys:['fixture-key']},firecrawl:{enabled:true}}}`；其他后端显式禁用，宿主模型faux、凭据空白。允许拦截HTTP传输边界，不mock产品路由/formatter/registry。所有请求必须命中离线fixture，未知地址直接失败，不放行网络。

HTTP公开边界：POST `https://api.exa.ai/search`响应`{results:[{title,url,text,highlights:[]}]}`；POST `https://api.exa.ai/contents`响应`{results:[{title,url,text}],statuses:[]}`；POST `https://api.firecrawl.dev/v2/search`响应`{data:{web:[{title,url,description}]}}`；POST `https://api.firecrawl.dev/v2/scrape`响应`{data:{markdown,metadata:{title,sourceURL}}}`。现有Exa text/Firecrawl description成为最多500 UTF-16 units的snippet；本轮保留该规范化，不能把原始响应全文重新塞回结果。需要额外响应形状/公共入口时向协调者列出缺口，不读取待测实现、实施者测试或真实profile。

独立作者只读合同、SDK公开文档/声明及通用fixture。实现者不可读写预留测试。保留源码/测试路径限制，真实网络/登录/额度操作禁止；若后来真模型验证必要，优先用户指定的Cursor grok-4.7并另交最小验证方案。

## 交付

只修改本包必要源码、自有测试、双语README、包级docs及单独changeset；不改其它包/manifest/lock或总进度。精确SDK1.1/TypeBox1.3.27，目标PATH/run-isolated下package check、真实loader和必要pack通过。独立作者交baseline pass/red/fixture分类，组合后审阅、集成态复验才算完成；本地commit可，push/main/release不可。
