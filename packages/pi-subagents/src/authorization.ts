import { isAbsolute, normalize } from "node:path";
import type { AgentSession, Extension, InlineExtension, ResourceLoader, ToolInfo } from "@earendil-works/pi-coding-agent";

export const AUTHORIZATION_EXTENSION_PATH = "<inline:subagents-authorization>";

export type AgentRoleIdentity =
  | { kind: "inline" }
  | { kind: "named"; name: string; sourcePath?: string; builtin: boolean };

/** Non-secret authority: no provider configuration, URLs, credentials or callbacks. */
export interface AgentAuthorization {
  version: 1;
  role: AgentRoleIdentity;
  builtinTools: string[];
  deniedTools: string[];
  isolated: boolean;
  extensions: Array<{ path: string; scope: string; tools: "*" | string[] }>;
}

export interface AuthorizationScope {
  role: AgentRoleIdentity;
  builtinTools: readonly string[];
  deniedTools: readonly string[];
  isolated: boolean;
  grants(extension: Extension): "*" | string[] | undefined;
}

function sourcePath(extension: Extension): string {
  if (!isAbsolute(extension.resolvedPath)) {
    throw new Error(`Subagent authorization cannot verify extension source: ${extension.path}`);
  }
  // The SDK resolved this identity when it loaded the owner. Re-reading a
  // symlink now could describe a different file than the registered code.
  return normalize(extension.resolvedPath);
}

function intersectTools(a: "*" | string[], b: "*" | string[]): "*" | string[] {
  if (a === "*") return b === "*" ? "*" : [...b];
  if (b === "*") return [...a];
  return a.filter((name) => b.includes(name));
}

/** A child-local public hook; never replaces SDK Agent execution hooks. */
export class ChildAuthorization {
  private session?: AgentSession;
  private policy?: AgentAuthorization;

  constructor(private readonly loader: ResourceLoader) {}

  readonly extension: InlineExtension = {
    name: "subagents-authorization",
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", (event) => {
        if (!this.allows(event.toolName)) {
          return { block: true, reason: `Tool "${event.toolName}" is not authorized for this subagent.` };
        }
      });
      pi.on("turn_end", () => { this.narrowView(); });
    },
  };

  update(scope: AuthorizationScope, historical?: AgentAuthorization): AgentAuthorization {
    const deniedTools = [...new Set([...scope.deniedTools, ...(historical?.deniedTools ?? [])])];
    const policy: AgentAuthorization = {
      version: 1, role: scope.role,
      builtinTools: scope.builtinTools.filter((name) => !deniedTools.includes(name) &&
        (!historical || historical.builtinTools.includes(name))),
      deniedTools,
      isolated: scope.isolated || historical?.isolated === true,
      extensions: [],
    };
    if (!policy.isolated) {
      for (const extension of this.loader.getExtensions().extensions) {
        if (extension.path === AUTHORIZATION_EXTENSION_PATH) continue;
        const tools = scope.grants(extension);
        if (tools === undefined) continue;
        const path = sourcePath(extension);
        const scopeName = extension.sourceInfo.scope;
        const previous = historical?.extensions.find((entry) => entry.path === path && entry.scope === scopeName);
        if (historical && !previous) continue;
        policy.extensions.push({ path, scope: scopeName, tools: previous ? intersectTools(tools, previous.tools) : tools });
      }
    }
    this.policy = policy;
    this.narrowView();
    return structuredClone(policy);
  }

  bind(session: AgentSession): void {
    this.session = session;
  }

  private allowsInfo(info: ToolInfo): boolean {
    const policy = this.policy;
    if (!policy || policy.deniedTools.includes(info.name)) return false;
    if (info.sourceInfo.path === `builtin:${info.name}` && info.sourceInfo.source === "builtin") {
      return policy.builtinTools.includes(info.name);
    }
    if (policy.isolated) return false;
    // Match the actual winning registration, not merely any extension advertising
    // this name. Late registration and builtin-name overrides keep their real owner.
    for (const extension of this.loader.getExtensions().extensions) {
      const registration = extension.tools.get(info.name);
      if (!registration || registration.sourceInfo.path !== info.sourceInfo.path ||
          registration.definition !== this.session?.getToolDefinition(info.name)) continue;
      const grant = policy.extensions.find((entry) => entry.scope === info.sourceInfo.scope &&
        entry.path === sourcePath(extension));
      return !!grant && (grant.tools === "*" || grant.tools.includes(info.name));
    }
    return false;
  }

  allows(name: string): boolean {
    const info = this.session?.getAllTools().find((tool) => tool.name === name);
    return !!info && this.allowsInfo(info);
  }

  narrowView(): void {
    const session = this.session;
    if (!session) return;
    const previous = session.getActiveToolNames();
    const visible = new Set(previous);
    const next = session.getAllTools().filter((tool) => this.allowsInfo(tool) &&
      (tool.exposure === "direct" || tool.exposure === "model-only" ||
        (tool.exposure !== "hidden" && visible.has(tool.name)))).map((tool) => tool.name);
    if (next.length !== previous.length || next.some((name, index) => name !== previous[index])) {
      session.setActiveToolsByName(next);
    }
  }
}
