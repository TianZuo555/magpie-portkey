// A chat through pi's own openai-completions implementation, with the request
// mended on its way out: WorkBuddy's headers, the ids its usage list counts by,
// and the shapes its endpoint takes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { _internal } from "../index.ts";

const { SITES, signedHeaders, providerFor, fallbackModels } = _internal;

const site = SITES.workbuddy;
const runtime = () => ({ refusedSystems: new Set<string>(), endsAfterTools: new Set<string>(), models: [] }) as any;

const account = {
  type: "oauth" as const,
  access: "access-token",
  refresh: "refresh-token",
  expires: Date.now() + 3_600_000,
  uid: "u-1",
  domain: "copilot.tencent.com",
};

const model = fallbackModels(site).find((m) => m.id === "glm-5.3")!;

const context = normalizeContext({
  systemPrompt: "You are helpful.",
  messages: [{ role: "user", content: "Hello", timestamp: 0 }],
  tools: [
    {
      name: "read",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  ],
});

const sse = (chunks: unknown[]) =>
  new Response(
    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );

const answer = (toolName = "read") => [
  {
    id: "chatcmpl-1",
    model: "glm-5.3",
    choices: [{ index: 0, delta: { role: "assistant", content: "Let me " } }],
  },
  { id: "chatcmpl-1", model: "glm-5.3", choices: [{ index: 0, delta: { content: "read it." } }] },
  {
    id: "chatcmpl-1",
    model: "glm-5.3",
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: toolName, arguments: "" } }] },
      },
    ],
  },
  {
    id: "chatcmpl-1",
    model: "glm-5.3",
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] }, finish_reason: "tool_calls" }],
  },
  {
    id: "chatcmpl-1",
    model: "glm-5.3",
    choices: [],
    usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
  },
];

async function ask(options: { toolName?: string } = {}) {
  const sent: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    return sse(answer(options.toolName));
  };
  const provider = providerFor(site, runtime());
  const stream = provider.streamSimple(model, context, {
    apiKey: account.access,
    headers: signedHeaders(site, account),
    fetch: fetch as typeof globalThis.fetch,
    sessionId: "session-1",
  });
  const events = [];
  for await (const event of stream) events.push(structuredClone(event));
  return { sent, events, message: await stream.result() };
}

test("a chat goes to WorkBuddy with its headers, its ids, and pi's own shape", async () => {
  const { sent, message } = await ask();
  assert.equal(sent.length, 1);
  const [request] = sent;
  assert.equal(request.url, "https://copilot.tencent.com/v2/chat/completions");
  assert.equal(request.headers.authorization, "Bearer access-token");
  assert.equal(request.headers["x-user-id"], "u-1");
  assert.equal(request.headers["x-domain"], "copilot.tencent.com");
  assert.equal(request.headers["x-product"], "SaaS");
  assert.equal(request.headers["x-ide-type"], "WorkBuddy");
  assert.equal(request.headers["user-agent"], "WorkBuddy/5.5.6");
  assert.equal(request.headers["x-agent-purpose"], "conversation");
  assert.equal(request.headers["x-ide-name"], "WorkBuddy");
  assert.equal(request.headers["x-requested-with"], "XMLHttpRequest");

  // the ids its usage list counts by: one conversation, one turn, one message
  assert.match(request.headers["x-conversation-id"], /^[0-9a-f]{32}$/);
  assert.match(request.headers["x-conversation-request-id"], /^[0-9a-f]{32}$/);
  assert.match(request.headers["x-conversation-message-id"], /^[0-9a-f]{32}$/);
  assert.equal(request.headers["x-request-id"], request.headers["x-conversation-message-id"]);

  // the request spellings WorkBuddy's endpoint takes
  assert.equal(request.body.max_tokens, model.maxTokens);
  assert.equal(request.body.max_completion_tokens, undefined);
  assert.equal(request.body.messages[0].role, "system");
  assert.equal(request.body.messages[0].content, "You are helpful.");
  assert.equal(request.body.messages[1].role, "user");
  assert.deepEqual(
    request.body.tools.map((tool: any) => tool.function.name),
    ["read"],
  );

  // pi's own events, read from WorkBuddy's stream
  assert.equal(message.stopReason, "toolUse");
  assert.equal(message.usage.input, 12);
  assert.equal(message.usage.output, 7);
  const text = message.content.filter((block) => block.type === "text").map((block: any) => block.text).join("");
  assert.equal(text, "Let me read it.");
  const call = message.content.find((block) => block.type === "toolCall") as any;
  assert.equal(call.name, "read");
  assert.deepEqual(call.arguments, { path: "a.txt" });
});

test("a tool's call comes back under the client's own name", async () => {
  // a tool name WorkBuddy refuses is sent safe; the answer names it back
  const bad = normalizeContext({
    systemPrompt: "You are helpful.",
    messages: [{ role: "user", content: "Hello", timestamp: 0 }],
    tools: [
      {
        name: "fs.read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
  });
  const sent: any[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    return sse(answer(body.tools[0].function.name));
  };
  const provider = providerFor(site, runtime());
  const stream = provider.streamSimple(model, bad, {
    apiKey: account.access,
    headers: signedHeaders(site, account),
    fetch: fetch as typeof globalThis.fetch,
  });
  const message = await stream.result();
  assert.equal(sent[0].tools[0].function.name, "fs_read");
  const call = message.content.find((block) => block.type === "toolCall") as any;
  assert.equal(call.name, "fs.read");
});

test("a refusal says what the user can do about it", async () => {
  const fetch = async () =>
    new Response(
      JSON.stringify({ code: 14018, msg: "Credits exhausted", requestId: "x" }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  const provider = providerFor(site, runtime());
  const stream = provider.streamSimple(model, context, {
    apiKey: account.access,
    headers: signedHeaders(site, account),
    fetch: fetch as typeof globalThis.fetch,
  });
  const message = await stream.result();
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /Credits exhausted/);
  assert.match(message.errorMessage ?? "", /requires an active credit package/);
});

test("both builds are registered, with the models WorkBuddy lists", () => {
  const cn = providerFor(SITES.workbuddy, runtime());
  const ai = providerFor(SITES["workbuddy-ai"], runtime());
  assert.equal(cn.id, "workbuddy");
  assert.equal(ai.id, "workbuddy-ai");
  assert.equal(cn.name, "WorkBuddy");
  assert.equal(ai.name, "WorkBuddy AI");
  assert.ok(cn.getModels().some((m) => m.id === "glm-5.3"));
  assert.ok(ai.getModels().some((m) => m.id === "gpt-5.5"));
  // WorkBuddy AI's GLM models drop images, so pi says they are text-only
  const glm = ai.getModels().find((m) => m.id === "glm-5.3")!;
  assert.deepEqual(glm.input, ["text"]);
  const gpt = ai.getModels().find((m) => m.id === "gpt-5.5")!;
  assert.deepEqual(gpt.input, ["text", "image"]);
});
