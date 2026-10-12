import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Type, InMemoryCredentialStore, fauxProvider, fauxAssistantMessage, fauxToolCall,
  createAssistantMessageEventStream, getCurrentTools, type ToolResultMessage, type JsonObject } from "@earendil-works/pi-ai";
import { createAgentSession, createBashToolDefinition, createCodemodeExtension, createMcpExtension,
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, ToolExecutionComponent,
  defineTool, initTheme, type AgentSession, type AgentSessionEvent, type ExtensionAPI,
  type ExtensionFactory, type McpTransportFactory, type ToolRenderers, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Text, TuiMainScreen, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import { AggregateTerminal } from "./helpers/aggregate-terminal.ts";

// Independent expectations: docs/pi-extensions/tasks/d1-renderer-semantics.md.
// Only synthetic extensions, offline model responses and a local MCP transport.
const entry = fileURLToPath(new URL("../extensions/tool-display-intent.ts", import.meta.url));
const initialAgentDir = process.env.PI_CODING_AGENT_DIR;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(`Fixture did not reach ${label}`);
}
function text(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}
type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type Transport = ReturnType<McpTransportFactory>;
async function fixture(t: TestContext, options: {
  display?: boolean; codemode?: boolean; factories?: ExtensionFactory[];
  before?: string; after?: string;
} = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi11-d1-contract-"));
  const agentDir = join(cwd, "agent"); mkdirSync(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (initialAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = initialAgentDir;
    rmSync(cwd, { recursive: true, force: true });
  });
  const configDir = join(agentDir, "extension-data", "pi-tool-display-intent");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ version: 2,
    toolCalls: { layout: "individual" }, results: { mode: "preview" },
    tools: { custom: { probe: {renderer:"generic",mode:"preview"}, late_probe:{renderer:"generic",mode:"preview"},
      mcp__offline__probe:{renderer:"generic",mode:"preview"}, retired_probe:{renderer:"generic",mode:"preview"} } } }));
  const paths: string[] = [];
  if (options.before) { const path = join(cwd, "before.ts"); writeFileSync(path, options.before); paths.push(path); }
  if (options.display !== false) paths.push(entry);
  if (options.after) { const path = join(cwd, "after.ts"); writeFileSync(path, options.after); paths.push(path); }
  const settingsManager = SettingsManager.inMemory({ packages: [], compaction: {enabled:false}, retry: {enabled:false},
    ...(options.codemode ? {defaultTools:["+codemode"]} : {}) });
  const toolResults: ToolResultEvent[] = [];
  const observeResults: ExtensionFactory = pi => { pi.on("tool_result", event => { toolResults.push(event); }); };
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    additionalExtensionPaths: paths,
    extensionFactories: [...(options.codemode ? [createCodemodeExtension({mode:"on"})] : []), ...(options.factories ?? []), observeResults],
    noSkills:true, noThemes:true, noPromptTemplates:true, noContextFiles:true });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], "real loader must accept the product and fixtures");
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath:null,
    modelsStorePath:join(agentDir,"models-cache"), allowModelNetwork:false, refreshOnCreate:false });
  const faux = fauxProvider({ provider:"d1-offline", models:[{id:"context-model",contextWindow:128000,maxTokens:4096}] });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey("d1-offline", "local-test-only");
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, modelRuntime,
    resourceLoader:loader, sessionManager:SessionManager.inMemory(cwd), model:faux.getModel(), thinkingLevel:"off" });
  const errors: unknown[] = [];
  await session.bindExtensions({onError:error=>{errors.push(error);}});
  assert.deepEqual(errors, [], "session_start fixture must not fail");
  initTheme("dark", false);
  t.after(async () => { await session.abort(); session.dispose(); });
  const resolve = (name: string) => session.extensionRunner.resolveToolRenderers(name, () => session.getToolDefinition(name));
  const terminal = new AggregateTerminal(); terminal.columns = 120;
  const tui = new TuiMainScreen(terminal);
  function row(name: string, id: string, args: unknown) {
    return new ToolExecutionComponent(name, id, args, {showImages:false,outputPad:0}, resolve(name), tui, cwd);
  }
  return {cwd,agentDir,session,resolve,row,errors,loader,toolResults};
}
async function execute(session: AgentSession, name: string, args: JsonObject, id = "contract-call") {
  let first = true;
  const declared: ReturnType<typeof getCurrentTools>[] = [];
  const events: AgentSessionEvent[] = [];
  const unsubscribe = session.subscribe(event => events.push(event));
  session.agent.streamFunction = (model, context) => {
    declared.push(getCurrentTools(context.messages));
    const message = first ? fauxAssistantMessage(fauxToolCall(name, args, {id}), {stopReason:"toolUse"}) : fauxAssistantMessage("done");
    first = false;
    message.provider = model.provider; message.model = model.id; message.api = model.api;
    const stream = createAssistantMessageEventStream();
    stream.push({type:"start",partial:message});
    stream.push({type:"done",reason:message.stopReason as "toolUse" | "stop",message}); stream.end(message);
    return stream;
  };
  try { await session.prompt("Execute the offline contract call"); } finally { unsubscribe(); }
  const result = session.messages.findLast(message => message.role === "toolResult" && message.toolCallId === id) as ToolResultMessage | undefined;
  assert.ok(result, "the real SDK pipeline must persist a result");
  return {result,events,declared};
}
function render(row: ToolExecutionComponent) { return row.render(120).map(stripTerminalSequences); }

