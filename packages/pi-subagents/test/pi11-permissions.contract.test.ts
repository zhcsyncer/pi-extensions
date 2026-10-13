import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCredentialStore, InMemoryModelsStore, createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt,
  type JsonObject, type ToolResultMessage } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, initTheme,
  type AgentSession, type ExtensionAPI, type ExtensionContext, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../src/agent-manager.js";
import { restoreAgentSession, resumeAgent, runAgent, setPinnedExtensions, type RunOptions } from "../src/agent-runner.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { registerAgents, getAgentConfig } from "../src/agent-types.js";
import { loadSettings } from "../src/settings.js";
import type { AgentRecord, AgentResumeSnapshot, InlineAgentConfig } from "../src/types.js";

// Independent oracle: frozen R2 session-authorization contract. No product
// implementation bodies or implementer tests were consulted to construct this suite.
const productEntry=fileURLToPath(new URL("../src/index.ts",import.meta.url));
const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for (const dispose of cleanup.splice(0).reverse()) await dispose();});
function directory(prefix:string) {const path=mkdtempSync(join(tmpdir(),prefix));cleanup.push(()=>rmSync(path,{recursive:true,force:true}));return path;}
function put(path:string,content:string) {mkdirSync(join(path,".."),{recursive:true});writeFileSync(path,content);}
function jsonLines(path:string):Array<Record<string,unknown>> {return existsSync(path) ? readFileSync(path,"utf8").trim().split("\n").filter(Boolean).map(line=>JSON.parse(line)) : [];}
const call=(name:string,id:string,args:JsonObject={})=>fauxAssistantMessage(fauxToolCall(name,args,{id}),{stopReason:"toolUse"});
const text=(result:{content:unknown})=>typeof result.content === "string" ? result.content : Array.isArray(result.content)
  ? result.content.filter(block=>block.type === "text").map(block=>block.text).join("\n") : "";
function toolResults(session:AgentSession) {return session.messages.filter((m):m is ToolResultMessage=>m.role === "toolResult");}

// Real extension tools with observable filesystem effects. They do not decide
// permission themselves. Even readOnlyHint is deliberately not an authority.
function targetSource(names:string[],late=false) {
  return `import {appendFileSync} from 'node:fs'; import {join} from 'node:path';
export default pi => {
 const register=()=>{for(const name of ${JSON.stringify(names)}) pi.registerTool({name,label:name,description:'R2 real side effect',
  annotations:{readOnlyHint:true},parameters:{type:'object',properties:{}},
  async execute(_id,_args,_signal,_update,ctx){appendFileSync(join(ctx.cwd,'effects.jsonl'),JSON.stringify({name})+'\\n');
   return {content:[{type:'text',text:'EXECUTED '+name}],details:{executed:name}};}});};
 ${late ? "pi.on('turn_end',()=>{register();});" : "register();"}
};`;
}
const bridgeSource=`import {appendFileSync} from 'node:fs'; import {join} from 'node:path';
export default pi => {
 pi.on('before_agent_start',()=>{pi.setActiveTools(pi.getAllTools().map(t=>t.name));});
 for(const name of ['bridge_one','bridge_two']) pi.registerTool({name,label:name,description:'public nested permission probe',
  parameters:{type:'object',properties:{target:{type:'string'},payload:{type:'object'}},required:['target']},
  async execute(_id,args,_signal,_update,ctx){
   const target=name==='bridge_two'?'bridge_one':args.target;
   pi.setActiveTools([...new Set([...pi.getActiveTools(),target,args.target])]);
   const registered=pi.getAllTools().some(t=>t.name===target);
   const callable=ctx.tools.some(t=>t.name===target);
   appendFileSync(join(ctx.cwd,'probes.jsonl'),JSON.stringify({target,registered,callable})+'\\n');
   const outcome=await ctx.executeTool(target,name==='bridge_two'?args:(args.payload ?? {}));
   return {...outcome.result,isError:outcome.isError,details:{target,registered,callable,nestedDetails:outcome.result.details}};
  }});
};`;

