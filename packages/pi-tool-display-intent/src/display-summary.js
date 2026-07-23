const DISPLAY_SUMMARY_WRAPPED_KEY = Symbol.for("pi-tool-display-intent.displaySummaryWrapped.v1");

export const DISPLAY_SUMMARY_FIELD = "displaySummary";
export const DEFAULT_DISPLAY_SUMMARY_MAX_LENGTH = 96;

const OSC_PATTERN = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ESCAPE_PATTERN = /\x1b[@-_]/g;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/g;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampMaxLength(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_DISPLAY_SUMMARY_MAX_LENGTH;
  }
  return Math.min(256, Math.max(16, Math.floor(value)));
}

function languageInstruction(language) {
  if (language === "zh-CN") {
    return "Write it in Simplified Chinese.";
  }
  if (language === "en") {
    return "Write it in English.";
  }
  return "Use the same primary language as the user's request.";
}

function buildSchemaDescription(options) {
  return [
    "Short user-facing phrase describing the intent of this specific tool call.",
    languageInstruction(options.language),
    "Keep it concise, use sentence case, omit trailing punctuation, and never include secrets or credentials.",
    "Describe why the tool is being used rather than merely repeating its raw arguments.",
  ].join(" ");
}

function cloneObjectWithDescriptors(value) {
  const clone = Object.create(Object.getPrototypeOf(value));
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(value));
  return clone;
}

function normalizeOptions(options = {}) {
  return {
    required: options.required !== false,
    language: options.language === "zh-CN" || options.language === "en" ? options.language : "auto",
    maxLength: clampMaxLength(options.maxLength),
    preserveRendererArgs: options.preserveRendererArgs === true,
    fallback: options.fallback,
  };
}

export function normalizeDisplaySummary(value, maxLength = DEFAULT_DISPLAY_SUMMARY_MAX_LENGTH) {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(CONTROL_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, clampMaxLength(maxLength));
}

export function getDisplaySummary(args, maxLength = DEFAULT_DISPLAY_SUMMARY_MAX_LENGTH) {
  return isRecord(args)
    ? normalizeDisplaySummary(args[DISPLAY_SUMMARY_FIELD], maxLength)
    : undefined;
}

export function stripDisplaySummary(args) {
  if (!isRecord(args) || !Object.prototype.hasOwnProperty.call(args, DISPLAY_SUMMARY_FIELD)) {
    return args;
  }

  const { [DISPLAY_SUMMARY_FIELD]: _displaySummary, ...toolArgs } = args;
  return toolArgs;
}

export function hasDisplaySummaryParameter(parameters) {
  return isRecord(parameters?.properties) &&
    Object.prototype.hasOwnProperty.call(parameters.properties, DISPLAY_SUMMARY_FIELD);
}

export function addDisplaySummaryParameter(parameters, rawOptions = {}) {
  if (!isRecord(parameters)) {
    throw new TypeError("Tool parameters must be an object schema before displaySummary can be added.");
  }
  if (hasDisplaySummaryParameter(parameters)) {
    throw new TypeError(`Tool schema already defines ${DISPLAY_SUMMARY_FIELD}; refusing to change its execution semantics.`);
  }

  const options = normalizeOptions(rawOptions);
  const next = cloneObjectWithDescriptors(parameters);
  const currentProperties = isRecord(parameters.properties) ? parameters.properties : {};
  const properties = cloneObjectWithDescriptors(currentProperties);
  properties[DISPLAY_SUMMARY_FIELD] = {
    type: "string",
    description: buildSchemaDescription(options),
    minLength: 4,
    maxLength: options.maxLength,
  };
  next.properties = properties;

  const currentRequired = Array.isArray(parameters.required) ? parameters.required : [];
  next.required = options.required
    ? [...new Set([...currentRequired, DISPLAY_SUMMARY_FIELD])]
    : currentRequired.filter((field) => field !== DISPLAY_SUMMARY_FIELD);

  return next;
}

function resolveFallback(tool, args, options) {
  const rawFallback = typeof options.fallback === "function"
    ? options.fallback(args, tool)
    : options.fallback;
  const configured = normalizeDisplaySummary(rawFallback, options.maxLength);
  if (configured) {
    return configured;
  }

  const label = typeof tool.label === "string" && tool.label.trim()
    ? tool.label.trim()
    : typeof tool.name === "string" && tool.name.trim()
      ? tool.name.trim()
      : "tool";
  const fallback = options.language === "zh-CN" ? `正在运行 ${label}` : `Running ${label}`;
  return normalizeDisplaySummary(fallback, options.maxLength);
}

function backfillDisplaySummary(args, summary) {
  if (!isRecord(args) || !summary || getDisplaySummary(args)) {
    return;
  }

  try {
    Reflect.set(args, DISPLAY_SUMMARY_FIELD, summary);
  } catch {
    // Frozen or proxy-backed provider arguments still receive the prepared fallback.
  }
}

export function withDisplaySummary(tool, rawOptions = {}) {
  if (!isRecord(tool)) {
    throw new TypeError("A tool definition object is required.");
  }
  if (tool[DISPLAY_SUMMARY_WRAPPED_KEY] === true) {
    return tool;
  }
  if (typeof tool.execute !== "function") {
    throw new TypeError("Tool definition must provide execute().");
  }

  const options = normalizeOptions(rawOptions);
  const originalPrepareArguments = typeof tool.prepareArguments === "function"
    ? tool.prepareArguments
    : undefined;
  const originalExecute = tool.execute;
  const originalRenderCall = typeof tool.renderCall === "function"
    ? tool.renderCall
    : undefined;
  const originalGuidelines = Array.isArray(tool.promptGuidelines) ? tool.promptGuidelines : [];
  const languageGuideline = languageInstruction(options.language);
  // Keep this tool-name agnostic so Pi deduplicates the guideline across active
  // wrapped tools. Per-tool semantics remain next to the field in its schema.
  const intentGuideline = `Every tool call whose schema defines ${DISPLAY_SUMMARY_FIELD} must include it, including follow-up calls in the same agent run. Set it to a concise user-facing phrase describing that call's intent. ${languageGuideline} Never include secrets or credentials.`;

  const wrapped = {
    ...tool,
    promptGuidelines: [...originalGuidelines, intentGuideline],
    parameters: addDisplaySummaryParameter(tool.parameters, options),
    prepareArguments(args) {
      const summary = getDisplaySummary(args, options.maxLength) ?? resolveFallback(tool, args, options);
      backfillDisplaySummary(args, summary);
      const toolArgs = stripDisplaySummary(args);
      const prepared = originalPrepareArguments
        ? originalPrepareArguments.call(tool, toolArgs)
        : toolArgs;

      if (!isRecord(prepared)) {
        return prepared;
      }
      return { ...prepared, [DISPLAY_SUMMARY_FIELD]: summary };
    },
    execute(toolCallId, args, signal, onUpdate, ctx) {
      return originalExecute.call(tool, toolCallId, stripDisplaySummary(args), signal, onUpdate, ctx);
    },
  };

  if (originalRenderCall && !options.preserveRendererArgs) {
    wrapped.renderCall = function renderCallWithoutDisplaySummary(args, theme, context) {
      return originalRenderCall.call(tool, stripDisplaySummary(args), theme, context);
    };
  }

  Object.defineProperty(wrapped, DISPLAY_SUMMARY_WRAPPED_KEY, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return wrapped;
}