// Bash must still be the SDK tool, with semantic decoration rather than a lossy copy.
test("D1 real Bash registration preserves its programmatic output schema", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.session.getToolDefinition("bash")!.outputSchema, createBashToolDefinition(f.cwd).outputSchema,
    "programmatic Bash output schema was lost");
});

test("D1 codemode raw-JS declaration and non-Bash argument schemas remain native", async t => {
  const control = await fixture(t, {display:false,codemode:true});
  const f = await fixture(t, {codemode:true});
  const codemode = f.session.getToolDefinition("codemode")!;
  const original = control.session.getToolDefinition("codemode")!;
  assert.deepEqual(codemode.parameters, original.parameters);
  assert.deepEqual(codemode.constrainedSampling, original.constrainedSampling);
  const properties = (schema: object) => (schema as {properties:Record<string,unknown>}).properties;
  assert.equal("displaySummary" in properties(codemode.parameters), false);
  for (const name of ["read","write","edit"]) {
    assert.equal("displaySummary" in properties(f.session.getToolDefinition(name)!.parameters), false);
  }
});

for (const nested of [false, true]) {
  test(`D1 ${nested ? "codemode nested" : "direct"} Bash missing summary retains structured success and model context`, async t => {
    const control = await fixture(t, {display:false});
    const command = "printf '%s|%s|%s|%s' \"$PI_SESSION_ID\" \"$PI_PROVIDER\" \"$PI_MODEL\" \"$PI_REASONING_LEVEL\"";
    const native = await execute(control.session,"bash",{command});
    assert.equal(native.result.isError,false,text(native.result));
    assert.match(text(native.result),/d1-offline/); assert.match(text(native.result),/context-model/);
    const nativeStructured = control.toolResults.find(event=>event.toolName === "bash")?.structuredContent as JsonObject | undefined;
    assert.equal(nativeStructured?.exit_code,0,"native success fixture must expose structuredContent");
    assert.equal(nativeStructured.output,text(native.result));
    const f = await fixture(t, {codemode:nested});
    const expected = text(native.result).replace(control.session.sessionId, f.session.sessionId);
    const call = nested ? ["codemode", {code:`const value = await tools.bash(${JSON.stringify({command})}); text(JSON.stringify(value));`}] as const
      : ["bash", {command}] as const;
    const {result,events} = await execute(f.session, call[0], call[1]);
    assert.equal(result.isError, false, text(result));
    assert.ok(text(result).includes(expected), "fifth-argument session/model context must survive decoration");
    const end = events.find(event => event.type === "tool_execution_end" && event.toolName === "bash");
    assert.ok(end && end.type === "tool_execution_end", "Bash must actually execute");
    const structured = f.toolResults.find(event=>event.toolName === "bash")?.structuredContent as JsonObject | undefined;
    assert.ok(structured,"Bash must expose structured results to public tool_result observers");
    assert.deepEqual({output:structured.output,exit_code:structured.exit_code,truncated:structured.truncated},
      {output:expected,exit_code:0,truncated:false});
    if (nested) assert.equal(end.parentToolCallId, "contract-call");
    assert.deepEqual(f.errors, []);
  });
}

