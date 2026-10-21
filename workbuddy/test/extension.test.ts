// The package as pi loads it: one extension registering both providers.
import assert from "node:assert/strict";
import { test } from "node:test";
import extension from "../index.ts";

test("the extension registers both of WorkBuddy's builds as pi providers", () => {
  const registered: any[] = [];
  const pi = {
    registerProvider(provider: any, config?: any) {
      registered.push(config ? { id: provider, config } : provider);
    },
  } as any;
  extension(pi);
  assert.deepEqual(
    registered.map((provider) => provider.id),
    ["workbuddy", "workbuddy-ai"],
  );
  for (const provider of registered) {
    // pi's native provider form: auth, models and the streams its models use
    assert.ok(provider.auth.oauth, `${provider.id} has an OAuth sign-in`);
    assert.equal(provider.auth.apiKey, undefined, `${provider.id} has no API key`);
    assert.ok(provider.getModels().length > 0);
    assert.equal(typeof provider.streamSimple, "function");
    for (const model of provider.getModels()) {
      assert.equal(model.provider, provider.id);
      assert.equal(model.api, "workbuddy-openai-completions");
      assert.ok(model.contextWindow > 0);
      assert.ok(model.maxTokens > 0);
    }
  }
  // the desktop sign-in is used at once, so the label names the account
  assert.equal(registered[0].auth.oauth.loginLabel, "WorkBuddy account");
  assert.equal(registered[0].auth.oauth.isSubscription, true);
  assert.equal(registered[1].auth.oauth.loginLabel, "WorkBuddy AI account");
});
