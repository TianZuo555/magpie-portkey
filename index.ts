import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import {
  jsonSchema,
  streamText,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai";
import {
  calculateCost,
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type TranscriptContext,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDER_ID = "portkey-aws";
const API_ID = "portkey-aws-ai-sdk" as Api;
const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const LOCAL_CONFIG_PATH = join(EXTENSION_DIR, "config.local.json");
const CONFIG_PATH = existsSync(LOCAL_CONFIG_PATH) ? LOCAL_CONFIG_PATH : join(EXTENSION_DIR, "config.json");
const MODELS_PATH = join(EXTENSION_DIR, "models.json");

// Anthropic models on Bedrock only cache at explicit checkpoints. Without these
// markers nothing is ever written to the cache, so every request pays full
// input price on the entire prompt. Bedrock allows 4 checkpoints; we use 2.
const BEDROCK_CACHE_POINT = {
  bedrock: { cachePoint: { type: "default" as const } },
};

interface ModelConfig {
  id: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
  input?: Array<"text" | "image">;
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}

interface PortkeyConfig {
  baseUrl: string;
  apiKeyEnv: string;
  provider?: string;
  configId?: string;
  headers: Record<string, string>;
  models: ModelConfig[];
}

interface StreamBlockState {
  contentIndex: number;
  partialJson?: string;
  ended: boolean;
}

function readModels(value: unknown, configPath: string): ModelConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${configPath}: models must be a non-empty array`);
  }

  return value.map((entry, index) => {
    if (typeof entry === "string" && entry.length > 0) return { id: entry };
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      const model = entry as ModelConfig;
      if (typeof model.id === "string" && model.id.length > 0) return model;
    }
    throw new Error(`${configPath}: models[${index}] must be a model ID or an object with an id`);
  });
}

function readHeaders(value: unknown, configPath: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${configPath}: headers must be an object`);
  }

  const headers: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(value)) {
    if (/(authorization|api[-_]?key|token|secret|cookie|virtual[-_]?key)/i.test(key)) {
      throw new Error(`${configPath}: secret header ${key} must stay in the environment or Magpie’s API-key sign-in, not tracked JSON`);
    }
    if (typeof headerValue !== "string") {
      throw new Error(`${configPath}: headers.${key} must be a string`);
    }
    headers[key] = headerValue;
  }
  return headers;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${path}: ${formatError(error)}`);
  }
}

export function readConfig(configPath = CONFIG_PATH, modelsPath = MODELS_PATH): PortkeyConfig {
  const value = readJsonFile(configPath);

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${configPath}: root value must be an object`);
  }

  const raw = value as Record<string, unknown>;
  for (const forbidden of ["apiKey", "anthropicApiKey", "authToken", "virtualKey"]) {
    if (forbidden in raw) {
      throw new Error(`${configPath}: ${forbidden} is a secret and must stay in the environment or Magpie’s API-key sign-in`);
    }
  }
  if (typeof raw.baseUrl !== "string" || raw.baseUrl.length === 0) {
    throw new Error(`${configPath}: baseUrl must be a non-empty string`);
  }
  const apiKeyEnv = raw.apiKeyEnv ?? "PORTKEY_API_KEY";
  if (typeof apiKeyEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
    throw new Error(`${configPath}: apiKeyEnv must be a valid environment variable name`);
  }
  if (raw.provider !== undefined && typeof raw.provider !== "string") {
    throw new Error(`${configPath}: provider must be a string`);
  }
  if (raw.configId !== undefined && typeof raw.configId !== "string") {
    throw new Error(`${configPath}: configId must be a string`);
  }

  const headers = readHeaders(raw.headers, configPath);
  if (raw.provider) headers["x-portkey-provider"] = raw.provider;
  if (raw.configId) headers["x-portkey-config"] = raw.configId;

  return {
    baseUrl: raw.baseUrl,
    apiKeyEnv,
    provider: raw.provider,
    configId: raw.configId,
    headers,
    models: readModels(readJsonFile(modelsPath), modelsPath),
  };
}