test("D1 direct nonzero Bash preserves native structured failure", async t => {
  const control = await fixture(t,{display:false});
  const original = await execute(control.session,"bash",{command:"printf failed; exit 7"});
  const f = await fixture(t);
  const actual = await execute(f.session,"bash",{command:"printf failed; exit 7"});
  assert.equal(actual.result.isError,original.result.isError);
  assert.equal(text(actual.result),text(original.result));
  const native = control.toolResults.find(event=>event.toolName === "bash")?.structuredContent as JsonObject | undefined;
  const wrapped = f.toolResults.find(event=>event.toolName === "bash")?.structuredContent as JsonObject | undefined;
  assert.equal(native?.exit_code,7,"native fixture must produce structured failure");
  assert.equal(wrapped?.exit_code,native.exit_code);
  assert.equal(wrapped?.output,native.output);
});

test("D1 nonzero Bash keeps its structured failure for scripts", async t => {
  const f = await fixture(t, {codemode:true});
  const {result,events} = await execute(f.session,"codemode",{code:'const result = await tools.bash({command:"printf failed; exit 7"}); text(JSON.stringify(result));'});
  assert.equal(result.isError, false, "a handled nonzero Bash status must not throw away its structured value");
  assert.match(text(result), /"exit_code":7/);
  const end = events.find(event=>event.type === "tool_execution_end" && event.toolName === "bash");
  assert.ok(end && end.type === "tool_execution_end");
  assert.equal(end.isError,true);
  const structured = f.toolResults.find(event=>event.toolName === "bash")?.structuredContent as JsonObject | undefined;
  assert.equal(structured?.output,"failed");
});

test("D1 Bash fallback does not make an invalid command valid or execute it", async t => {
  const f = await fixture(t);
  const {result,events} = await execute(f.session,"bash",{command:42});
  assert.equal(result.isError,true);
  assert.match(text(result), /command|validation|argument/i);
  assert.equal(events.some(event=>event.type === "tool_execution_end" && event.toolName === "bash" && !event.isError),false);
});

test("D1 cancellation still terminates a real Bash command without running its tail", async t => {
  const f = await fixture(t);
  const begun = join(f.cwd,"begun"), tail = join(f.cwd,"should-not-exist");
  const run = execute(f.session,"bash",{command:`printf start > '${begun}'; sleep 30; printf bad > '${tail}'`});
  try {
    await until(()=>existsSync(begun), "Bash process start");
    await f.session.abort();
    const {result} = await run;
    assert.equal(result.isError,true);
    assert.match(text(result), /abort|cancel/i);
    assert.equal(existsSync(tail),false);
  } finally { await f.session.abort(); await run; }
});

function probeFixture() {
  let api!: ExtensionAPI;
  const executions: Array<{args:unknown; model:string | undefined}> = [];
  const definition = defineTool({name:"probe",label:"Probe",description:"raw description",
    parameters:Type.Object({value:Type.String()}), outputSchema:Type.Object({value:Type.String(),model:Type.String()}),
    constrainedSampling:{type:"json_schema",strict:"require"}, exposure:"direct",
    prepareArguments(args) {
      if (typeof args !== "object" || !args || (args as {value?:unknown}).value === "reject") throw new Error("probe preparation rejected");
      return {value:String((args as {value?:unknown}).value ?? "prepared")};
    },
    prepareLoadout:()=>({descriptions:{probe:"PREPARED LOADOUT DESCRIPTION"}}),
    async execute(_id,args,_signal,_update,ctx) {
      executions.push({args,model:ctx.model?.id});
      return {content:[{type:"text",text:"probe text"}],details:{},structuredContent:{value:args.value,model:ctx.model!.id}};
    },
  });
  const factory: ExtensionFactory = pi => {api=pi;pi.registerTool(definition);};
  return {factory,definition,executions,get api(){return api;}};
}

