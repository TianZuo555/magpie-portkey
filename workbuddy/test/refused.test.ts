// WorkBuddy's refusals carry the hint the user needs: the words it turns away
// as an unapproved channel, an account it restricted, and credits used up.
import assert from "node:assert/strict";
import { test } from "node:test";
import { _internal } from "../index.ts";

const { REFUSED_HINT, RESTRICTED_HINT, EXHAUSTED_HINT, SITES, fetchFor } = _internal;

// explained is read through the fetch pi's requests go through, which is where
// a refusal is worded: a chat that WorkBuddy turns away comes back with the
// hint the user needs.
async function explained(body: string, status = 400) {
  const send = fetchFor(
    { refusedSystems: new Set(), endsAfterTools: new Set(), models: [] } as any,
    (async () => new Response(body, { status, headers: { "content-type": "application/json" } })) as typeof fetch,
    "",
  );
  return send(`${SITES.workbuddy.endpoint}/v2/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "glm-5.3", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
}

test("the refusal ends in the hint", async () => {
  const response = await explained(
    JSON.stringify({ error: { message: "Illegal API invocation from an unapproved channel", code: 11004 } }),
    403,
  );
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.message, `Illegal API invocation from an unapproved channel — ${REFUSED_HINT}`);
});

test("the hint is Magpie's word for word, and blames no one client", () => {
  assert.equal(
    REFUSED_HINT,
    "WorkBuddy refused words in this client's prompt (most often its system prompt); use it from Hermes, OpenCode or Pi, or add another provider to this group",
  );
  assert.doesNotMatch(REFUSED_HINT, /Codex|Claude/);
});

test("credits exhausted says its msg, then the exhausted hint", async () => {
  const response = await explained(JSON.stringify({ code: 14018, msg: "Credits exhausted" }), 429);
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.error.type, "insufficient_quota");
  assert.equal(body.error.code, 14018);
  assert.equal(body.error.message, `Credits exhausted — ${EXHAUSTED_HINT}`);
});

test("credits exhausted under error.data reads its msg", async () => {
  const said =
    "Credits exhausted. Please visit the link below to purchase add-on packs and get more credits: https://www.codebuddy.ai/profile/usage ";
  const response = await explained(
    JSON.stringify({ error: { data: { code: 14018, msg: said, requestId: "test-req" } } }),
    429,
  );
  assert.equal((await response.json()).error.message, `${said} — ${EXHAUSTED_HINT}`);
});

test("other errors pass as they came", async () => {
  const body = '{"error":{"message":"rate limited"}}';
  const response = await explained(body, 429);
  assert.equal(response.status, 429);
  assert.equal(await response.text(), body);
});

test("a code that only begins with 14018 passes through untouched", async () => {
  for (const body of ['{"error":{"code":140185,"message":"slow down"}}', '{"error":{"code":140185,"message":"slow do']) {
    assert.equal(await (await explained(body, 429)).text(), body);
  }
});

test("an unrelated requestId that happens to hold 14018 is left alone", async () => {
  const body = '{"error":{"message":"upstream timeout","requestId":"req-1759614018"}}';
  assert.equal(await (await explained(body, 504)).text(), body);
});

test("a restricted account's 11140 says its msg, then the restricted hint, word for word Magpie's", async () => {
  const body = `{"code":11140,"msg":"request illegal",
   "displayMsg":{"en":"Your account has been restricted due to unusual activity",
                 "zh":"账号存在异常行为，已被限制使用","zh-hant":"帳號存在異常行為，已被限制使用"},
   "displayTips":{"en":"We detected unusual activity on this account. Submit feedback to appeal this restriction"},
   "actions":["EDIT_INPUT","SUBMIT_FEEDBACK"]}`;
  const response = await explained(body, 403);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("X-Magpie-Sign-In"), "kept");
  assert.deepEqual((await response.json()).error, {
    message: `request illegal — ${RESTRICTED_HINT}`,
    type: "permission_error",
    code: 11140,
  });
  assert.equal(
    RESTRICTED_HINT,
    "WorkBuddy restricted this account for unusual activity; it stays out until WorkBuddy lifts that, which an appeal (Submit feedback in WorkBuddy) asks for",
  );
});

test("the restriction is known by a string code, under error, or by its words alone", async () => {
  for (const body of [
    '{"code":"11140","msg":"request illegal"}',
    '{"error":{"code":11140,"message":"request illegal"}}',
    '{"error":{"data":{"code":11140,"msg":"request illegal"}}}',
    '{"msg":"账号存在异常行为，已被限制使用"}',
    '{"code":11140,"msg":"request ill',
  ]) {
    const said = await (await explained(body, 403)).json();
    assert.equal(said.error.code, 11140);
    assert.ok(said.error.message.endsWith(` — ${RESTRICTED_HINT}`), body);
  }
});

test("a code that only begins with 11140, and 11128, are not a restriction", async () => {
  for (const body of ['{"code":111400,"msg":"request illegal"}', '{"error":{"code":111400,"message":"x"}}']) {
    assert.equal(await (await explained(body, 403)).text(), body);
  }
  const said = await (
    await explained('{"error":{"message":"Illegal API invocation from an unapproved channel","code":11128}}', 403)
  ).json();
  assert.ok(said.error.message.endsWith(REFUSED_HINT));
});