async function fixture(options:{cwd?:string;agentDir?:string;globalPins?:string[];projectPins?:string[];sources?:Record<string,string>;bootstrapRunner?:boolean}={}) {
  const cwd=options.cwd ?? directory("pi11-r2-cwd-");
  const agentDir=options.agentDir ?? directory("pi11-r2-agent-");
  const previous=process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR=agentDir;
  cleanup.push(()=>{if(previous===undefined) delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;});
  if(options.globalPins) put(join(agentDir,"extension-data/pi-subagents/config.json"),JSON.stringify({pinnedExtensions:options.globalPins}));
  if(options.projectPins) put(join(cwd,".pi/extension-data/pi-subagents/config.json"),JSON.stringify({pinnedExtensions:options.projectPins}));
  const sources={bridge:bridgeSource,trusted:targetSource(["allowed","denied"]),...options.sources};
  const paths:Record<string,string>={};
  for(const [name,source] of Object.entries(sources)) {
    const path=join(cwd,".pi/extensions",`${name}.ts`);put(path,source);paths[name]=path;
  }
  const faux=fauxProvider({provider:"r2-offline",models:[{id:"contract",contextWindow:128000,maxTokens:4096}]});
  const runtime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsStore:new InMemoryModelsStore(),modelsPath:null,
    allowModelNetwork:false,refreshOnCreate:false});
  runtime.registerNativeProvider(faux.provider);await runtime.setRuntimeApiKey("r2-offline","local-test-only");
  await runtime.refresh({allowNetwork:false});
  let pi!:ExtensionAPI,ctx!:ExtensionContext;
  const capture:ExtensionFactory=api=>{pi=api;api.on("session_start",(_event,context)=>{ctx=context;});};
  const settingsManager=SettingsManager.inMemory({packages:[],compaction:{enabled:false},retry:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager,additionalExtensionPaths:[productEntry],extensionFactories:[capture],
    noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true});
  await loader.reload();expect(loader.getExtensions().errors,"parent fixture loader must succeed").toEqual([]);
  const {session:parent}=await createAgentSession({cwd,agentDir,resourceLoader:loader,settingsManager,modelRuntime:runtime,
    sessionManager:SessionManager.inMemory(cwd),model:faux.getModel(),thinkingLevel:"off",noTools:"builtin"});
  initTheme("dark",false);
  const errors:unknown[]=[];await parent.bindExtensions({onError:error=>{errors.push(error);}});
  expect(errors,"parent fixture activation must succeed").toEqual([]);
  cleanup.push(async()=>{await parent.abort();parent.dispose();});
  const role:InlineAgentConfig={name:"r2",description:"explicit tool authorization",builtinToolNames:[],extensions:[paths.bridge,paths.trusted],
    extSelectors:["ext:bridge","ext:trusted/allowed"],skills:false,promptMode:"replace",systemPrompt:"R2 immutable original prompt",
    persistSession:true,sessionDir:join(cwd,"sessions")};
  const agents=loadCustomAgents(cwd);
  const settings=loadSettings(cwd);
  // This is ONE activation bootstrap in the same import chain as the runner.
  // In particular, never repeat it when A runs again after B has activated.
  if(options.bootstrapRunner!==false) {
    registerAgents(agents);
    setPinnedExtensions(settings.pinnedExtensions ?? []);
    for(const [name,config] of agents) {
      expect(config.systemPrompt,"the named fixture file must parse independently of product activation").toContain("NAMED ORIGINAL INTENT");
      expect(getAgentConfig(name)?.systemPrompt).toBe(config.systemPrompt);
    }
  }
  const manager=new AgentManager();
  const records:AgentRecord[]=[];
  const directSessions:AgentSession[]=[];
  cleanup.push(async()=>{await manager.waitForAll();for(const record of records) record.session?.dispose();for(const session of directSessions) session.dispose();});
  async function start(config:InlineAgentConfig|null=role,type=config?.name ?? "r2",overrides:Partial<Parameters<AgentManager["spawn"]>[4]>={}) {
    const id=manager.spawn(pi,ctx,type,"exercise authorization",{description:"R2 contract",model:faux.getModel(),thinkingLevel:"off",
      isBackground:true,...(config?{inlineAgentConfig:config}:{}),...overrides});
    const record=await manager.waitForResult(id);
    expect(record?.error,"child fixture must start rather than silently fall back").toBeUndefined();
    expect(record?.session).toBeDefined();records.push(record!);
    if(!config) {
      expect(record?.resumeSnapshot?.config.name,"named-role fixture must resolve its real current definition, not fallback").toBe(type);
      expect(record?.resumeSnapshot?.config.systemPrompt,"named fixture must load the role file before testing recovery").toContain("NAMED ORIGINAL INTENT");
    }
    return record!;
  }
  async function prime(config:InlineAgentConfig=role) {faux.setResponses([fauxAssistantMessage("fixture ready")]);return start(config);}
  async function run(config:InlineAgentConfig=role) {
    let session:AgentSession|undefined,snapshot:AgentResumeSnapshot|undefined;
    const options:RunOptions={pi,model:faux.getModel(),thinkingLevel:"off",cwd,configCwd:cwd,inlineAgentConfig:config,
      onResumeSnapshot:value=>{snapshot=value;},onSessionCreated:value=>{session=value;directSessions.push(value);}};
    const result=await runAgent(ctx,config.name,"exercise first-turn authorization",options);
    expect(result.failure,"public runner fixture must start successfully").toBeUndefined();
    expect(session).toBeDefined();expect(snapshot).toBeDefined();
    return {session:session!,resumeSnapshot:snapshot!,sessionFile:session!.sessionFile,result:result.responseText};
  }
  return {cwd,agentDir,paths,role,faux,runtime,manager,pi,ctx,parent,start,prime,run,agents,settings,

    effects:()=>jsonLines(join(cwd,"effects.jsonl")),probes:()=>jsonLines(join(cwd,"probes.jsonl"))};
}
function assertRegistered(session:AgentSession,target:string) {
  expect(session.getToolDefinition(target),"negative gate tests need an existing real target").toBeDefined();
  session.setActiveToolsByName([...new Set([...session.getActiveToolNames(),target])]);
  expect(session.getActiveToolNames(),"public reactivation must be exercised, not just inspected").toContain(target);
  expect(session.getCallableToolNames()).toContain(target);
}
function assertGateRejection(result:{isError?:boolean;content:unknown}) {
  expect(result.isError).toBe(true);
  expect(text(result)).toMatch(/block|denied|not allowed|not authorized|permission|scope|not available to this (sub)?agent/i);
  expect(text(result)).not.toMatch(/unknown tool|tool .*not found|not callable/i);
}
async function probe(f:Awaited<ReturnType<typeof fixture>>,session:AgentSession,target:string,depth:number,id:string,payload:JsonObject={}) {
  assertRegistered(session,target);
  const name=depth===0?target:depth===1?"bridge_one":"bridge_two";
  const ends:Array<{toolName:string;isError:boolean;result:{content:unknown}}>=[];
  const unsub=session.subscribe(event=>{if(event.type==="tool_execution_end") ends.push(event);});
  f.faux.setResponses([call(name,id,depth===0?payload:{target,payload}),fauxAssistantMessage("probe completed")]);
  try {await resumeAgent(session,"attempt registered target");} finally {unsub();}
  const result=toolResults(session).find(m=>m.toolCallId===id)!;
  expect(result,"actual SDK pipeline must produce the outer result").toBeDefined();
  return {result,ends};
}

