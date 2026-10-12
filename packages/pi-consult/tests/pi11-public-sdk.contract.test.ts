import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryCredentialStore, InMemoryModelsStore, Type, createAssistantMessageEventStream,
  fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools,
  type AssistantMessage, type AssistantMessageEventStream, type ImageContent, type Model,
  type Provider, type SimpleStreamOptions, type ToolResultMessage, type TranscriptContext, type Usage,
} from "@earendil-works/pi-ai";
import {
  DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
  createAgentSession, defineTool, type AgentSession, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { ConsultConfig, ConsultDetails } from "../src/types.js";

// Frozen C1 contract and public SDK declarations are the only behavioral oracle.
// Provider functions below are the offline transport boundary, NOT a replacement
// for Consult's execution or ModelRegistry.streamSimple implementation.
const productEntry = fileURLToPath(new URL("../extensions/consult.ts", import.meta.url));
const advisorProvider = "c1-subscription";
const advisorId = "physical-advisor";
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function usage(cost: number, input = 11, output = 7): Usage {
  return { input, output, cacheRead:3, cacheWrite:2, totalTokens:input+output+5,
    cost:{input:cost,output:0,cacheRead:0,cacheWrite:0,total:cost} };
}
function answer(body = '{"verdict":"confirm","summary":"Offline advisor confirms the chosen boundary."}', cost = 0.02) {
  const message = fauxAssistantMessage(body);
  message.usage = usage(cost);
  return message;
}
function stream(message: AssistantMessage): AssistantMessageEventStream {
  const result = createAssistantMessageEventStream();
  result.push({type:"start",partial:{...message,stopReason:"pending"}});
  if (message.stopReason === "aborted" || message.stopReason === "error") {
    result.push({type:"error",reason:message.stopReason,error:message});
  } else {
    result.push({type:"done",reason:message.stopReason as "stop" | "toolUse",message});
  }
  result.end(message);
  return result;
}
interface AdvisorRequest {
  model: Model<string>;
  context: TranscriptContext;
  options: SimpleStreamOptions | undefined;
}
type AdvisorResponse = (request: AdvisorRequest) => AssistantMessageEventStream;
interface FixtureOptions {
  auth?: "oauth" | "api-key" | "missing";
  config?: Partial<ConsultConfig>;
  factories?: ExtensionFactory[];
  respond?: AdvisorResponse;
}
async function fixture(options: FixtureOptions = {}) {
  const cwd = mkdtempSync(join(tmpdir(),"pi11-c1-contract-"));
  const agentDir = join(cwd,"agent");
  const configDir = join(agentDir,"extension-data","pi-consult");
  mkdirSync(configDir,{recursive:true});
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  cleanup.push(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(cwd,{recursive:true,force:true});
  });
  const config: ConsultConfig = {panel:[{model:`${advisorProvider}/${advisorId}`,effort:"high"}],
    fanout:false,gates:{watchdog:0},budget:{perRun:3,perSession:8},disabledForModels:[],...options.config};
  writeFileSync(join(configDir,"config.json"),JSON.stringify(config));
  const credentials = new InMemoryCredentialStore();
  const auth = options.auth ?? "oauth";
  if (auth === "oauth") {
    await credentials.modify(advisorProvider,async()=>({type:"oauth",access:"synthetic-oauth-access",
      refresh:"synthetic-refresh-unused",expires:Date.now()+86_400_000,account:"account-A",endpoint:"https://account-a.invalid/advisor"}));
  } else if (auth === "api-key") {
    await credentials.modify(advisorProvider,async()=>({type:"api_key",key:"synthetic-api-key"}));
  }
  const runtime = await ModelRuntime.create({credentials,modelsStore:new InMemoryModelsStore(),modelsPath:null,
    allowModelNetwork:false,refreshOnCreate:false});
  const registry = new ModelRegistry(runtime);
  const requests: AdvisorRequest[] = [];
  const physical: Model<string> = {id:advisorId,name:"C1 physical advisor",provider:advisorProvider,api:"c1-offline-api",
    baseUrl:"https://wrong-default.invalid",headers:{"x-model":"physical-route"},reasoning:true,input:["text","image"],
    contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
  const dispatch = (model:Model<string>,context:TranscriptContext,requestOptions?:SimpleStreamOptions) => {
    const request = {model,context:structuredClone(context),options:requestOptions};
    requests.push(request);
    return options.respond?.(request) ?? stream(answer());
  };
  const provider: Provider = {
    id:advisorProvider,name:"C1 synthetic subscription",baseUrl:"https://wrong-default.invalid",
    headers:{"x-provider":"provider-route"},
    auth:{
      apiKey:{name:"synthetic key",async resolve({credential}) {
        return credential?.key ? {auth:{apiKey:credential.key,headers:{"x-auth-kind":"api-key"}}} : undefined;
      }},
      oauth:{name:"synthetic OAuth",isSubscription:true,
        async login() {throw new Error("Contract fixtures never log in");},
        async refresh() {throw new Error("The unexpired synthetic credential must not refresh");},
        async toAuth(credential) {return {apiKey:credential.access,baseUrl:String(credential.endpoint),
          headers:{"x-account":String(credential.account),"x-auth-kind":"oauth"}};},
      },
    },
    getModels:()=>[physical],
    stream:()=>{throw new Error("Consult must use the public provider-neutral streamSimple route");},streamSimple:dispatch,
  };
  registry.registerProvider(provider);
  const parentProvider = fauxProvider({provider:"c1-parent",models:[{id:"executor",input:["text","image"],contextWindow:128000,maxTokens:4096}]});
  registry.registerProvider(parentProvider.provider);
  await runtime.setRuntimeApiKey("c1-parent","synthetic-parent-key");
  await runtime.refresh({allowNetwork:false});
  if (auth !== "missing") expect(registry.getAvailable().some(model=>model.provider === advisorProvider)).toBe(true);
  const settingsManager = SettingsManager.inMemory({packages:[],compaction:{enabled:false},retry:{enabled:false}});
  let boundRegistry: ModelRegistry | undefined;
  const observePublicContext: ExtensionFactory = pi=>{pi.on("session_start",(_event,ctx)=>{boundRegistry=ctx.modelRegistry;});};
  const loader = new DefaultResourceLoader({cwd,agentDir,settingsManager,additionalExtensionPaths:[productEntry],
    extensionFactories:[...(options.factories ?? []),observePublicContext],noSkills:true,noThemes:true,noPromptTemplates:true,noContextFiles:true,
    systemPrompt:"PARENT EXECUTOR SYSTEM SENTINEL: use authorized tools to perform work."});
  await loader.reload();
  expect(loader.getExtensions().errors,"real loader must accept the product and fixture").toEqual([]);
  const {session} = await createAgentSession({cwd,agentDir,resourceLoader:loader,settingsManager,modelRuntime:runtime,
    model:parentProvider.getModel(),sessionManager:SessionManager.inMemory(cwd),thinkingLevel:"off",noTools:"builtin"});
  cleanup.push(async()=>{await session.abort();session.dispose();});
  const errors: unknown[] = [];
  await session.bindExtensions({onError:error=>{errors.push(error);}});
  expect(errors,"session_start must succeed before behavioral assertions").toEqual([]);
  expect(session.getActiveToolNames()).toContain("consult");
  return {session,requests,errors,registry,runtime,credentials,boundRegistry};
}
interface ParentRequest { messages: TranscriptContext["messages"]; tools: ReturnType<typeof getCurrentTools> }
function script(session:AgentSession, responses:AssistantMessage[]) {
  const requests:ParentRequest[] = [];
  let index = 0;
  session.agent.streamFunction = (model,context) => {
    requests.push({messages:structuredClone(context.messages),tools:getCurrentTools(context.messages)});
    const message = structuredClone(responses[index++] ?? fauxAssistantMessage("done"));
    message.provider=model.provider;message.model=model.id;message.api=model.api;
    return stream(message);
  };
  return requests;
}
function call(name:string,id:string,args:Record<string,string | number> = {}) {
  return fauxAssistantMessage(fauxToolCall(name,args,{id}),{stopReason:"toolUse"});
}
function results(session:AgentSession) {
  return session.messages.filter((message):message is ToolResultMessage => message.role === "toolResult");
}
function consultResult(session:AgentSession,id="direct-consult") {
  const result = results(session).find(message=>message.toolCallId === id);
  expect(result,`the SDK must persist ${id}`).toBeDefined();
  return result!;
}
function details(result:ToolResultMessage): ConsultDetails {
  return result.details as unknown as ConsultDetails;
}
function messageText(message:{content:unknown}):string {
  if (typeof message.content === "string") return message.content;
  return Array.isArray(message.content) ? message.content.filter(block=>block.type === "text").map(block=>block.text).join("\n") : "";
}
const why = "Compare the unresolved high-cost boundary before committing to the design.";

describe("C1 real public SDK contracts",()=>{
  it.each(["oauth","api-key"] as const)("direct Consult preserves the %s identity and keeps advisor context tool-free",async auth=>{
    // A pass-through spy observes the required public route; the actual SDK still
    // resolves credentials and dispatches the registered offline provider.
    const publicStream = vi.spyOn(ModelRegistry.prototype,"streamSimple");
    const f = await fixture({auth});
    expect(f.boundRegistry?.streamSimple,"the SDK-bound context must share the observed public method").toBe(publicStream);
    const parent = script(f.session,[call("consult","direct-consult",{why}),fauxAssistantMessage("CONSULT-LOG: adopt | confirmed: boundary checked")]);
    const image:ImageContent = {type:"image",mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="};
    await f.session.prompt("USER REQUEST SENTINEL: please consult an advisor about this picture.",{images:[image]});
    const result = consultResult(f.session);
    expect(details(result).outcome).toBe("completed");
    expect(f.requests).toHaveLength(1);
    const request=f.requests[0];
    expect(request.model.provider).toBe(advisorProvider);
    expect(request.model.id).toBe(advisorId);
    expect(request.options?.reasoning).toBe("high");
    expect(request.options?.signal).toBeInstanceOf(AbortSignal);
    expect(request.options?.headers).toMatchObject({"x-model":"physical-route","x-auth-kind":auth});
    if (auth === "oauth") {
      expect(request.model.baseUrl).toBe("https://account-a.invalid/advisor");
      expect(request.options?.apiKey).toBe("synthetic-oauth-access");
      expect(request.options?.headers).toMatchObject({"x-account":"account-A"});
    } else {
      expect(request.options?.apiKey).toBe("synthetic-api-key");
    }
    expect(parent[0].tools.some(tool=>tool.name === "consult")).toBe(true);
    expect(getCurrentTools(request.context.messages)).toEqual([]);
    expect(getCurrentSystemPrompt(request.context.messages)).not.toContain("PARENT EXECUTOR SYSTEM SENTINEL");
    expect(getCurrentSystemPrompt(request.context.messages).length).toBeGreaterThan(0);
    expect(JSON.stringify(request.context.messages)).toContain("USER REQUEST SENTINEL");
    expect(JSON.stringify(request.context.messages)).toContain(why);
    const userImages = (messages:TranscriptContext["messages"]) => messages.flatMap(message=>
      message.role === "user" && Array.isArray(message.content) ? message.content.filter(block=>block.type === "image") : []);
    expect(userImages(parent[0].messages),"the parent SDK fixture must actually include a user image").toHaveLength(1);
    expect(userImages(request.context.messages)).toEqual(userImages(parent[0].messages));
    expect(request.context.messages.some(message=>message.role === "assistant" && message.content.some(block=>block.type === "toolCall" && block.id === "direct-consult"))).toBe(false);
    expect(result.usage).toEqual(usage(0.02));
    const route=publicStream.mock.calls.find(([model])=>model.provider === advisorProvider);
    expect(route,"production Consult must use the real public ModelRegistry.streamSimple route").toBeDefined();
    expect(route![2]).not.toHaveProperty("apiKey");
    expect(route![2]).not.toHaveProperty("headers");
    expect(f.errors).toEqual([]);
  });

  it("nested ctx.executeTool cannot initiate any advisor request",async()=>{
    const nested:ExtensionFactory = pi=>pi.registerTool(defineTool({name:"nested_driver",label:"Nested driver",description:"Try an actual nested consult",
      parameters:Type.Object({}),async execute(_id,_args,_signal,_update,ctx) {
        try {
          const result=await ctx.executeTool("consult",{why});
          return {content:[{type:"text",text:"nested consult unexpectedly resolved"}],details:{rejected:result.isError === true}};
        } catch (error) {
          return {content:[{type:"text",text:String(error)}],details:{rejected:true}};
        }
      }}));
    const f=await fixture({factories:[nested]});
    script(f.session,[call("nested_driver","nested-call"),fauxAssistantMessage("done")]);
    await f.session.prompt("Run the nested permission probe.");
    expect(f.requests,"nested tool calls must perform zero advisor requests").toHaveLength(0);
    expect(consultResult(f.session,"nested-call").details).toMatchObject({rejected:true});
    expect(f.errors).toEqual([]);
  });

  it("watchdog counts outer calls once, ignores nested events, and rearms after Consult",async()=>{
    let leafExecutions=0;
    const tools:ExtensionFactory = pi=>{
      pi.registerTool(defineTool({name:"leaf",label:"Leaf",description:"Repeated nested operation",parameters:Type.Object({}),
        async execute() {leafExecutions++;return {content:[{type:"text",text:"leaf success"}],details:{}};}}));
      pi.registerTool(defineTool({name:"outer",label:"Outer",description:"One top-level operation with three nested calls",parameters:Type.Object({}),
        async execute(_id,_args,_signal,_update,ctx) {
          for (let i=0;i<3;i++) await ctx.executeTool("leaf",{});
          return {content:[{type:"text",text:"outer success"}],details:{}};
        }}));
    };
    const f=await fixture({config:{gates:{watchdog:3}},factories:[tools]});
    const parent=script(f.session,[call("outer","outer-1"),call("outer","outer-2"),call("outer","outer-3"),
      call("consult","watchdog-consult",{why}),call("outer","outer-4"),call("outer","outer-5"),call("outer","outer-6"),fauxAssistantMessage("done")]);
    await f.session.prompt("Execute the bounded watchdog fixture.");
    const nudges=(request:ParentRequest)=>request.messages.filter(message=>message.role === "user"
      && messageText(message).includes("先 consult 再继续")).length;
    expect(leafExecutions,"the fixture must execute all six outer calls and their children").toBe(18);
    expect.soft(nudges(parent[1]),"three nested calls inside the first outer must not reach the threshold").toBe(0);
    expect.soft(nudges(parent[2])).toBe(0);
    expect(nudges(parent[3]),"the third outer must still count").toBe(1);
    expect(details(consultResult(f.session,"watchdog-consult")).trigger).toBe("watchdog");
    expect(nudges(parent[6]),"Consult itself and old evidence must not retrigger the gate").toBe(1);
    expect(nudges(parent[7]),"three fresh outer events must rearm the watchdog").toBe(2);
    expect(f.requests).toHaveLength(1);
  });

  it("empty-response retries aggregate their actual usage and consume the remaining run budget",async()=>{
    let attempts=0;
    const f=await fixture({config:{budget:{perRun:2,perSession:2}},respond:()=>stream(++attempts === 1 ? answer("",0.01) : answer(undefined,0.02))});
    script(f.session,[call("consult","retry-consult",{why}),call("consult","over-budget",{why}),fauxAssistantMessage("done")]);
    await f.session.prompt("Ask for a second opinion, with exactly two attempts available.");
    const completed=consultResult(f.session,"retry-consult");
    expect(details(completed).outcome).toBe("completed");
    expect.soft(f.requests).toHaveLength(2);
    expect(completed.usage?.cost.total).toBeCloseTo(0.03,12);
    expect(completed.usage).toMatchObject({input:22,output:14,cacheRead:6,cacheWrite:4,totalTokens:46});
    expect(details(consultResult(f.session,"over-budget")).outcome).toBe("blocked");
    expect(f.errors).toEqual([]);
  });

  it("cancellation reaches the real provider signal and cannot start another request",async()=>{
    const entered=gate(),aborted=gate();
    const f=await fixture({config:{budget:{perRun:1,perSession:1}},respond:request=>{
      const result=createAssistantMessageEventStream();
      const finish=()=>{
        const message=answer("",0.007);message.stopReason="aborted";message.errorMessage="synthetic cancellation";
        result.push({type:"error",reason:"aborted",error:message});result.end(message);aborted.resolve();
      };
      expect(request.options?.signal).toBeDefined();
      if (request.options!.signal!.aborted) finish();
      else request.options!.signal!.addEventListener("abort",finish,{once:true});
      entered.resolve();return result;
    }});
    script(f.session,[call("consult","cancelled-consult",{why}),fauxAssistantMessage("done")]);
    const run=f.session.prompt("Start an advisor request that I will cancel.");
    try {
      await entered.promise;
      await f.session.abort();await aborted.promise;await run;
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0].options?.signal?.aborted).toBe(true);
      const cancelled=consultResult(f.session,"cancelled-consult");
      expect(details(cancelled).outcome).toBe("cancelled");
      expect(cancelled.usage?.cost.total).toBeCloseTo(0.007,12);
      script(f.session,[call("consult","after-cancel",{why}),fauxAssistantMessage("done")]);
      await f.session.prompt("A fresh input does not restore the spent session budget.");
      expect(details(consultResult(f.session,"after-cancel")).outcome).toBe("blocked");
      expect(f.requests).toHaveLength(1);
    } finally {await f.session.abort();await run;}
  });

  it("provider failure retains its reported usage and does not switch accounts or crash the parent",async()=>{
    const f=await fixture({respond:()=>{
      const message=answer("",0.004);message.stopReason="error";message.errorMessage="synthetic subscription endpoint unavailable";
      return stream(message);
    }});
    script(f.session,[call("consult","direct-consult",{why}),fauxAssistantMessage("parent still running")]);
    await f.session.prompt("Exercise the configured provider's failed request.");
    const result=consultResult(f.session);
    expect(details(result).outcome).toBe("failed");
    expect(messageText(result)).toContain("synthetic subscription endpoint unavailable");
    expect(result.usage?.cost.total).toBeCloseTo(0.004,12);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].model.baseUrl).toBe("https://account-a.invalid/advisor");
    expect(f.session.getLastAssistantText()).toBe("parent still running");
    expect(f.errors).toEqual([]);
  });

  it("missing credentials fail locally without falling back to another channel",async()=>{
    const f=await fixture({auth:"missing"});
    script(f.session,[call("consult","direct-consult",{why}),fauxAssistantMessage("session remains usable")]);
    await f.session.prompt("Consult with an intentionally unconfigured advisor account.");
    const result=consultResult(f.session);
    expect(["blocked","failed"]).toContain(details(result).outcome);
    expect(messageText(result)).toMatch(/auth|credential|key|available|configured/i);
    expect(f.requests).toHaveLength(0);
    expect(f.session.getLastAssistantText()).toBe("session remains usable");
    expect(f.errors).toEqual([]);
  });
});