test("D1 preserves custom prepare/loadout/schema/context through actual script execution", async t => {
  const probe = probeFixture();
  const f = await fixture(t,{codemode:true,factories:[probe.factory]});
  const {result,declared} = await execute(f.session,"codemode",{code:'text(await tools.probe({}));'});
  assert.equal(result.isError,false,text(result));
  assert.match(text(result), /"value":"prepared"/);
  assert.match(text(result), /"model":"context-model"/);
  assert.deepEqual(probe.executions,[{args:{value:"prepared"},model:"context-model"}]);
  const declaration = declared[0].find(tool=>tool.name === "probe")!;
  assert.equal(declaration.description,"PREPARED LOADOUT DESCRIPTION");
  assert.deepEqual(declaration.constrainedSampling,probe.definition.constrainedSampling);
  const rejection = await execute(f.session,"probe",{value:"reject"},"rejected-call");
  assert.equal(rejection.result.isError,true);
  assert.match(text(rejection.result), /probe preparation rejected/);
  assert.equal(probe.executions.length,1, "rejected preparation must never reach execute");
});

function rendererProbe(shell: "self" | "default") {
  const states = new Map<string, object>();
  const slots = new Map<string, Component>();
  const violations: string[] = [];
  const contexts: RenderContext[] = [];
  function draw(slot: "call" | "result", context: RenderContext) {
    const key = `${context.toolCallId}/${slot}`;
    if (states.has(context.toolCallId) && states.get(context.toolCallId) !== context.state) violations.push("state reset between slots");
    for (const [otherId,state] of states) {
      if (otherId !== context.toolCallId && state === context.state) violations.push("different rows share renderer state");
    }
    states.set(context.toolCallId,context.state);
    if (context.lastComponent !== slots.get(key)) violations.push(`${slot} received another slot or shell as lastComponent`);
    contexts.push({...context});
    const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("",0,0);
    component.setText(`${shell === "self" ? " ".repeat(context.outputPad) : ""}SPECIAL ${slot} ${(context.args as {value:string}).value}`);
    slots.set(key,component);
    return component;
  }
  const factory: ExtensionFactory = pi => pi.registerTool(defineTool({name:"probe",label:"Probe",description:"renderer probe",
    parameters:Type.Object({value:Type.String()}),renderShell:shell,
    execute:async()=>({content:[{type:"text",text:"unused"}],details:{}}),
    renderCall:(_args,_theme,ctx)=>draw("call",ctx), renderResult:(_result,_options,_theme,ctx)=>draw("result",ctx),
  }));
  return {factory,violations,contexts};
}

for (const shell of ["self","default"] as const) {
  test(`D1 delegates ${shell} renderer state/slots/context and pads exactly once`, async t => {
    const probe = rendererProbe(shell);
    const f = await fixture(t,{factories:[probe.factory]});
    const row = f.row("probe","renderer-call",{value:"original"});
    row.setArgsComplete(); row.markExecutionStarted();
    row.updateResult({content:[{type:"text",text:"partial"}],details:{},isError:false},true);
    row.updateArgs({value:"updated"});
    row.updateResult({content:[{type:"text",text:"finished"}],details:{},isError:false,durationMs:123},false);
    row.setExpanded(true); row.setShowImages(true); row.invalidate();
    const before = render(row);
    assert.ok(before.some(line=>line.includes("SPECIAL result updated")), "dedicated result content must remain visible");
    row.setOutputPad(3); row.invalidate();
    const after = render(row);
    const otherRow = f.row("probe","another-call",{value:"independent"});
    otherRow.updateResult({content:[{type:"text",text:"other result"}],isError:false}); otherRow.setExpanded(true);
    assert.ok(render(otherRow).some(line=>line.includes("SPECIAL result independent")));
    assert.deepEqual(probe.violations,[]);
    assert.ok(probe.contexts.some(ctx=>ctx.isPartial));
    const context = probe.contexts.findLast(ctx=>ctx.durationMs === 123 && ctx.outputPad === 3)!;
    assert.ok(context,"renderer must see final duration and padding");
    assert.equal(context.showImages,true); assert.equal(context.expanded,true);
    assert.equal(context.argsComplete,true); assert.equal(context.executionStarted,true);
    assert.equal(context.cwd,f.cwd); assert.deepEqual(context.args,{value:"updated"});
    const position = (lines:string[]) => lines.find(line=>line.includes("SPECIAL result updated"))!.indexOf("SPECIAL");
    assert.equal(position(after)-position(before),3,"padding must not be applied by both wrapper and SDK");
  });
}