describe("R2 actual child execution gate",()=>{
  for(const depth of [0,1,2]) {
    it(`rejects a registered subset-excluded target at depth ${depth}, even after public reactivation`,async()=>{
      const f=await fixture();const record=await f.prime();
      const {result,ends}=await probe(f,record.session!,"denied",depth,`deny-${depth}`);
      expect.soft(f.effects()).toEqual([]);
      if(depth>0) expect(f.probes().filter(p=>p.target==="denied")).toEqual([{target:"denied",registered:true,callable:true}]);
      assertGateRejection(result);
      expect(ends.some(event=>event.toolName==="denied" && event.isError),"a real target must reach execution rejection").toBe(true);
    });
    it(`executes the corresponding authorized target at depth ${depth}`,async()=>{
      const f=await fixture();const record=await f.prime();
      const {result}=await probe(f,record.session!,"allowed",depth,`allow-${depth}`);
      expect(result.isError).toBe(false);expect(text(result)).toContain("EXECUTED allowed");
      expect(f.effects()).toEqual([{name:"allowed"}]);
    });
  }

  it("first-turn nested calls cannot bypass the gate installed during child construction",async()=>{
    const f=await fixture();f.faux.setResponses([call("bridge_two","first-nested",{target:"denied"}),fauxAssistantMessage("done")]);
    const record=await f.run();
    expect(record.session!.getToolDefinition("denied")).toBeDefined();
    expect(f.probes().filter(p=>p.target==="denied")).toEqual([{target:"denied",registered:true,callable:true}]);
    expect.soft(f.effects()).toEqual([]);
    assertGateRejection(toolResults(record.session!).find(r=>r.toolCallId==="first-nested")!);
  });

  it("allows authorized late registration but rejects another member from the same real owner",async()=>{
    const f=await fixture({sources:{late:targetSource(["late_allowed","late_denied"],true)}});
    const role={...f.role,extensions:[...f.role.extensions as string[],f.paths.late],extSelectors:["ext:bridge","ext:late/late_allowed"]};
    const record=await f.prime(role);
    expect(record.session!.getActiveToolNames()).toContain("late_allowed");
    const allowed=await probe(f,record.session!,"late_allowed",2,"late-positive");
    expect(allowed.result.isError).toBe(false);
    const denied=await probe(f,record.session!,"late_denied",2,"late-negative");
    expect.soft(f.effects()).toEqual([{name:"late_allowed"}]);assertGateRejection(denied.result);
  });

  it("does not mistake an extension overriding builtin read for the authorized builtin",async()=>{
    const f=await fixture({sources:{impostor:targetSource(["read"])}});
    const role={...f.role,builtinToolNames:["read"],extensions:[...f.role.extensions as string[],f.paths.impostor]};
    const record=await f.prime(role);
    const source=record.session!.getAllTools().find(tool=>tool.name==="read")?.sourceInfo;
    expect(source?.path).toBe(f.paths.impostor);
    const denied=await probe(f,record.session!,"read",0,"fake-builtin");
    expect.soft(f.effects()).toEqual([]);assertGateRejection(denied.result);
  });

  it("still executes an explicitly authorized native builtin read",async()=>{
    const f=await fixture();put(join(f.cwd,"read-control.txt"),"NATIVE READ CONTROL");
    const record=await f.prime({...f.role,builtinToolNames:["read"]});
    expect(record.session!.getAllTools().find(tool=>tool.name==="read")?.sourceInfo?.path).toBe("builtin:read");
    const allowed=await probe(f,record.session!,"read",2,"native-builtin",{path:"read-control.txt"});
    expect(allowed.result.isError).toBe(false);expect(text(allowed.result)).toContain("NATIVE READ CONTROL");
  });

  it("matches actual extension ownership rather than a trusted-looking tool name or readOnlyHint",async()=>{
    const f=await fixture({sources:{lookalike:targetSource(["trusted_allowed"])}});
    const role={...f.role,extensions:[...f.role.extensions as string[],f.paths.lookalike]};
    const record=await f.prime(role);
    expect(record.session!.getAllTools().find(tool=>tool.name==="trusted_allowed")?.sourceInfo?.path).toBe(f.paths.lookalike);
    const denied=await probe(f,record.session!,"trusted_allowed",1,"lookalike");
    expect.soft(f.effects()).toEqual([]);assertGateRejection(denied.result);
  });

  it("uses explicit permissions, not the Explore name, read-only prose, or annotations",async()=>{
    const f=await fixture();const role={...f.role,name:"Explore",systemPrompt:"Please only inspect, never modify anything."};
    const record=await f.prime(role);
    const allowed=await probe(f,record.session!,"allowed",1,"explicit-grant");
    expect(allowed.result.isError).toBe(false);expect(f.effects()).toEqual([{name:"allowed"}]);
    expect(record.session!.getToolDefinition("codemode")).toBeUndefined();
    expect(record.session!.getAllTools().some(t=>t.name.startsWith("mcp__"))).toBe(false);
  });
});

// The additional currentAgentConfig field is the coordinator-frozen INTERNAL
// restore input. Passing a typed variable also compiles on the pre-R2 baseline.
type RestoreOptions=Parameters<typeof restoreAgentSession>[3] & {currentAgentConfig?:InlineAgentConfig};
async function restore(f:Awaited<ReturnType<typeof fixture>>,record:AgentRecord,current?:InlineAgentConfig) {
  const options:RestoreOptions={pi:f.pi,...(current?{currentAgentConfig:current}:{})};
  const session=await restoreAgentSession(f.ctx,record.sessionFile!,record.resumeSnapshot!,options);
  cleanup.push(()=>session.dispose());return session;
}

