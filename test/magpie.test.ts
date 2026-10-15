import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { frame, textEvents, end, type WireEvent } from "./wire.ts";

const source = process.env.MAGPIE_SOURCE_DIR;
const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("Magpie's actual Bun host: discovery, account keys, Anthropic SSE/JSON, thinking, tools and HTTP errors", { skip: !source, timeout: 60000 }, async () => {
  const temp = mkdtempSync(join(tmpdir(), "magpie-portkey-host-"));
  let events = textEvents();
  let status = 200;
  const requests: Array<{ headers: any; body: any }> = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (status !== 200) {
      res.writeHead(status, { "content-type": "application/json", "retry-after": "7" });
      res.end(JSON.stringify({ type: "throttlingException", message: "Slow down" }));
    } else {
      res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
      res.end(Buffer.concat(events.map(frame)));
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const port = (upstream.address() as { port: number }).port;
  writeFileSync(join(temp, "config.json"), JSON.stringify({
    baseUrl: `http://127.0.0.1:${port}/v1`, apiKeyEnv: "PORTKEY_TEST_UNSET_KEY", provider: "@aws-test", headers: {},
  }));
  writeFileSync(join(temp, "auth.json"), "{}");
  const child = spawn(process.env.BUN_BIN ?? "bun", [join(source!, "internal/plugin/host.js")], {
    cwd: temp,
    env: { ...process.env, PORTKEY_CONFIG_PATH: join(temp, "config.json"), PORTKEY_MODELS_PATH: join(root, "models.json"), DO_NOT_TRACK: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-16000); });
  type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; frames: any[]; timer: ReturnType<typeof setTimeout> };
  const pending = new Map<number, Pending>();
  let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const msg = JSON.parse(line);
    const call = pending.get(msg.id);
    if (!call) return;
    if (msg.event) { call.frames.push(msg); return; }
    clearTimeout(call.timer);
    pending.delete(msg.id);
    if (msg.error) call.reject(new Error(msg.error.message));
    else call.resolve({ result: msg.result, frames: call.frames });
  });
  child.on("exit", (code) => {
    for (const call of pending.values()) {
      clearTimeout(call.timer); call.reject(new Error(`Magpie host exited ${code}: ${stderr}`));
    }
    pending.clear();
  });
  function rpc(method: string, params: unknown = {}): Promise<any> {
    const key = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Magpie ${method} timed out: ${stderr}`)); }, 25000);
      pending.set(key, { resolve, reject, frames: [], timer });
      child.stdin.write(JSON.stringify({ id: key, method, params }) + "\n");
    });
  }
  const model = "us.anthropic.claude-opus-4-8";
  async function ask(body: Record<string, unknown> = {}, account?: string) {
    const response = await rpc("fetch", {
      provider: "portkey-aws", model, account, npm: "@ai-sdk/anthropic", url: "http://pi.magpie/v1/messages", method: "POST",
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify({ model, max_tokens: 1000, system: "System prompt", messages: [{ role: "user", content: "Hi" }], stream: true, ...body })).toString("base64"),
    });
    const head = response.frames.find((f: any) => f.event === "head");
    const data = Buffer.concat(response.frames.filter((f: any) => f.event === "chunk").map((f: any) => Buffer.from(f.data, "base64"))).toString();
    return { head, data };
  }
  try {
    const init = await rpc("init", { directory: temp, authPath: join(temp, "auth.json"), piPath: join(source!, "internal/plugin/pi.js"), plugins: [{ spec: root, target: root }] });
    assert.equal(init.result.plugins[0].error, undefined, init.result.plugins[0].error ?? stderr);
    assert.deepEqual(init.result.plugins[0].provides, ["portkey-aws"]);
    const { result: providers } = await rpc("providers");
    assert.equal(providers[0].models.length, 6);
    assert.ok(providers[0].models.find((m: any) => m.id === model).variants.includes("max"));
    const login = await rpc("apiKey", { provider: "portkey-aws", method: 0, key: "first-test-key" });
    assert.equal(login.result.ok, true);
    const stream = await ask();
    assert.equal(stream.head.status, 200, stream.data);
    assert.match(stream.head.headers["content-type"], /text\/event-stream/);
    assert.match(stream.data, /Hello 世界 🐦/);
    assert.match(stream.data, /message_stop/);
    assert.match(stream.data, /cache_read_input_tokens":3/);
    assert.match(stream.data, /cache_creation_input_tokens":2/);
    assert.equal(requests.at(-1)!.headers["authorization"], "Bearer first-test-key");
    assert.equal(requests.at(-1)!.headers["x-portkey-api-key"], "first-test-key");
    assert.equal(requests.at(-1)!.body.system[0].text, "System prompt");
    assert.deepEqual(requests.at(-1)!.body.system.at(-1), { cachePoint: { type: "default" } });

    const json = await ask({ stream: false });
    assert.equal(json.head.status, 200, json.data);
    assert.equal(JSON.parse(json.data).content[0].text, "Hello 世界 🐦");

    events = [
      ["messageStart", { role: "assistant" }],
      ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "Consider this" } } }],
      ["contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig-1" } } }],
      ["contentBlockStop", { contentBlockIndex: 0 }],
      ["contentBlockStart", { contentBlockIndex: 1, start: { toolUse: { toolUseId: "call_1", name: "lookup" } } }],
      ["contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '{"q":"value"}' } } }],
      ["contentBlockStop", { contentBlockIndex: 1 }], ...end("tool_use"),
    ] satisfies WireEvent[];
    const tools = await ask({ thinking: { type: "adaptive" }, output_config: { effort: "max" }, tools: [{ name: "lookup", description: "Look up", input_schema: { type: "object", properties: { q: { type: "string" } } } }] });
    assert.equal(tools.head.status, 200, tools.data);
    assert.match(tools.data, /signature_delta/);
    assert.match(tools.data, /sig-1/);
    assert.match(tools.data, /tool_use/);
    assert.match(tools.data, /input_json_delta/);
    assert.equal(requests.at(-1)!.body.toolConfig.tools[0].toolSpec.name, "lookup");
    assert.equal(requests.at(-1)!.body.additionalModelRequestFields.output_config.effort, "max");

    const second = await rpc("apiKey", { provider: "portkey-aws", method: 0, key: "second-test-key", account: "new" });
    events = textEvents();
    const secondAnswer = await ask({}, second.result.account);
    assert.equal(secondAnswer.head.status, 200, secondAnswer.data);
    assert.equal(requests.at(-1)!.headers["x-portkey-api-key"], "second-test-key");

    status = 429;
    const failure = await ask();
    assert.equal(failure.head.status, 429, failure.data);
    assert.equal(failure.head.headers["retry-after"], "7");
    assert.match(failure.data, /Slow down/);
    const auth = JSON.parse(readFileSync(join(temp, "auth.json"), "utf8"));
    assert.equal(auth["portkey-aws"].key, "first-test-key");
  } finally {
    for (const call of pending.values()) clearTimeout(call.timer);
    child.kill();
    lines.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    rmSync(temp, { recursive: true, force: true });
  }
});
