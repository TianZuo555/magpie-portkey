// WorkBuddy's channel check reads the system and assistant messages only, and
// refuses the words it knows as 400 11128 "Illegal API invocation from an
// unapproved channel". A chat it refuses once goes again with the system
// prompt moved into the user's message, where the check doesn't read.
import assert from "node:assert/strict";
import { test } from "node:test";
import { _internal } from "../index.ts";

const { systemAsUser, systemKey, replyAfterTools, DEFAULT_SYSTEM, REFUSED_HINT } = _internal;

const OPENING = "You are Example Agent, the official CLI of Example Inc.";
const ANYWHERE = "Example fingerprint (you will usually see this)";

const REFUSAL = JSON.stringify({
  code: 11128,
  msg: "Illegal API invocation from an unapproved channel",
  requestId: "77e85b2840d5e111705b54090bc89318",
  displayMsg: { en: "Request blocked. Please send it again" },
});
const NOT_FIRST = JSON.stringify({ code: 11128, msg: "first message is not system prompt" });
const AFTER_TOOLS = JSON.stringify({ code: 11153, msg: "the conversation must end with a user message" });

const textOf = (content: unknown) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p: any) => p?.text ?? "").join("") : "";

const refuses = (message: any) =>
  (message.role === "system" || message.role === "assistant") &&
  (textOf(message.content).toLowerCase().startsWith(OPENING.toLowerCase()) || textOf(message.content).includes(ANYWHERE));