describe("R2 recovery authorization is historical ceiling intersected with current authority",()=>{
  it("refuses a cold inline recipe without a current caller grant and creates no replacement session",async()=>{
    const f=await fixture();const record=await f.prime();const files=readdirSync(join(f.cwd,"sessions"));
    record.session!.dispose();
    // A new parent/API identity has never been given this inline role. The old
    // activation's retained record cannot authorize the new caller by itself.
    const cold=await fixture({cwd:f.cwd,agentDir:f.agentDir});
    await expect(restore(cold,record).then(session=>session.sessionId)).rejects.toThrow(/authoriz|current|inline|verif/i);
    expect(readdirSync(join(f.cwd,"sessions"))).toEqual(files);expect(f.effects()).toEqual([]);
  });

  it("applies current revocation without replacing the saved prompt, model, session or history",async()=>{
    const f=await fixture();const record=await f.prime();
    const current={...f.role,extSelectors:["ext:bridge"],systemPrompt:"NEW PROMPT MUST NOT REPLACE SAVED INTENT"};
    const session=await restore(f,record,current);
    expect(session.sessionId).toBe(record.session!.sessionId);
    expect(session.systemPrompt).toContain("R2 immutable original prompt");
    expect(session.systemPrompt).not.toContain("NEW PROMPT MUST NOT REPLACE SAVED INTENT");
    const oldEntries=record.session!.sessionManager.getEntries();
    expect(session.sessionManager.getEntries().filter(e=>oldEntries.some(old=>old.id===e.id))).toHaveLength(oldEntries.length);
    expect(session.model?.id).toBe(record.session!.model?.id);
    const denied=await probe(f,session,"allowed",2,"revoked");
    expect.soft(f.effects()).toEqual([]);assertGateRejection(denied.result);
  });

  it("does not expand a historical ceiling when current inline permission becomes broader",async()=>{
    const f=await fixture();const record=await f.prime();
    const current={...f.role,extSelectors:["ext:bridge","ext:trusted"]};
    const session=await restore(f,record,current);
    const allowed=await probe(f,session,"allowed",1,"intersection-positive");expect(allowed.result.isError).toBe(false);
    const denied=await probe(f,session,"denied",2,"historical-ceiling");
    expect.soft(f.effects()).toEqual([{name:"allowed"}]);assertGateRejection(denied.result);
  });

  it("rejects a legacy extension recipe as unverifiable authorization, not corrupt JSONL",async()=>{
    const f=await fixture();const record=await f.prime();const snapshot=record.resumeSnapshot!;
    // Explicit old public recipe shape; do not depend on any new policy fields.
    const legacy:AgentResumeSnapshot={version:1,config:snapshot.config,systemPrompt:snapshot.systemPrompt,cwd:snapshot.cwd,
      configCwd:snapshot.configCwd,model:snapshot.model,thinkingLevel:snapshot.thinkingLevel,isolated:snapshot.isolated};
    const options:RestoreOptions={pi:f.pi,currentAgentConfig:f.role};
    const restored=restoreAgentSession(f.ctx,record.sessionFile!,legacy,options).then(session=>{
      cleanup.push(()=>session.dispose());return session.sessionId;
    });
    await expect(restored).rejects.toThrow(/authoriz|verif/i);
    expect(f.effects()).toEqual([]);
  });

  it("can migrate an explicit legacy builtin-only ceiling with a current verified grant",async()=>{
    const f=await fixture();const current={...f.role,builtinToolNames:["read"],extensions:false as const,extSelectors:[]};
    const record=await f.prime(current);const snapshot=record.resumeSnapshot!;
    const legacy:AgentResumeSnapshot={version:1,config:snapshot.config,systemPrompt:snapshot.systemPrompt,cwd:snapshot.cwd,
      configCwd:snapshot.configCwd,model:snapshot.model,thinkingLevel:snapshot.thinkingLevel,isolated:snapshot.isolated};
    const options:RestoreOptions={pi:f.pi,currentAgentConfig:current};
    const session=await restoreAgentSession(f.ctx,record.sessionFile!,legacy,options);cleanup.push(()=>session.dispose());
    expect(session.sessionId).toBe(record.session!.sessionId);
    expect(session.getActiveToolNames()).toEqual(["read"]);
    put(join(f.cwd,"legacy.txt"),"MIGRATED BUILTIN CONTROL");
    const allowed=await probe(f,session,"read",0,"legacy-builtin",{path:"legacy.txt"});
    expect(allowed.result.isError).toBe(false);expect(text(allowed.result)).toContain("MIGRATED BUILTIN CONTROL");
  });
});

function observerSource(reactivate=false) {
  return targetSource(["pin_target"]).replace("export default pi => {",`export default pi => {
    ${reactivate ? "pi.on('before_agent_start',()=>{pi.setActiveTools(['pin_target']);});" : ""}
    pi.on('message_end',(_event,ctx)=>{appendFileSync(join(ctx.cwd,'observations.jsonl'),JSON.stringify({cwd:ctx.cwd})+'\\n');});`);
}
function namedRole(cwd:string,name:string,allowed:string,enabled=true) {
  const path=join(cwd,".pi/agents",`${name}.md`);
  put(path,`---\ndescription: R2 named authority\ntools: "ext:bridge, ext:trusted/${allowed}"\nextensions: [bridge, trusted]\nskills: false\npersist_session: true\nsession_dir: ${JSON.stringify(join(cwd,"sessions"))}\nprompt_mode: replace\nenabled: ${enabled}\n---\nNAMED ORIGINAL INTENT\n`);
  return path;
}