function providerHeaders(
  portkeyApiKey: string,
  configuredHeaders: Record<string, string> | undefined,
): Record<string, string> {
  return {
    ...configuredHeaders,
    "x-portkey-api-key": portkeyApiKey,
  };
}

function convertUserContent(content: string | Array<TextContent | ImageContent>): ModelMessage["content"] {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { type: "text" as const, text: part.text };
    return {
      type: "file" as const,
      data: part.data,
      mediaType: part.mimeType,
    };
  });
}

function convertToolResultContent(message: ToolResultMessage) {
  const text = message.content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const images = message.content.filter((part): part is ImageContent => part.type === "image");

  if (images.length === 0) {
    return message.isError
      ? ({ type: "error-text", value: text || "Tool execution failed" } as const)
      : ({ type: "text", value: text } as const);
  }

  return {
    type: "content" as const,
    value: [
      ...(text ? [{ type: "text" as const, text: message.isError ? `Error: ${text}` : text }] : []),
      ...images.map((image) => ({
        type: "file" as const,
        data: { type: "data" as const, data: image.data },
        mediaType: image.mimeType,
      })),
    ],
  };
}

function convertMessages(messages: Message[]): ModelMessage[] {
  const converted: ModelMessage[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      converted.push({ role: "user", content: convertUserContent(message.content) as never });
      continue;
    }

    if (message.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      for (const block of message.content) {
        if (block.type === "text") {
          if (block.text) content.push({ type: "text", text: block.text });
        } else if (block.type === "thinking") {
          const thinking = block as ThinkingContent;
          if (thinking.redacted && thinking.thinkingSignature) {
            content.push({ type: "reasoning", text: "", providerOptions: { bedrock: { redactedData: thinking.thinkingSignature } } });
            continue;
          }
          if (!thinking.thinking) continue;
          if (thinking.thinkingSignature) {
            content.push({
              type: "reasoning",
              text: thinking.thinking,
              providerOptions: { bedrock: { signature: thinking.thinkingSignature } },
            });
          } else {
            // Bedrock Anthropic models reject replayed thinking without a signature. Preserve it as text instead.
            content.push({ type: "text", text: thinking.thinking });
          }
        } else if (block.type === "toolCall") {
          content.push({
            type: "tool-call",
            toolCallId: block.id,
            toolName: block.name,
            input: block.arguments,
          });
        }
      }
      if (content.length > 0) converted.push({ role: "assistant", content: content as never });
      continue;
    }

    if (message.role === "toolResult") {
      converted.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: message.toolCallId,
            toolName: message.toolName,
            output: convertToolResultContent(message),
          },
        ],
      });
    }
  }

  // Checkpoint the end of the conversation so the next turn reads this prefix
  // back instead of re-paying for it. The marker rolls forward every turn.
  const last = converted[converted.length - 1];
  if (last) last.providerOptions = BEDROCK_CACHE_POINT;

  return converted;
}

function convertTools(tools: Tool[] | undefined): ToolSet | undefined {
  if (!tools || tools.length === 0) return undefined;

  const converted: ToolSet = {};
  for (const tool of tools) {
    converted[tool.name] = {
      description: tool.description,
      inputSchema: jsonSchema(tool.parameters as never),
      outputSchema: jsonSchema({}),
    };
  }
  return converted;
}

function mapReasoning(level: SimpleStreamOptions["reasoning"], enabled: boolean) {
  if (!enabled || !level) return "none" as const;
  // AI SDK's top-level reasoning type does not yet include max. The provider
  // option below preserves the actual max effort instead of downgrading it.
  if (level === "max") return "xhigh" as const;
  return level;
}

