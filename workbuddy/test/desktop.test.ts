// WorkBuddy desktop's own sign-in, read where the app keeps it: the plugin
// signs in with the account the app is signed in to, without anything being
// pasted or copied. The app's file is read on each request and never changed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { _internal } from "../index.ts";

const { SITES, desktopFile, readDesktop, notDesktop, desktopCredential } = _internal;

const SEALED = { $wbEncrypted: 1, envelope: "AAAA" };

interface Desktop {
  account: { uid: string; nickname?: string; phoneNumber?: string; enterpriseId?: string };
  auth: Record<string, unknown>;
}

const signedIn = (extra: Record<string, unknown> = {}): Desktop => ({
  account: { uid: "u-1", nickname: "Yirasumi" },
  auth: {
    accessToken: "desktop-access",
    refreshToken: "desktop-refresh",
    expiresAt: Date.now() + 3_600_000,
    domain: "copilot.tencent.com",
    ...extra,
  },
});

// inHome runs fn with HOME (and USERPROFILE) in an isolated folder, so that
// the app's file is this test's alone.
function inHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "workbuddy-desktop-"));
  const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    fn(home);
  } finally {
    process.env.HOME = env.HOME;
    if (env.USERPROFILE === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = env.USERPROFILE;
    rmSync(home, { recursive: true, force: true });
  }
}

function writeDesktopFile(site: string, value: unknown): string {
  const file = desktopFile(SITES[site]);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
  return file;
}

test("the app's sign-in is read where it keeps it, for each build", () => {
  // homedir() is cached by node, so the path itself is what's checked here
  const cn = desktopFile(SITES.workbuddy);
  const ai = desktopFile(SITES["workbuddy-ai"]);
  assert.match(cn, /CodeBuddyExtension\/Data\/Public\/auth\/workbuddy-desktop\.info$/);
  assert.match(ai, /CodeBuddyExtension\/Data\/Public\/auth\/workbuddy-desktop-ai\.info$/);
  assert.equal(cn.replace(/\.info$/, ""), ai.replace(/-ai\.info$/, ""));
  assert.ok(cn.startsWith(homedir()));
});

test("a desktop sign-in is a marker: the app's tokens are not stored", () => {
  inHome(() => {
    writeDesktopFile("workbuddy", signedIn());
    const credential = desktopCredential(SITES.workbuddy);
    assert.equal(credential.source, "desktop");
    assert.equal(credential.access, "");
    assert.equal(credential.refresh, "");
    assert.equal(credential.uid, "u-1");
    assert.equal(credential.accountId, "Yirasumi");
    // stored so that pi looks again later, not when the app's token ends
    assert.ok(credential.expires > Date.now());
  });
});

test("the desktop file's enterprise is kept, so a team account answers as the team", () => {
  inHome(() => {
    writeDesktopFile("workbuddy", {
      account: { uid: "u-1", enterpriseId: "ent-9" },
      auth: { accessToken: "a", expiresIn: 60 },
    });
    const credential = desktopCredential(SITES.workbuddy);
    assert.equal(credential.enterpriseId, "ent-9");
    // a token with only expiresIn is dated from now
    assert.ok(credential.expires > Date.now());
  });
});

test("an app signed out says so", () => {
  inHome(() => {
    assert.equal(readDesktop(SITES.workbuddy), null);
    assert.equal(notDesktop(SITES.workbuddy), "WorkBuddy desktop isn't signed in");
    assert.throws(() => desktopCredential(SITES.workbuddy), /desktop isn't signed in/);
  });
});

test("a file without an account, or without a token, is no sign-in", () => {
  inHome(() => {
    writeDesktopFile("workbuddy", { account: {}, auth: { accessToken: "a" } });
    assert.equal(readDesktop(SITES.workbuddy), null);
    writeDesktopFile("workbuddy", { account: { uid: "u-1" }, auth: {} });
    assert.equal(readDesktop(SITES.workbuddy), null);
  });
});

test("WorkBuddy 5.6's sealed tokens say so, and point at the browser sign-in", () => {
  inHome(() => {
    writeDesktopFile("workbuddy-ai", {
      account: { uid: "u-1" },
      auth: { accessToken: SEALED, refreshToken: SEALED },
    });
    assert.equal(readDesktop(SITES["workbuddy-ai"]), null);
    const said = notDesktop(SITES["workbuddy-ai"]);
    assert.match(said, /encrypted \(WorkBuddy 5\.6 and later\)/);
    assert.match(said, /sign in to WorkBuddy AI in the browser instead/);
    assert.throws(() => desktopCredential(SITES["workbuddy-ai"]), /encrypted/);
  });
});

test("the app's file is never written to", () => {
  inHome(() => {
    const before = JSON.stringify(signedIn());
    const file = writeDesktopFile("workbuddy", JSON.parse(before));
    desktopCredential(SITES.workbuddy);
    readDesktop(SITES.workbuddy);
    assert.equal(readFileSync(file, "utf8"), before);
  });
});

test("the desktop sign-in's headers carry the account and the app's client", () => {
  const headers = _internal.signedHeaders(SITES.workbuddy, {
    type: "oauth",
    access: "tok",
    refresh: "r",
    expires: 0,
    uid: "u-1",
    enterpriseId: "ent-9",
  });
  assert.equal(headers.Authorization, "Bearer tok");
  assert.equal(headers["X-User-Id"], "u-1");
  assert.equal(headers["X-Enterprise-Id"], "ent-9");
  assert.equal(headers["X-Tenant-Id"], "ent-9");
  assert.equal(headers["X-Agent-Purpose"], "conversation");
  assert.equal(headers["User-Agent"], "WorkBuddy/5.5.6");
  // WorkBuddy AI alone takes X-Agent-Type
  assert.equal(headers["X-Agent-Type"], undefined);
  assert.equal(
    _internal.signedHeaders(SITES["workbuddy-ai"], { type: "oauth", access: "tok", refresh: "", expires: 0 })["X-Agent-Type"],
    "main",
  );
});

test("the app's sign-in is used at once, with nothing asked", async () => {
  inHome(() => {
    writeDesktopFile("workbuddy", signedIn());
    const provider = _internal.providerFor(SITES.workbuddy, {
      refusedSystems: new Set(),
      endsAfterTools: new Set(),
      models: [],
    });
    const oauth = provider.auth.oauth!;
    assert.equal(oauth.isSubscription, true);
    assert.equal(oauth.loginLabel, "WorkBuddy account");
  });
});