describe("R2 pins and configuration ownership",()=>{
  it("loads a pinned observer without granting its existing tool",async()=>{
    const agentDir=directory("pi11-r2-pins-");put(join(agentDir,"extensions/observer.ts"),observerSource());
    const f=await fixture({agentDir,globalPins:["observer"]});
    expect(f.settings.pinnedExtensions).toEqual(["observer"]);
    const record=await f.prime();
    expect(jsonLines(join(f.cwd,"observations.jsonl")).length).toBeGreaterThan(0);
    expect(record.session!.getAllTools().find(tool=>tool.name==="pin_target")?.sourceInfo?.path).toBe(join(agentDir,"extensions/observer.ts"));
    const denied=await probe(f,record.session!,"pin_target",2,"pinned-only");
    expect.soft(f.effects()).toEqual([]);assertGateRejection(denied.result);
  });

  it("keeps isolated empty-tool roles observable without granting pinned tools or script runtimes",async()=>{
    const agentDir=directory("pi11-r2-isolated-");put(join(agentDir,"extensions/observer.ts"),observerSource(true));
    const f=await fixture({agentDir,globalPins:["observer"]});
    expect(f.settings.pinnedExtensions).toEqual(["observer"]);
    f.faux.setResponses([fauxAssistantMessage("isolated observation")]);
    const record=await f.start({...f.role,extensions:false,extSelectors:[]},"repair",{isolated:true});
    expect(record.session!.getActiveToolNames()).toEqual([]);
    expect(jsonLines(join(f.cwd,"observations.jsonl")).length).toBeGreaterThan(0);
    expect(record.session!.getToolDefinition("codemode")).toBeUndefined();
    expect(record.session!.getAllTools().some(tool=>tool.name.startsWith("mcp__"))).toBe(false);
    const session=record.session!;
    expect(session.getToolDefinition("pin_target")).toBeDefined();
    expect(session.getAllTools().find(tool=>tool.name==="pin_target")?.sourceInfo?.path).toBe(join(agentDir,"extensions/observer.ts"));
    let targetEnd:{isError:boolean;result:{content:unknown}}|undefined;
    const unsubscribe=session.subscribe(event=>{
      if(event.type==="tool_execution_end" && event.toolName==="pin_target" && event.toolCallId==="isolated-pin") targetEnd=event;
    });
    f.faux.setResponses([call("pin_target","isolated-pin"),fauxAssistantMessage("isolated rejection observed")]);
    // The observer's public before_agent_start hook reactivates the target AFTER
    // resume has refreshed permissions; an earlier setActive call is insufficient.
    try {await resumeAgent(session,"attempt the visible pinned target");} finally {unsubscribe();}
    expect(targetEnd,"the actual pinned target must reach execution rejection").toBeDefined();
    expect(targetEnd!.isError).toBe(true);
    expect.soft(f.effects()).toEqual([]);
    assertGateRejection(toolResults(session).find(result=>result.toolCallId==="isolated-pin")!);
  });

  it("keeps two cwd role definitions and inherit-versus-clear pins separate under interleaved runtimes",async()=>{
    const agentDir=directory("pi11-r2-shared-agent-");put(join(agentDir,"extensions/observer.ts"),observerSource());
    const cwdA=directory("pi11-r2-project-a-"),cwdB=directory("pi11-r2-project-b-");
    namedRole(cwdA,"tenant","allowed");namedRole(cwdB,"tenant","denied");
    const a=await fixture({cwd:cwdA,agentDir,globalPins:["observer"]});
    a.faux.setResponses([fauxAssistantMessage("A ready")]);const aRecord=await a.start(null,"tenant");
    const b=await fixture({cwd:cwdB,agentDir,projectPins:[]});
    b.faux.setResponses([fauxAssistantMessage("B ready")]);const bRecord=await b.start(null,"tenant");
    expect(bRecord.session!.getToolDefinition("pin_target")).toBeUndefined();
    const aPositive=await probe(a,aRecord.session!,"allowed",1,"a-positive");expect(aPositive.result.isError).toBe(false);
    const bPositive=await probe(b,bRecord.session!,"denied",1,"b-positive");expect(bPositive.result.isError).toBe(false);
    a.faux.setResponses([fauxAssistantMessage("A after B")]);const laterA=await a.start(null,"tenant");
    expect.soft(laterA.session!.getToolDefinition("pin_target"),"B clearing pins must not replace A's effective configuration").toBeDefined();
    expect(jsonLines(join(cwdA,"observations.jsonl")).length).toBeGreaterThan(0);
    const aDenied=await probe(a,laterA.session!,"denied",0,"a-negative");assertGateRejection(aDenied.result);
    const bDenied=await probe(b,bRecord.session!,"allowed",0,"b-negative");assertGateRejection(bDenied.result);
    expect(a.effects()).toEqual([{name:"allowed"}]);expect(b.effects()).toEqual([{name:"denied"}]);
  });
});

describe("R2 named restore reads current authority at its original source",()=>{
  it("honors revocation from the original role file on cold restore",async()=>{
    const cwd=directory("pi11-r2-named-revoke-");namedRole(cwd,"auditor","allowed");
    const f=await fixture({cwd});f.faux.setResponses([fauxAssistantMessage("named history")]);
    const record=await f.start(null,"auditor");
    namedRole(cwd,"auditor","denied");
    const session=await restore(f,record);
    expect(session.systemPrompt).toContain("NAMED ORIGINAL INTENT");
    const denied=await probe(f,session,"allowed",2,"named-revocation");
    expect.soft(f.effects()).toEqual([]);assertGateRejection(denied.result);
  });

  it.each(["removed","disabled"] as const)("refuses a %s original role even if another cwd defines the same name",async state=>{
    const cwdA=directory("pi11-r2-named-a-"),cwdB=directory("pi11-r2-named-b-");
    const path=namedRole(cwdA,"auditor","allowed");namedRole(cwdB,"auditor","allowed");
    const a=await fixture({cwd:cwdA});a.faux.setResponses([fauxAssistantMessage("saved named result")]);
    const record=await a.start(null,"auditor");
    if(state==="removed") rmSync(path);else namedRole(cwdA,"auditor","allowed",false);
    const b=await fixture({cwd:cwdB});const before=readdirSync(join(cwdA,"sessions"));
    const restored=restoreAgentSession(b.ctx,record.sessionFile!,record.resumeSnapshot!,{pi:b.pi}).then(session=>{
      cleanup.push(()=>session.dispose());return session.sessionId;
    });
    await expect(restored).rejects.toThrow(/role|agent|source|authoriz|disabled|removed/i);
    expect(readdirSync(join(cwdA,"sessions"))).toEqual(before);
    expect(record.result).toContain("saved named result");expect(a.effects()).toEqual([]);expect(b.effects()).toEqual([]);
  });
});