const BEDROCK_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function bedrockReasoningOptions(model: Model<Api>, level: SimpleStreamOptions["reasoning"]) {
  if (!model.reasoning || !level || !model.thinkingLevelMap) return undefined;

  const mapped = model.thinkingLevelMap[level];
  if (mapped === null) return undefined;
  const effort = typeof mapped === "string" ? mapped : level === "minimal" ? "low" : level;
  if (!BEDROCK_REASONING_EFFORTS.has(effort)) return undefined;

  return {
    bedrock: {
      reasoningConfig: {
        type: "adaptive" as const,
        // Bedrock omits thinking unless display asks for it, so a long think
        // sends nothing until the answer starts: the first token then waits for
        // the whole reasoning pass. Summarized thinking streams as it happens.
        display: "summarized" as const,
        maxReasoningEffort: effort as "low" | "medium" | "high" | "xhigh" | "max",
      },
    },
  };
}

function mapFinishReason(reason: FinishReason): StopReason {
  switch (reason) {
    case "tool-calls":
      return "toolUse";
    case "length":
      return "length";
    case "error":
      return "error";
    default:
      return "stop";
  }
}

function updateUsage(output: AssistantMessage, usage: LanguageModelUsage, model: Model<Api>): void {
  const cacheRead = usage.inputTokenDetails.cacheReadTokens ?? 0;
  const cacheWrite = usage.inputTokenDetails.cacheWriteTokens ?? 0;
  const input =
    usage.inputTokenDetails.noCacheTokens ??
    Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);

  output.usage.input = input;
  output.usage.output = usage.outputTokens ?? 0;
  output.usage.cacheRead = cacheRead;
  output.usage.cacheWrite = cacheWrite;
  output.usage.totalTokens = input + output.usage.output + cacheRead + cacheWrite;
  calculateCost(model, output.usage);
}

function applyReasoningMetadata(block: ThinkingContent, metadata: unknown): void {
  if (!metadata || typeof metadata !== "object") return;
  for (const key of ["amazonBedrock", "bedrock"]) {
    const entry = (metadata as Record<string, unknown>)[key];
    if (!entry || typeof entry !== "object") continue;
    const { signature, redactedData } = entry as Record<string, unknown>;
    if (typeof signature === "string" && signature) block.thinkingSignature = signature;
    if (typeof redactedData === "string" && redactedData) {
      block.thinkingSignature = redactedData;
      block.redacted = true;
    }
  }
}

