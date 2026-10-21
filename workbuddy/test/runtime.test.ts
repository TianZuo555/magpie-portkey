// The package as pi runs it: a provider registered with pi's ModelRuntime, a
// stored sign-in, and a chat asked through pi's own stream path. Nothing here
// contacts WorkBuddy: the fetch the runtime is given answers.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeContext, type CredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import extension, { _internal } from "../index.ts";

const { SITES } = _internal;

// A credential store pi's runtime can read and write, in memory.
function store(initial: Record<string, unknown> = {}): CredentialStore & { all: Record<string, any> } {
  const all: Record<string, any> = { ...(initial as any) };
  return {
    all,
    async read(id: string) {
      return all[id];
    },
    async list() {
      return Object.entries(all).map(([providerId, credential]) => ({ providerId, type: credential.type }));
    },
    async modify(id: string, fn: any) {
      const next = await fn(all[id]);
      if (next !== undefined) all[id] = next;
      return all[id];
    },
    async delete(id: string) {
      delete all[id];
    },
  };
}

const sse = (chunks: unknown[]) =>
  new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });

const text = (content: string) => [
  { id: "c1", model: "glm-5.3", choices: [{ index: 0, delta: { role: "assistant", content } }] },
  { id: "c1", model: "glm-5.3", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  {
    id: "c1",
    model: "glm-5.3",
    choices: [],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  },
];

async function runtimeWith(credentials: CredentialStore) {
  const runtime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  extension({ registerProvider: (provider: any) => runtime.registerNativeProvider(provider) } as any);
  return runtime;
}

const context = normalizeContext({
  systemPrompt: "You are helpful.",
  messages: [{ role: "user", content: "Hi", timestamp: 0 }],
});

test("a stored sign-in signs pi's requests, and the chat is read back", async () => {
  const temp = mkdtempSync(join(tmpdir(), "workbuddy-pi-"));
  try {
    writeFileSync(join(temp, "none"), "");
    const credentials = store({
      workbuddy: {
        type: "oauth",
        access: "access-token",
        refresh: "refresh-token",
        expires: Date.now() + 3_600_000,
        uid: "u-1",
        domain: "copilot.tencent.com",
      },
    });
    const runtime = await runtimeWith(credentials);
    const model = runtime.getModel("workbuddy", "glm-5.3");
    assert.ok(model, "the model is registered");

    const sent: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({
        url: String(url),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(String(init?.body)),
      });
      return sse(text("Hello 世界 🐦"));
    };
    const message = await runtime.completeSimple(model!, context, {
      fetch: fetch as typeof globalThis.fetch,
      sessionId: "session-1",
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://copilot.tencent.com/v2/chat/completions");
    assert.equal(sent[0].headers.authorization, "Bearer access-token");
    assert.equal(sent[0].headers["x-user-id"], "u-1");
    assert.equal(sent[0].headers["user-agent"], "WorkBuddy/5.5.6");
    assert.equal(sent[0].body.model, "glm-5.3");
    assert.equal(sent[0].body.max_tokens, model!.maxTokens);
    assert.equal(message.stopReason, "stop");
    assert.equal(
      message.content
        .filter((block) => block.type === "text")
        .map((block: any) => block.text)
        .join(""),
      "Hello 世界 🐦",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("without a sign-in the provider is unconfigured, and the models are pi's", async () => {
  const runtime = await runtimeWith(store());
  assert.equal(await runtime.checkAuth("workbuddy"), undefined);
  assert.equal(await runtime.checkAuth("workbuddy-ai"), undefined);
  // both builds list the models the package ships until WorkBuddy answers
  assert.ok(runtime.getModels("workbuddy").length > 0);
  assert.ok(runtime.getModels("workbuddy-ai").length > 0);
});

test("a desktop marker is read as the app's sign-in, with no token stored", async () => {
  const home = mkdtempSync(join(tmpdir(), "workbuddy-home-"));
  const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const file = _internal.desktopFile(SITES.workbuddy);
    const { mkdirSync } = await import("node:fs");
    mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        account: { uid: "u-1", nickname: "Yirasumi" },
        auth: { accessToken: "desktop-access", refreshToken: "desktop-refresh", expiresAt: Date.now() + 3_600_000 },
      }),
    );
    const credentials = store({
      workbuddy: { type: "oauth", source: "desktop", access: "", refresh: "", expires: 0, uid: "u-1" },
    });
    const runtime = await runtimeWith(credentials);
    const model = runtime.getModel("workbuddy", "glm-5.3")!;
    const sent: Array<{ headers: Record<string, string> }> = [];
    const message = await runtime.completeSimple(model, context, {
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        sent.push({ headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return sse(text("ok"));
      }) as typeof globalThis.fetch,
    });
    assert.equal(message.stopReason, "stop");
    // the app's access token signed the request, though nothing of it is stored
    assert.equal(sent[0].headers.authorization, "Bearer desktop-access");
    assert.equal(sent[0].headers["x-user-id"], "u-1");
    const stored = credentials.all.workbuddy;
    assert.equal(stored.access, "");
    assert.equal(stored.refresh, "");
    assert.equal(stored.source, "desktop");
  } finally {
    process.env.HOME = env.HOME;
    if (env.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = env.USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  }
});