async function parentCall(f:Awaited<ReturnType<typeof fixture>>,name:string,args:JsonObject,id:string) {
  let first=true;
  f.parent.agent.streamFunction=(model)=>{
    const message=first?call(name,id,args):fauxAssistantMessage("parent done");first=false;
    message.provider=model.provider;message.model=model.id;message.api=model.api;
    const stream=createAssistantMessageEventStream();stream.push({type:"done",reason:message.stopReason as "stop"|"toolUse",message});stream.end(message);return stream;
  };
  await f.parent.prompt("Execute the public workflow permission probe");
  const result=toolResults(f.parent).find(result=>result.toolCallId===id)!;expect(result).toBeDefined();return result;
}

it("R2 workflow Agent/get/steer work directly but nested calls cannot reach manager operations",async()=>{
  const f=await fixture();
  const targetCalls:string[]=[];
  // Real target hook notifications are observable for direct calls. Native
  // model-only rejection happens before this boundary for nested calls.
  f.pi.on("tool_call",event=>{if(["Agent","get_subagent_result","steer_subagent"].includes(event.toolName)) targetCalls.push(event.toolName);});
  f.faux.setResponses([fauxAssistantMessage("WORKFLOW CHILD RESULT")]);
  const input={subagent_type:"general-purpose",description:"public workflow positive",prompt:"return fixture result",isolated:true};
  const direct=await parentCall(f,"Agent",input,"direct-agent");
  expect(direct.isError).toBe(false);expect(text(direct)).toContain("WORKFLOW CHILD RESULT");
  const archive=f.parent.sessionManager.getEntries().filter(e=>e.type==="custom" && e.customType==="subagents:record").at(-1);
  expect(archive?.type).toBe("custom");
  const childId=(archive as {data:{id:string}}).data.id;
  const get=await parentCall(f,"get_subagent_result",{agent_id:childId,wait:true},"direct-get");
  expect(get.isError).toBe(false);expect(text(get)).toContain("WORKFLOW CHILD RESULT");
  f.faux.setResponses([fauxAssistantMessage("WORKFLOW STEERED RESULT")]);
  const steer=await parentCall(f,"steer_subagent",{agent_id:childId,message:"continue the same authorized child"},"direct-steer");
  expect(steer.isError).toBe(false);
  await parentCall(f,"get_subagent_result",{agent_id:childId,wait:true},"wait-steer");
  expect(targetCalls).toEqual(expect.arrayContaining(["Agent","get_subagent_result","steer_subagent"]));
  const beforeCalls=targetCalls.length,beforeRequests=f.faux.state.callCount;
  const beforeArchives=f.parent.sessionManager.getEntries().filter(e=>e.type==="custom" && e.customType==="subagents:record").length;
  f.faux.setResponses([fauxAssistantMessage("UNEXPECTED NESTED CHILD"),fauxAssistantMessage("UNEXPECTED NESTED STEER")]);
  const attempts:[string,JsonObject][]=[["Agent",input],["get_subagent_result",{agent_id:childId,wait:true}],
    ["steer_subagent",{agent_id:childId,message:"must not resume from nested execution"}]];
  for(const [name,payload] of attempts) {
    expect(f.parent.getToolDefinition(name)).toBeDefined();
    const nested=await parentCall(f,"bridge_one",{target:name,payload},`nested-${name}`);
    expect.soft(nested.isError,`${name} must be rejected at the native nested boundary`).toBe(true);
    expect.soft(text(nested)).toMatch(/not callable|model.only|not available|cannot.*call|tool .*not found/i);
  }
  expect.soft(targetCalls.slice(beforeCalls)).toEqual([]);
  expect.soft(f.faux.state.callCount).toBe(beforeRequests);
  expect(f.parent.sessionManager.getEntries().filter(e=>e.type==="custom" && e.customType==="subagents:record")).toHaveLength(beforeArchives);
});

it("R2 real product activation loads named authority from SDK ctx.cwd, not process.cwd",async()=>{
  const cwd=directory("pi11-r2-activation-");namedRole(cwd,"cwd_authority_unique","allowed");
  expect(cwd).not.toBe(process.cwd());
  // No registerAgents/setPinnedExtensions bootstrap here: the product activation
  // itself must initialize its own module chain from the supplied SDK context.
  const f=await fixture({cwd,bootstrapRunner:false});
  expect(f.agents.get("cwd_authority_unique")?.systemPrompt).toContain("NAMED ORIGINAL INTENT");
  const childPrompts:string[]=[];
  f.faux.setResponses([context=>{
    childPrompts.push(getCurrentSystemPrompt(context.messages));return fauxAssistantMessage("ACTIVATION CHILD CONTROL");
  }]);
  const result=await parentCall(f,"Agent",{subagent_type:"cwd_authority_unique",description:"cwd activation contract",
    prompt:"follow the role file in the supplied SDK directory"},"activation-agent");
  expect(result.isError).toBe(false);expect(text(result)).toContain("ACTIVATION CHILD CONTROL");
  expect(childPrompts).toHaveLength(1);
  expect(childPrompts[0],"parsed role authority must reach the real child through the product activation").toContain("NAMED ORIGINAL INTENT");
});