function parseToolInput(input: unknown): ToolCall["arguments"] {
  const parsed: unknown = typeof input === "string" ? JSON.parse(input) : input;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as ToolCall["arguments"];
  }
  throw new Error("Portkey returned tool arguments that are not a JSON object");
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    const apiError = error as Error & { responseBody?: unknown; statusCode?: number };
    const responseBody =
      typeof apiError.responseBody === "string"
        ? apiError.responseBody
        : apiError.responseBody === undefined
          ? undefined
          : JSON.stringify(apiError.responseBody);
    return [
      apiError.message || "API request failed",
      apiError.statusCode ? `(HTTP ${apiError.statusCode})` : undefined,
      responseBody,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function streamPortkeyAws(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  configuredHeaders: Record<string, string>,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  void (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    const textBlocks = new Map<string, StreamBlockState>();
    const reasoningBlocks = new Map<string, StreamBlockState>();
    const toolBlocks = new Map<string, StreamBlockState>();

    const ensureTextBlock = (id: string): StreamBlockState => {
      const existing = textBlocks.get(id);
      if (existing) return existing;
      const state = { contentIndex: output.content.length, ended: false };
      output.content.push({ type: "text", text: "" });
      textBlocks.set(id, state);
      stream.push({ type: "text_start", contentIndex: state.contentIndex, partial: output });
      return state;
    };

    const ensureReasoningBlock = (id: string, metadata?: unknown): StreamBlockState => {
      const existing = reasoningBlocks.get(id);
      if (existing) return existing;
      const block: ThinkingContent = { type: "thinking", thinking: "" };
      applyReasoningMetadata(block, metadata);
      const state = { contentIndex: output.content.length, ended: false };
      output.content.push(block);
      reasoningBlocks.set(id, state);
      stream.push({ type: "thinking_start", contentIndex: state.contentIndex, partial: output });
      return state;
    };

    const ensureToolBlock = (id: string, name: string): StreamBlockState => {
      const existing = toolBlocks.get(id);
      if (existing) return existing;
      const state = { contentIndex: output.content.length, partialJson: "", ended: false };
      output.content.push({ type: "toolCall", id, name, arguments: {} });
      toolBlocks.set(id, state);
      stream.push({ type: "toolcall_start", contentIndex: state.contentIndex, partial: output });
      return state;
    };

    try {
      const portkeyApiKey = options?.apiKey;
      if (!portkeyApiKey) throw new Error("The configured Portkey API key environment variable is not set");

      const send = options?.fetch ?? globalThis.fetch;
      const signal = options?.timeoutMs
        ? AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(options.timeoutMs)])
        : options?.signal;
      const bedrock = createAmazonBedrock({
        baseURL: model.baseUrl,
        // Portkey requires both Bearer authentication and its own key header.
        apiKey: portkeyApiKey,
        headers: providerHeaders(portkeyApiKey, configuredHeaders),
        fetch: async (url, init) => {
          if (options?.onPayload && typeof init?.body === "string") {
            const payload: unknown = JSON.parse(init.body);
            const replacement = await options.onPayload(payload, model);
            init = { ...init, body: JSON.stringify(replacement ?? payload) };
          }
          const response = await send(url, init);
          await options?.onResponse?.({
            status: response.status,
            headers: Object.fromEntries(response.headers),
          }, model);
          return response;
        },
      });

      const systemPrompt = getCurrentSystemPrompt(context.messages);
      const reasoningOptions = bedrockReasoningOptions(model, options?.reasoning);
      const result = streamText({
        model: bedrock(model.id as never),
        // Passed as a SystemModelMessage rather than a plain string so it can
        // carry a cache checkpoint. Tools and system form the large static
        // prefix, so this is the checkpoint that pays for itself.
        instructions: systemPrompt
          ? {
              role: "system",
              content: systemPrompt,
              providerOptions: BEDROCK_CACHE_POINT,
            }
          : undefined,
        messages: convertMessages(context.messages),
        tools: convertTools(getCurrentTools(context.messages)),
        maxOutputTokens: options?.maxTokens ?? model.maxTokens,
        reasoning: reasoningOptions ? undefined : mapReasoning(options?.reasoning, model.reasoning),
        providerOptions: reasoningOptions,
        temperature: model.reasoning && options?.reasoning ? undefined : options?.temperature,
        toolChoice: options?.toolChoice,
        headers: Object.fromEntries(Object.entries(options?.headers ?? {}).filter((entry): entry is [string, string] => entry[1] !== null)),
        includeRawChunks: !!options?.onProviderStreamEvent,
        abortSignal: signal,
        maxRetries: 0,
        // The host renders finalized errors; suppress the SDK's stack dump.
        onError: () => {},
      });

      stream.push({ type: "start", partial: output });

      let finished = false;
      for await (const part of result.stream) {
        if (part.type === "raw" && options?.onProviderStreamEvent) {
          // Observation must not interrupt the response if an observer fails.
          try { await options.onProviderStreamEvent(part.rawValue, model); } catch {}
        }
        switch (part.type) {
          case "text-start":
            ensureTextBlock(part.id);
            break;
          case "text-delta": {
            const state = ensureTextBlock(part.id);
            const block = output.content[state.contentIndex];
            if (block.type !== "text") break;
            block.text += part.text;
            stream.push({ type: "text_delta", contentIndex: state.contentIndex, delta: part.text, partial: output });
            break;
          }
          case "text-end": {
            const state = ensureTextBlock(part.id);
            if (state.ended) break;
            state.ended = true;
            const block = output.content[state.contentIndex];
            if (block.type === "text") {
              stream.push({ type: "text_end", contentIndex: state.contentIndex, content: block.text, partial: output });
            }
            break;
          }
          case "reasoning-start":
            ensureReasoningBlock(part.id, part.providerMetadata);
            break;
          case "reasoning-delta": {
            const state = ensureReasoningBlock(part.id, part.providerMetadata);
            const block = output.content[state.contentIndex];
            if (block.type !== "thinking") break;
            block.thinking += part.text;
            applyReasoningMetadata(block, part.providerMetadata);
            stream.push({
              type: "thinking_delta",
              contentIndex: state.contentIndex,
              delta: part.text,
              partial: output,
            });
            break;
          }
          case "reasoning-end": {
            const state = ensureReasoningBlock(part.id, part.providerMetadata);
            if (state.ended) break;
            state.ended = true;
            const block = output.content[state.contentIndex];
            if (block.type === "thinking") {
              applyReasoningMetadata(block, part.providerMetadata);
              stream.push({
                type: "thinking_end",
                contentIndex: state.contentIndex,
                content: block.thinking,
                partial: output,
              });
            }
            break;
          }
          case "tool-input-start":
            ensureToolBlock(part.id, part.toolName);
            break;
          case "tool-input-delta": {
            const state = toolBlocks.get(part.id);
            if (!state) break;
            state.partialJson = (state.partialJson || "") + part.delta;
            const block = output.content[state.contentIndex];
            if (block.type !== "toolCall") break;
            try {
              block.arguments = JSON.parse(state.partialJson);
            } catch {
              // Keep the last complete arguments while JSON is still streaming.
            }
            stream.push({
              type: "toolcall_delta",
              contentIndex: state.contentIndex,
              delta: part.delta,
              partial: output,
            });
            break;
          }
          case "tool-call": {
            const state = ensureToolBlock(part.toolCallId, part.toolName);
            if (state.ended) break;
            state.ended = true;
            const block = output.content[state.contentIndex];
            if (block.type !== "toolCall") break;
            block.arguments = parseToolInput(part.input);
            delete state.partialJson;
            stream.push({
              type: "toolcall_end",
              contentIndex: state.contentIndex,
              toolCall: block as ToolCall,
              partial: output,
            });
            break;
          }
          case "finish":
            if (part.finishReason === "other") throw new Error("Portkey stream ended without a valid stop reason");
            finished = true;
            output.stopReason = mapFinishReason(part.finishReason);
            updateUsage(output, part.totalUsage, model);
            break;
          case "abort":
            throw new Error(part.reason || "Request was aborted");
          case "error":
            throw part.error;
          default:
            break;
        }
      }

      if (options?.signal?.aborted) throw new Error("Request was aborted");
      if (!finished) throw new Error("Portkey stream ended before completion");
      if ([...textBlocks.values(), ...reasoningBlocks.values(), ...toolBlocks.values()].some((block) => !block.ended)) {
        throw new Error("Portkey stream ended with an incomplete content block");
      }
      if (output.stopReason === "error") throw new Error("Portkey returned an error finish reason");

      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatError(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

export function createPortkeyStream(configuredHeaders: Record<string, string>) {
  return (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => streamPortkeyAws(model, context, options, configuredHeaders);
}

export default function portkeyAwsExtension(pi: ExtensionAPI): void {
  const config = readConfig(process.env.PORTKEY_CONFIG_PATH, process.env.PORTKEY_MODELS_PATH);
  const models = config.models.map((model) => ({
    id: model.id,
    name: model.name || `${model.id} (Portkey via AI SDK)`,
    reasoning: model.reasoning ?? true,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input ?? (["text", "image"] as Array<"text" | "image">),
    cost: {
      input: model.cost?.input ?? 0,
      output: model.cost?.output ?? 0,
      cacheRead: model.cost?.cacheRead ?? 0,
      cacheWrite: model.cost?.cacheWrite ?? 0,
    },
    contextWindow: model.contextWindow ?? 200_000,
    maxTokens: model.maxTokens ?? 64_000,
    headers: config.headers,
  }));

  pi.registerProvider(PROVIDER_ID, {
    name: "Portkey Bedrock (Vercel AI SDK)",
    baseUrl: config.baseUrl,
    apiKey: `$${config.apiKeyEnv}`,
    api: API_ID,
    headers: config.headers,
    models,
    streamSimple: createPortkeyStream(config.headers),
  });
}