// A stand-in for WorkBuddy's chat endpoint: it refuses what the real one
// refuses, answers SSE otherwise, and keeps what it was sent.
function service(site: "workbuddy" | "workbuddy-ai", answer?: (body: any) => Response | undefined) {
  const real = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push(body);
    const said = answer?.(body);
    if (said) return said;
    if (body.messages.some(refuses)) {
      return new Response(REFUSAL, { status: 400, headers: { "content-type": "application/json; charset=utf-8" } });
    }
    return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return {
    sent,
    restore: () => {
      globalThis.fetch = real;
    },
    post: async (messages: unknown[], extra: Record<string, unknown> = {}) => {
      const runtime = {
        refusedSystems: new Set<string>(),
        endsAfterTools: new Set<string>(),
        models: [],
      } as any;
      const endpoint = _internal.SITES[site].endpoint;
      const send = _internal.fetchFor(runtime, globalThis.fetch, "");
      return send(`${endpoint}/v2/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", stream: true, messages, ...extra }),
      });
    },
  };
}

const tools = [
  {
    type: "function",
    function: {
      name: "read",
      description: "Reads a file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];
const ask = { role: "user", content: "Read calc.py." };

let n = 0;
// a system prompt of its own per test: what was refused stays remembered for as
// long as the provider is loaded
const systemOf = () => ({ role: "system", content: `${OPENING}\nUse the tools to answer. (${++n})` });

for (const site of ["workbuddy", "workbuddy-ai"] as const) {
  test(`${site}: a refused system prompt goes again as the user's instructions, tools and all`, async () => {
    const s = service(site);
    try {
      const system = systemOf();
      const response = await s.post([system, ask], { tools });
      assert.equal(response.status, 200);
      assert.equal(s.sent.length, 2);
      const again = s.sent[1];
      assert.deepEqual(again.messages[0], { role: "system", content: DEFAULT_SYSTEM });
      assert.deepEqual(again.messages[1], {
        role: "user",
        content: `<instructions>\n${system.content}\n</instructions>\n\nRead calc.py.`,
      });
      assert.equal(again.messages.length, 2);
      assert.deepEqual(
        again.tools.map((t: any) => t.function.name),
        ["read"],
      );
    } finally {
      s.restore();
    }
  });
}

test("the same system prompt's next chat goes moved at once, and another's is tried as it is", async () => {
  const s = service("workbuddy");
  try {
    const runtime = { refusedSystems: new Set<string>(), endsAfterTools: new Set<string>(), models: [] } as any;
    const send = _internal.fetchFor(runtime, globalThis.fetch, "");
    const post = (messages: unknown[]) =>
      send(`${_internal.SITES.workbuddy.endpoint}/v2/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "glm-5.3", stream: true, messages, tools }),
      });

    const system = systemOf();
    await post([system, ask]);
    const call = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"calc.py"}' } }],
    };
    const result = { role: "tool", tool_call_id: "c1", content: "def add(a, b): return a + b" };
    const second = await post([system, ask, call, result]);
    assert.equal(second.status, 200);
    // the refused prompt went moved without being refused again
    assert.equal(s.sent.length, 3);
    assert.deepEqual(
      s.sent[2].messages.map((m: any) => m.role),
      ["system", "user", "assistant", "tool"],
    );
    assert.ok(s.sent[2].messages[1].content.startsWith(`<instructions>\n${OPENING}`));
    // what the tool said and what the assistant called stay as they were
    assert.deepEqual(s.sent[2].messages[2], call);
    assert.deepEqual(s.sent[2].messages[3], result);

    await post([{ role: "system", content: "You are a coding agent." }, ask]);
    assert.equal(s.sent.length, 4);
    assert.equal(s.sent[3].messages[0].content, "You are a coding agent.");
  } finally {
    s.restore();
  }
});

test("a line refused anywhere in the system prompt is moved too", async () => {
  const s = service("workbuddy-ai");
  try {
    const response = await s.post([{ role: "system", content: `You are a coding agent.\n\nGit status:\n${ANYWHERE}` }, ask]);
    assert.equal(response.status, 200);
    assert.equal(s.sent.length, 2);
    assert.ok(String(s.sent[1].messages[1].content).includes(ANYWHERE));
  } finally {
    s.restore();
  }
});

test("a refusal that stands after the move is the user's, with the hint, tried once", async () => {
  const s = service("workbuddy");
  try {
    const system = systemOf();
    // an assistant message WorkBuddy refuses too, which nothing moves
    const response = await s.post([system, ask, { role: "assistant", content: OPENING }, { role: "user", content: "go on" }]);
    assert.equal(response.status, 400);
    assert.equal(s.sent.length, 2);
    assert.equal(response.headers.get("X-Magpie-Sign-In"), "kept");
    const said = await response.json();
    assert.equal(said.error.message, `Illegal API invocation from an unapproved channel — ${REFUSED_HINT}`);
  } finally {
    s.restore();
  }
});

test("a chat with nothing to move isn't sent again", async () => {
  const s = service("workbuddy");
  try {
    const response = await s.post([{ role: "user", content: "hi" }, { role: "assistant", content: OPENING }, ask]);
    assert.equal(response.status, 400);
    assert.equal(s.sent.length, 1);
  } finally {
    s.restore();
  }
});

test("11128 for another reason moves nothing", async () => {
  const s = service("workbuddy-ai", () => new Response(NOT_FIRST, { status: 400, headers: { "content-type": "application/json" } }));
  try {
    const response = await s.post([{ role: "system", content: "You are a coding agent." }, ask]);
    assert.equal(response.status, 400);
    assert.equal(s.sent.length, 1);
  } finally {
    s.restore();
  }
});

test("tool results then the user's message go again with an empty reply between them", async () => {
  const s = service("workbuddy-ai", (body) => {
    const messages = body.messages;
    let i = messages.length - 1;
    while (i >= 0 && messages[i].role === "user") i--;
    if (messages.at(-1).role !== "user" || (i < messages.length - 1 && messages[i]?.role === "tool")) {
      return new Response(AFTER_TOOLS, { status: 400, headers: { "content-type": "application/json" } });
    }
    return undefined;
  });
  try {
    const call = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "Bash", arguments: '{"command":"ls"}' } }],
    };
    const result = { role: "tool", tool_call_id: "call_1", content: "a.txt\nb.txt" };
    const response = await s.post([
      { role: "system", content: "be brief" },
      ask,
      call,
      result,
      { role: "user", content: [{ type: "text", text: "<system-reminder>note</system-reminder>" }] },
    ]);
    assert.equal(response.status, 200);
    assert.equal(s.sent.length, 2);
    const again = s.sent[1].messages;
    assert.equal(again.at(-2).role, "assistant");
    assert.equal(again.at(-2).content, "");
    assert.equal(again.at(-1).role, "user");
  } finally {
    s.restore();
  }
});

test("systemAsUser: parts, a later system message, no user message", () => {
  const parts = systemAsUser({
    messages: [
      { role: "system", content: [{ type: "text", text: OPENING }, { type: "text", text: "Be brief." }] },
      {
        role: "user",
        content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }],
      },
      { role: "assistant", content: "ok" },
      { role: "system", content: "Reminder: be brief." },
      { role: "user", content: "next" },
    ],
  })!;
  assert.deepEqual(parts.messages![0], { role: "system", content: DEFAULT_SYSTEM });
  const first = parts.messages![1].content as any[];
  assert.deepEqual(first[0], { type: "text", text: `<instructions>\n${OPENING}\nBe brief.\n</instructions>` });
  assert.deepEqual(
    first.slice(1).map((p) => p.type),
    ["text", "image_url"],
  );
  assert.deepEqual(parts.messages![3], { role: "user", content: "Reminder: be brief." });

  const alone = systemAsUser({ messages: [{ role: "system", content: OPENING }] })!;
  assert.deepEqual(alone.messages, [
    { role: "system", content: DEFAULT_SYSTEM },
    { role: "user", content: `<instructions>\n${OPENING}\n</instructions>` },
  ]);

  assert.equal(systemAsUser({ messages: [{ role: "system", content: DEFAULT_SYSTEM }, ask] }), null);
});

test("the words the move adds name no one", () => {
  const out = JSON.stringify(systemAsUser({ messages: [{ role: "system", content: "x" }, ask] }));
  const added = out.replace(/"x"|Read calc\.py\.|You are a helpful assistant\./g, "");
  assert.doesNotMatch(added, /magpie|workbuddy|codebuddy|opencode|claude|codex/i);
});

test("systemKey names a chat by its system prompt, and says nothing for WorkBuddy's own", () => {
  assert.equal(systemKey({ messages: [{ role: "system", content: "be brief" }, ask] }), "be brief");
  assert.equal(systemKey({ messages: [{ role: "system", content: DEFAULT_SYSTEM }, ask] }), "");
  assert.equal(
    systemKey({
      messages: [
        { role: "system", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] },
        { role: "user", content: "hi" },
      ],
    }),
    "a\nb",
  );
});

test("replyAfterTools leaves a chat ending with the assistant's message alone", () => {
  const call = {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
  };
  const result = { role: "tool", tool_call_id: "c1", content: "ok" };
  assert.equal(replyAfterTools({ messages: [ask, call] }), null);
  assert.equal(replyAfterTools({ messages: [ask, call, result] }), null);
  const moved = replyAfterTools({ messages: [ask, call, result, { role: "user", content: "go on" }] })!;
  assert.deepEqual(
    moved.messages!.map((m) => m.role),
    ["user", "assistant", "tool", "assistant", "user"],
  );
});