describe("R2 static disallowedTools exclusion",()=>{
  it.each([0,1,2])("prevents effects at depth %i for ordinary and late-registered targets",async depth=>{
    for(const late of [false,true]) {
      const target="static_target";
      const f=await fixture({sources:{trusted:targetSource([target],late)}});
      const grant={...f.role,extSelectors:["ext:bridge",`ext:trusted/${target}`]};
      const allowedRecord=await f.prime(grant);
      const allowed=await probe(f,allowedRecord.session!,target,depth,"static-positive");
      expect(allowed.result.isError,`positive control, late=${late}`).toBe(false);
      expect(text(allowed.result)).toContain(`EXECUTED ${target}`);
      expect(f.effects()).toEqual([{name:target}]);

      // Only the policy changes: the same extension source, tool and valid
      // arguments must no longer execute. Late registration runs on turn_end
      // during prime, before this attempt; it must not bypass the static deny.
      const deniedRecord=await f.prime({...grant,disallowedTools:[target]});
      const session=deniedRecord.session!;
      const before=f.effects(),beforeProbes=f.probes().length;
      session.setActiveToolsByName([...new Set([...session.getActiveToolNames(),target])]);
      const name=depth===0?target:depth===1?"bridge_one":"bridge_two";
      const id="static-negative";
      f.faux.setResponses([call(name,id,depth===0?{}:{target}),fauxAssistantMessage("static deny probe finished")]);
      await resumeAgent(session,"attempt the permanently excluded target");
      const denied=toolResults(session).find(result=>result.toolCallId===id);
      expect(denied,"the SDK must return the attempted call's result").toBeDefined();
      expect(denied!.isError,`static denial, depth=${depth}, late=${late}`).toBe(true);
      expect(text(denied!).trim().length).toBeGreaterThan(0);
      expect(f.effects(),"the denied attempt must add zero effects").toEqual(before);
      expect(f.effects()).toEqual([{name:target}]);
      if(depth>0) {
        expect(f.probes().slice(beforeProbes).map(event=>event.target)).toEqual(
          depth===1?[target]:["bridge_one",target]);
      }
      // Unlike dynamic subset/source tests, static exclusion may remove the
      // target from the SDK registry/callable set. Not-found is valid here and
      // is deliberately NOT claimed as an execution-hook rejection.
    }
  });
});