const orderProbe = `import {Text} from '@earendil-works/pi-tui';
export default pi => pi.registerTool({name:'probe',label:'Probe',description:'ordered fixture',parameters:{type:'object',properties:{}},
execute:async()=>({content:[{type:'text',text:'not executed'}],details:{}}),
renderResult:()=>new Text('ORDERED SPECIAL CONTENT',0,0)});`;
for (const placement of ["before","after"] as const) {
  test(`D1 renderer resolver preserves a tool loaded ${placement} the display extension`, async t => {
    const f = await fixture(t,{[placement]:orderProbe});
    const row = f.row("probe","ordered",{});
    row.updateResult({content:[{type:"text",text:"plain fallback"}],isError:false}); row.setExpanded(true);
    assert.ok(render(row).some(line=>line.includes("ORDERED SPECIAL CONTENT")));
    assert.deepEqual(f.session.getActiveToolNames().filter(name=>name === "probe"),["probe"]);
  });
}

test("D1 late registration and reload preserve execution ownership without enabling codemode", async t => {
  const probe = probeFixture();
  const f = await fixture(t,{factories:[probe.factory]});
  probe.api.registerTool(defineTool({name:"late_probe",label:"Late",description:"late registered",
    parameters:Type.Object({}),exposure:"hidden",execute:async()=>{throw new Error("history must not execute");},
    renderResult:()=>new Text("LATE SPECIAL CONTENT",0,0)}));
  const before = f.session.getActiveToolNames();
  const row = f.row("late_probe","late",{});
  row.updateResult({content:[{type:"text",text:"saved"}],isError:false}); row.setExpanded(true);
  assert.ok(render(row).some(line=>line.includes("LATE SPECIAL CONTENT")));
  assert.equal(before.includes("late_probe"),false);
  await f.session.reload();
  assert.deepEqual(f.errors,[]);
  assert.equal(f.session.getActiveToolNames().includes("codemode"),false);
  assert.equal(probe.executions.length,0);
});

test("D1 old session reload and disposal cannot revoke a newer session's renderer owner", async t => {
  const old = await fixture(t);
  const newer = await fixture(t,{factories:[pi=>{
    pi.registerToolRenderer((name,next)=> name === "owner_probe" ? {
      renderShell:"self", renderResult:()=>new Text("NEW OWNER CONTENT",0,0),
    } : next());
  }]});
  const active = newer.session.getActiveToolNames();
  const paint = () => {
    const row = newer.row("owner_probe","owner-call",{});
    row.updateResult({content:[{type:"text",text:"stored"}],isError:false}); row.setExpanded(true);
    return render(row).join("\n");
  };
  assert.match(paint(),/NEW OWNER CONTENT/);
  await old.session.reload(); old.session.dispose();
  assert.match(paint(),/NEW OWNER CONTENT/);
  await newer.session.reload();
  assert.match(paint(),/NEW OWNER CONTENT/);
  assert.deepEqual(newer.session.getActiveToolNames(),active);
  assert.deepEqual([...old.errors,...newer.errors],[]);
});

test("D1 historical-only tools resolve visibly without execution or runtime activation", async t => {
  const f = await fixture(t);
  const active = f.session.getActiveToolNames();
  for (const name of ["retired_probe","codemode"]) {
    assert.equal(f.session.getToolDefinition(name),undefined);
    assert.ok(f.resolve(name),"display resolver must cover an unregistered historical tool");
    const row = f.row(name,`history-${name}`,{code:'throw new Error("must not run")',value:"saved args"});
    row.updateResult({content:[{type:"text",text:"SAVED HISTORICAL OUTPUT"}],isError:false}); row.setExpanded(true);
    assert.ok(render(row).some(line=>line.includes("SAVED HISTORICAL OUTPUT")));
  }
  assert.deepEqual(f.session.getActiveToolNames(),active);
  assert.equal(f.session.messages.length,0);
});