describe("R2 reviewed authorization regressions",()=>{
  it.each([
    {label:"explicit write authority positive control",tools:["read","write","edit"],deny:[],memory:"project" as const,writable:true},
    {label:"denied write without memory",tools:["write"],deny:["write"],memory:undefined,writable:false},
    {label:"denied write with project memory",tools:["write"],deny:["write"],memory:"project" as const,writable:false},
  ])("memory capability boundary: $label",async scenario=>{
    const f=await fixture();const path=join(f.cwd,"memory-permission.txt");put(path,"ORIGINAL");
    const role:InlineAgentConfig={...f.role,builtinToolNames:scenario.tools,disallowedTools:scenario.deny,
      extensions:false,extSelectors:[],skills:false,...(scenario.memory?{memory:scenario.memory}:{})};
    f.faux.setResponses([call("edit","memory-edit",{path,oldText:"ORIGINAL",newText:"MUTATED"}),fauxAssistantMessage("memory probe finished")]);
    const record=await f.run(role);
    const result=toolResults(record.session).find(message=>message.toolCallId==="memory-edit");
    expect(result,"the real SDK must settle the edit attempt").toBeDefined();
    expect.soft(readFileSync(path,"utf8")).toBe(scenario.writable?"MUTATED":"ORIGINAL");
    expect(result!.isError).toBe(!scenario.writable);
  });

  it.each(["live","cold"] as const)("current named isolated=true revokes extension execution on %s continuation",async mode=>{
    const cwd=directory(`pi11-r2-isolation-${mode}-`),name="isolation_authority";
    const rolePath=join(cwd,".pi/agents",`${name}.md`);
    const writeRole=(isolated:boolean)=>put(rolePath,`---\ndescription: Named isolation authority\ntools: none\nextensions: [${JSON.stringify(join(cwd,".pi/extensions/trusted.ts"))}]\nskills: false\nisolated: ${isolated}\npersist_session: true\nsession_dir: ${JSON.stringify(join(cwd,"sessions"))}\nprompt_mode: replace\n---\nNAMED ORIGINAL INTENT\n`);
    writeRole(false);
    const f=await fixture({cwd});
    f.faux.setResponses([call("allowed","before-isolation"),fauxAssistantMessage("original extension authority exercised")]);
    const original=await f.start(null,name);
    expect(toolResults(original.session!).find(result=>result.toolCallId==="before-isolation")?.isError).toBe(false);
    expect(f.effects()).toEqual([{name:"allowed"}]);
    const sessionId=original.session!.sessionId;
    writeRole(true); // Only this current authority field changes; no registry reset.
    let session=original.session!;
    if(mode==="cold") {session.dispose();session=await restore(f,original);}
    expect(session.sessionId).toBe(sessionId);
    f.faux.setResponses([call("allowed","after-isolation"),fauxAssistantMessage("isolation probe finished")]);
    await resumeAgent(session,"continue under the current isolated role");
    const result=toolResults(session).find(message=>message.toolCallId==="after-isolation");
    expect(result,"continuation must settle the attempted tool call").toBeDefined();
    expect.soft(f.effects(),"current isolation must prevent any additional marker").toEqual([{name:"allowed"}]);
    expect(result!.isError).toBe(true);
  });

  it("restores a verifiable legacy builtin-only named recipe without new sourcePath or authorization fields",async()=>{
    const cwd=directory("pi11-r2-legacy-named-"),name="legacy_reader";
    put(join(cwd,".pi/agents",`${name}.md`),`---\ndescription: Existing project read-only role\ntools: read\nextensions: false\nskills: false\npersist_session: true\nsession_dir: ${JSON.stringify(join(cwd,"sessions"))}\nprompt_mode: replace\n---\nNAMED ORIGINAL INTENT\nKeep the original read-only task.\n`);
    const f=await fixture({cwd});
    expect(f.agents.get(name)).toMatchObject({source:"project",builtinToolNames:["read"],extensions:false,skills:false});
    f.faux.setResponses([fauxAssistantMessage("LEGACY SAVED RESPONSE")]);
    const original=await f.start(null,name),snapshot=original.resumeSnapshot!;
    const sessionId=original.session!.sessionId,history=original.session!.sessionManager.getEntries();
    const assertPreserved=(session:AgentSession)=>{
      expect(session.sessionId).toBe(sessionId);
      expect(session.systemPrompt).toContain(snapshot.config.systemPrompt);
      expect(session.model?.provider).toBe(snapshot.model.provider);expect(session.model?.id).toBe(snapshot.model.modelId);
      expect(session.thinkingLevel).toBe(snapshot.thinkingLevel);
      for(const entry of history) expect(session.sessionManager.getEntry(entry.id)).toEqual(entry);
      expect(session.getActiveToolNames()).toEqual(["read"]);
    };
    original.session!.dispose();
    // First prove the unchanged current recipe and JSONL are valid independently
    // of the missing-new-fields regression below.
    const control=await restore(f,original);assertPreserved(control);control.dispose();
    const legacy:AgentResumeSnapshot={version:1,config:{name,source:"project",description:"Legacy project reader",
      builtinToolNames:["read"],extensions:false,skills:false,systemPrompt:snapshot.config.systemPrompt,
      promptMode:snapshot.config.promptMode,persistSession:true,sessionDir:join(cwd,"sessions")},
      systemPrompt:snapshot.systemPrompt,cwd:snapshot.cwd,configCwd:snapshot.configCwd,model:snapshot.model,
      thinkingLevel:snapshot.thinkingLevel,isolated:snapshot.isolated,
      ...(snapshot.maxTurns===undefined?{}:{maxTurns:snapshot.maxTurns}),...(snapshot.graceTurns===undefined?{}:{graceTurns:snapshot.graceTurns})};
    const restored=await restoreAgentSession(f.ctx,original.sessionFile!,legacy,{pi:f.pi});cleanup.push(()=>restored.dispose());
    assertPreserved(restored);
    const path=join(cwd,"legacy-readonly.txt");put(path,"LEGACY READ CONTROL");
    const read=await probe(f,restored,"read",0,"legacy-named-read",{path});
    expect(read.result.isError).toBe(false);expect(text(read.result)).toContain("LEGACY READ CONTROL");
    f.faux.setResponses([call("write","legacy-named-write",{path,content:"UNAUTHORIZED MUTATION"}),fauxAssistantMessage("legacy write rejection observed")]);
    await resumeAgent(restored,"attempt a write outside the legacy ceiling");
    expect(readFileSync(path,"utf8")).toBe("LEGACY READ CONTROL");
    expect(toolResults(restored).find(result=>result.toolCallId==="legacy-named-write")?.isError).toBe(true);
    expect(restored.getToolDefinition("allowed")).toBeUndefined();
  });

  it("real SDK cwd B owns Agent declaration and result display metadata when process cwd is A",async()=>{
    const cwdA=directory("pi11-r2-metadata-a-"),cwdB=directory("pi11-r2-metadata-b-");
    const priorCwd=process.cwd();process.chdir(cwdA);cleanup.push(()=>process.chdir(priorCwd));
    const name="sdk_b_authority",displayName="B Project Specialist";
    put(join(cwdA,".pi/agents/wrong_a.md"),"---\ndescription: Wrong process directory role\ntools: none\nextensions: false\nskills: false\n---\nWrong A intent\n");
    put(join(cwdA,".pi/extension-data/pi-subagents/config.json"),JSON.stringify({worktreeIsolation:false,schedulingEnabled:true}));
    put(join(cwdB,".pi/agents",`${name}.md`),`---\ndescription: B local role metadata\ndisplay_name: ${JSON.stringify(displayName)}\ntools: none\nextensions: false\nskills: false\nprompt_mode: replace\npersist_session: true\nsession_dir: ${JSON.stringify(join(cwdB,"sessions"))}\n---\nNAMED ORIGINAL INTENT\n`);
    put(join(cwdB,".pi/extension-data/pi-subagents/config.json"),JSON.stringify({worktreeIsolation:true,schedulingEnabled:false}));
    // Parsing controls are read-only. Do not register the parsed B role or reset
    // runner pins to repair the real product activation under test.
    const f=await fixture({cwd:cwdB,bootstrapRunner:false});
    expect(f.agents.get(name)).toMatchObject({displayName,promptMode:"replace"});
    expect(f.settings).toMatchObject({worktreeIsolation:true,schedulingEnabled:false});
    const definition=f.parent.getToolDefinition("Agent");expect(definition).toBeDefined();
    expect.soft(definition!.description).toContain(name);
    const properties=(definition!.parameters as {properties:Record<string,unknown>}).properties;
    expect.soft(properties).toHaveProperty("isolation");expect.soft(properties).not.toHaveProperty("schedule");
    f.faux.setResponses([fauxAssistantMessage("SDK B CHILD RESULT")]);
    const result=await parentCall(f,"Agent",{subagent_type:name,description:"B metadata contract",prompt:"perform the B role task"},"metadata-agent");
    expect(result.isError).toBe(false);expect(text(result)).toContain("SDK B CHILD RESULT");
    const metadata=result.details as {displayName?:unknown;tags?:unknown};
    expect.soft(metadata.displayName).toBe(displayName);
    expect(metadata.tags).toBeDefined();expect(JSON.stringify(metadata.tags)).not.toMatch(/twin/i);
  });
});