function offlineMcp() {
  const listed = gate(), release = gate();
  const messages = new Set<Parameters<Transport["onMessage"]>[0]>();
  const closes = new Set<Parameters<Transport["onClose"]>[0]>();
  const errors = new Set<Parameters<Transport["onError"]>[0]>();
  let calls = 0;
  const transport: Transport = {
    async start() {},
    async send(message) {
      if (!("id" in message) || !("method" in message)) return;
      let result: object;
      if (message.method === "initialize") result = {protocolVersion:"2025-11-25",capabilities:{tools:{}},serverInfo:{name:"offline",version:"1"}};
      else if (message.method === "tools/list") {
        listed.resolve(); await release.promise;
        result = {tools:[{name:"probe",description:"offline MCP probe",inputSchema:{type:"object",properties:{}}}]};
      } else if (message.method === "tools/call") {calls++;result={content:[{type:"text",text:"OFFLINE MCP RESULT"}]};}
      else throw new Error(`Unexpected offline MCP method ${message.method}`);
      for (const listener of messages) listener({jsonrpc:"2.0",id:message.id,result});
    },
    async close() {for (const listener of closes) listener();},
    onMessage(listener) {messages.add(listener);return()=>messages.delete(listener);},
    onError(listener) {errors.add(listener);return()=>errors.delete(listener);},
    onClose(listener) {closes.add(listener);return()=>closes.delete(listener);},
  };
  const factory = createMcpExtension({loadConfig:()=>({servers:[{name:"offline",source:"synthetic",config:{command:"not-executed",exposure:"direct"}}],errors:[],autoEnableCodemode:false}),
    createTransport:()=>transport});
  return {factory,listed,release,get calls(){return calls;}};
}

test("D1 native MCP tools resolve before and after delayed tools/list without replaying history", async t => {
  const mcp = offlineMcp();
  t.after(()=>mcp.release.resolve());
  const f = await fixture(t,{factories:[mcp.factory]});
  await mcp.listed.promise;
  assert.equal(f.session.getToolDefinition("mcp__offline__probe"),undefined);
  const historicalRenderer = f.resolve("mcp__offline__probe");
  mcp.release.resolve();
  await until(()=>!!f.session.getToolDefinition("mcp__offline__probe"),"native MCP tool registration");
  const {result} = await execute(f.session,"mcp__offline__probe",{});
  assert.equal(result.isError,false,text(result)); assert.equal(mcp.calls,1);
  const row = f.row("mcp__offline__probe","saved-mcp",{});
  row.updateResult({content:result.content,isError:false}); row.setExpanded(true);
  assert.ok(render(row).some(line=>line.includes("OFFLINE MCP RESULT")));
  assert.equal(mcp.calls,1,"history must not call MCP again");
  assert.ok(historicalRenderer,"unconnected historical MCP tool needs a renderer before registration");
  assert.equal(f.session.getActiveToolNames().includes("codemode"),false);
});

test("D1 Write expanded diff remains A to B after the file becomes C", async t => {
  const f = await fixture(t);
  const path = join(f.cwd,"tracked.txt"); writeFileSync(path,"OLD_ALPHA\n");
  const row = f.row("write","write-call",{path,content:"NEW_BRAVO\n"});
  row.setArgsComplete(); row.markExecutionStarted();
  const {result} = await execute(f.session,"write",{path,content:"NEW_BRAVO\n"},"write-call");
  assert.equal(result.isError,false,text(result)); assert.equal(readFileSync(path,"utf8"),"NEW_BRAVO\n");
  writeFileSync(path,"LATER_CHARLIE\n");
  row.updateResult({content:result.content,details:result.details,isError:false}); row.setExpanded(true); row.invalidate();
  const output = render(row).join("\n");
  assert.match(output,/OLD_ALPHA/); assert.match(output,/NEW_BRAVO/);
  // Diff polarity is color-coded, not a literal +/- text contract.
  assert.ok(output.indexOf("OLD_ALPHA") < output.indexOf("NEW_BRAVO"));
  assert.doesNotMatch(output,/LATER_CHARLIE/);
});

test("D1 new Write history never invents old body from the later current file", async t => {
  const f = await fixture(t); const path = join(f.cwd,"new.txt");
  const row = f.row("write","new-write",{path,content:"CREATED_BODY\n"});
  row.setArgsComplete(); row.markExecutionStarted();
  const {result} = await execute(f.session,"write",{path,content:"CREATED_BODY\n"},"new-write");
  assert.equal(result.isError,false,text(result));
  writeFileSync(path,"UNRELATED_LATER_BODY\n");
  row.updateResult({content:result.content,details:result.details,isError:false}); row.setExpanded(true);
  const output = render(row).join("\n");
  assert.match(output,/CREATED_BODY/); assert.doesNotMatch(output,/UNRELATED_LATER_BODY/);
});
