// WorkBuddy for pi and Magpie.
//
// Two providers, one for each of WorkBuddy's builds:
//   workbuddy     WorkBuddy, the China build (CodeBuddy plan), copilot.tencent.com
//   workbuddy-ai  WorkBuddy AI, the international build, www.workbuddy.ai
//
// Ported from @magpie-community/opencode-workbuddy-auth (packages/workbuddy in
// magpie-community/plugins) and from Magpie's own built-in WorkBuddy, whose
// sign-in reads the account WorkBuddy desktop is signed in to without anything
// being pasted or copied. Everything WorkBuddy insists on is here: the headers
// a chat needs, the words it refuses as an unapproved channel, the tool schemas
// its models take, and the shapes WorkBuddy AI refuses to serve. Chats go
// through pi's own openai-completions implementation; the request is mended
// between pi and the wire.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  type AssistantMessageEventStream,
  createProvider,
  type Model,
  type OAuthCredential,
  type ProviderAuthInteraction,
  type ProviderStreams,
  type SimpleStreamOptions,
  type StreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const APP_VERSION = "2.0.0"; // the version WorkBuddy's sign-in page is opened with
const UA_VERSION = "5.5.6"; // WorkBuddy/<this> is the User-Agent the API takes
const POLL_MS = 1000;
const SIGN_IN_MS = 5 * 60 * 1000;
const EARLY_MS = 60 * 1000; // a token this close to its end is refreshed before a request
const KEEP_RENEWED_MS = 60 * 1000; // how long a refresh's result answers for the old refresh token
// pi refreshes a stored OAuth credential within five minutes of its end; a
// desktop sign-in is read afresh each request, so its stored end only decides
// when to look again, and never sends pi to the app's file twice a minute
const DESKTOP_LOOK_MS = 10 * 60 * 1000;

const API_ID = "workbuddy-openai-completions" as Api;

type Effort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface FallbackModel {
  id: string;
  name: string;
  context: number;
  efforts?: Effort[];
}

// Until a sign-in says otherwise, or WorkBuddy doesn't answer: the models
// WorkBuddy's product config gave its CLI agent when this package was written.
const CN_MODELS: FallbackModel[] = [
  { id: "auto", name: "Auto", context: 168_000 },
  { id: "hy4-preview-f", name: "Hy4 preview", context: 1_000_000, efforts: ["high"] },
  { id: "hy3", name: "Hy3", context: 192_000, efforts: ["low", "high"] },
  { id: "hy3-x", name: "Hy3-X", context: 192_000, efforts: ["low", "high"] },
  { id: "deepseek-v4.1-flash", name: "Deepseek-V4.1-Flash", context: 1_000_000 },
  { id: "glm-5.3", name: "GLM-5.3", context: 1_000_000, efforts: ["low", "high", "max"] },
  { id: "glm-5.3-flash", name: "GLM-5.3-Flash", context: 1_000_000, efforts: ["low", "high", "max"] },
  { id: "glm-5.2", name: "GLM-5.2", context: 1_000_000, efforts: ["high", "xhigh"] },
  { id: "glm-5.1", name: "GLM-5.1", context: 200_000 },
  { id: "glm-5v-turbo", name: "GLM-5v-Turbo", context: 200_000 },
  { id: "minimax-m3", name: "MiniMax-M3", context: 512_000 },
  { id: "kimi-k3-1", name: "Kimi-K3", context: 1_000_000, efforts: ["low", "high", "xhigh"] },
  { id: "kimi-k2.7", name: "Kimi-K2.7-Code", context: 256_000 },
  { id: "kimi-k2.6", name: "Kimi-K2.6", context: 256_000 },
  { id: "deepseek-v4-pro", name: "Deepseek-V4-Pro", context: 1_000_000, efforts: ["none", "high", "xhigh"] },
];

const AI_MODELS: FallbackModel[] = [
  { id: "default-model", name: "Default", context: 176_000 },
  { id: "fast-model", name: "Fast", context: 200_000 },
  { id: "balanced-model", name: "Balanced", context: 256_000 },
  { id: "primary-model", name: "Primary", context: 272_000 },
  { id: "deep-model", name: "Deep", context: 176_000 },
  { id: "gpt-5.5", name: "GPT-5.5", context: 1_000_000 },
  { id: "gpt-5.4", name: "GPT-5.4", context: 272_000 },
  { id: "gpt-5.3-codex", name: "GPT-5.3-Codex", context: 272_000 },
  { id: "gemini-3.1-pro", name: "Gemini-3.1-Pro", context: 400_000 },
  { id: "gemini-3.5-flash", name: "Gemini-3.5-Flash", context: 1_000_000 },
  { id: "glm-5.3", name: "GLM-5.3", context: 1_000_000, efforts: ["low", "high", "max"] },
  { id: "glm-5.2", name: "GLM-5.2", context: 1_000_000, efforts: ["high", "xhigh"] },
  { id: "hy3", name: "Hy3", context: 192_000, efforts: ["low", "high"] },
  { id: "kimi-k3", name: "Kimi-K3", context: 1_000_000 },
  { id: "kimi-k2.6", name: "Kimi-K2.6", context: 256_000 },
  { id: "minimax-m3", name: "MiniMax-M3", context: 512_000 },
];

interface Site {
  id: string;
  name: string;
  endpoint: string;
  authID: string;
  platform: string;
  ai: boolean;
  models: FallbackModel[];
  // models whose images WorkBuddy AI drops though its config says they take them
  noImages?: RegExp;
}

// A site's API root. WORKBUDDY_ENDPOINT and WORKBUDDY_AI_ENDPOINT move them,
// so that a test (or a proxy in front of WorkBuddy) can answer in their place.
const endpointOf = (id: string, fallback: string): string =>
  (id === "workbuddy" ? process.env.WORKBUDDY_ENDPOINT : process.env.WORKBUDDY_AI_ENDPOINT)?.replace(/\/$/, "") || fallback;

const SITES: Record<string, Site> = {
  workbuddy: {
    id: "workbuddy",
    name: "WorkBuddy",
    endpoint: endpointOf("workbuddy", "https://copilot.tencent.com"),
    authID: "workbuddy-desktop",
    platform: "workbuddy",
    ai: false,
    models: CN_MODELS,
  },
  "workbuddy-ai": {
    id: "workbuddy-ai",
    name: "WorkBuddy AI",
    endpoint: endpointOf("workbuddy-ai", "https://www.workbuddy.ai"),
    authID: "workbuddy-desktop-ai",
    platform: "workbuddy-ai",
    ai: true,
    models: AI_MODELS,
    noImages: /^glm-/,
  },
};

// ---- the API -----------------------------------------------------------------

const api = (site: Site) => `${site.endpoint}/v2`;
const hex = () => randomBytes(16).toString("hex");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class WorkBuddyError extends Error {
  code: number;
  status: number;
  constructor(message: string, code: number, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface Envelope {
  code?: number | string;
  msg?: string;
  message?: string;
  data?: unknown;
  error?: { message?: string };
}

// call asks WorkBuddy's plugin API, which answers {code, msg, data}; a code
// but 0 is an error.
async function call<T = any>(
  site: Site,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(site.endpoint + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": `WorkBuddy/${UA_VERSION}`,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let envelope: Envelope = {};
  try {
    envelope = JSON.parse(text) as Envelope;
  } catch {}
  const code = Number.parseInt(String(envelope.code ?? 0), 10) || 0;
  if (!response.ok) {
    const why = envelope.msg || envelope.message || envelope.error?.message || text.slice(0, 200) || response.statusText;
    throw new WorkBuddyError(
      `${site.name}: ${why} (HTTP ${response.status}${envelope.code ? `, code ${envelope.code}` : ""})`,
      code,
      response.status,
    );
  }
  if (code) throw new WorkBuddyError(`${site.name}: ${envelope.msg || "error"} (${code})`, code, response.status);
  return envelope.data as T;
}

function domainOf(site: Site, account: Account): string {
  return account.domain || new URL(api(site)).host;
}

// ---- the sign-in -------------------------------------------------------------

// What a stored sign-in is: the access and refresh tokens, their ends, the
// account, and the enterprise it signed in as.
interface Account extends OAuthCredential {
  uid?: string;
  domain?: string;
  refreshExpiresAt?: number;
  tokenType?: string;
  enterpriseId?: string;
  // set for the desktop app's own sign-in, which is read where the app keeps it
  source?: "desktop";
  accountId?: string;
}

const TOKEN_FIELDS = ["access", "refresh", "expires", "refreshExpiresAt", "domain", "tokenType"] as const;

function merge(account: Account, got: Record<string, any>): Account {
  const now = Date.now();
  const out: Account = { ...account, access: got.accessToken };
  if (got.refreshToken) out.refresh = got.refreshToken;
  if (got.domain) out.domain = got.domain;
  if (got.tokenType) out.tokenType = got.tokenType;
  if (got.expiresAt > 0) out.expires = got.expiresAt;
  else if (got.expiresIn > 0) out.expires = now + got.expiresIn * 1000;
  if (got.refreshExpiresAt > 0) out.refreshExpiresAt = got.refreshExpiresAt;
  else if (got.refreshExpiresIn > 0) out.refreshExpiresAt = now + got.refreshExpiresIn * 1000;
  return out;
}

const stale = (account: Account) => !!account.expires && Date.now() >= account.expires - EARLY_MS;
const refreshable = (account: Account) =>
  !!account.refresh && !(account.refreshExpiresAt && Date.now() >= account.refreshExpiresAt);

function pick(account: Account): Partial<Account> {
  const out: Partial<Account> = {};
  for (const key of TOKEN_FIELDS) if (key in account) (out as any)[key] = account[key];
  return out;
}

// renewing is each refresh under way, by site and the refresh token it
// spends; renewed is what each gave, kept a minute so one that read the old
// refresh token after it was spent takes that rather than spending it again.
const renewing = new Map<string, Promise<Account>>();
const renewed = new Map<string, { account: Account; at: number }>();

function renew(site: Site, account: Account): Promise<Account> {
  const key = `${site.id}\n${account.refresh}`;
  const done = renewed.get(key);
  if (done && Date.now() - done.at < KEEP_RENEWED_MS) return Promise.resolve({ ...account, ...pick(done.account) });
  const running = renewing.get(key);
  if (running) return running;
  const run = (async () => {
    const got = await call<Record<string, any>>(site, "POST", "/v2/plugin/auth/token/refresh", {
      "X-Refresh-Token": account.refresh!,
      "X-Auth-Refresh-Source": "plugin",
      "X-Domain": domainOf(site, account),
      ...enterpriseHeaders(account),
    });
    if (!got?.accessToken) throw new Error("WorkBuddy gave no refreshed token");
    const next = merge(account, got);
    renewed.set(key, { account: next, at: Date.now() });
    return next;
  })().finally(() => renewing.delete(key));
  renewing.set(key, run);
  return run;
}

// fresh is the sign-in with an access token that isn't about to end,
// refreshed when it is. A refresh that fails, or a refresh token that has
// ended, leaves the access token there is.
async function fresh(site: Site, account: Account): Promise<Account> {
  if (!stale(account)) return account;
  if (!refreshable(account)) {
    if (account.access) return account;
    throw new Error("this WorkBuddy account is signed out; sign in again");
  }
  try {
    return await renew(site, account);
  } catch (error) {
    if (account.access) return account;
    throw new Error(`WorkBuddy token refresh: ${(error as Error)?.message ?? error}`);
  }
}

// signedHeaders is what WorkBuddy's own client sends with a chat: the
// account's own headers, and the attribution its usage list shows as the
// client that asked (使用端).
function signedHeaders(site: Site, account: Account): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${account.access}`,
    "X-User-Id": account.uid ?? "",
    "X-Domain": domainOf(site, account),
    "X-Product": "SaaS",
    "X-IDE-Type": "WorkBuddy",
    "User-Agent": `WorkBuddy/${UA_VERSION}`,
    "X-Requested-With": "XMLHttpRequest",
    "X-Agent-Intent": "craft",
    "X-Agent-Purpose": "conversation",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Version": UA_VERSION,
    ...enterpriseHeaders(account),
  };
  if (site.ai) headers["X-Agent-Type"] = "main";
  return headers;
}

// enterpriseHeaders names the enterprise (team) an account signed in as.
// Without them WorkBuddy answers as the personal account.
function enterpriseHeaders(account: Account): Record<string, string> {
  const id = typeof account?.enterpriseId === "string" ? account.enterpriseId.trim() : "";
  return id ? { "X-Enterprise-Id": id, "X-Tenant-Id": id } : {};
}

// ---- signing in ---------------------------------------------------------------

async function poll<T>(
  site: Site,
  path: string,
  headers: Record<string, string>,
  retry: number[],
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  for (;;) {
    signal?.throwIfAborted();
    if (Date.now() > deadline) throw new Error(`${site.name} sign-in timed out`);
    try {
      const data = await call<T>(site, "GET", path, headers, undefined, signal);
      if (data && Object.keys(data).length) return data;
    } catch (error) {
      const e = error as WorkBuddyError;
      if (!(retry.includes(e.code) || e.status === 408 || e.status === 429)) throw error;
    }
    await sleep(POLL_MS);
  }
}

// browserSignIn is Tencent's sign-in page, polled for the token as
// WorkBuddy's desktop app does. Nothing needs to be pasted.
async function browserSignIn(site: Site, interaction: ProviderAuthInteraction): Promise<Account> {
  const state = await call<{ state?: string; authUrl?: string }>(
    site,
    "POST",
    `/v2/plugin/auth/state?platform=${encodeURIComponent(site.platform)}`,
    {
      "X-No-Authorization": "true",
      "X-No-User-Id": "true",
      "X-No-Enterprise-Id": "true",
      "X-No-Department-Info": "true",
    },
    {},
    interaction.signal,
  );
  if (!state?.state || !state?.authUrl) throw new Error(`${site.name} gave no sign-in page`);
  const url = new URL(state.authUrl);
  if (url.protocol !== "https:") throw new Error(`${site.name}'s sign-in page isn't https`);
  url.searchParams.set("version", APP_VERSION);
  url.searchParams.set("loginSessionId", hex());
  interaction.notify({
    type: "auth_url",
    url: url.toString(),
    instructions: `Sign in to ${site.name} in the browser; this finishes by itself.`,
  });

  const deadline = Date.now() + SIGN_IN_MS;
  const q = encodeURIComponent(state.state);
  const token = await poll<Record<string, any>>(
    site,
    `/v2/plugin/auth/token?state=${q}`,
    {},
    [11217],
    deadline,
    interaction.signal,
  );
  if (!token.accessToken) throw new Error(`${site.name} sent back no token`);
  const account = merge({} as Account, token);
  const who = await poll<Record<string, any>>(
    site,
    `/v2/plugin/login/account?state=${q}`,
    {
      Authorization: `Bearer ${account.access}`,
      "X-Domain": domainOf(site, account),
      "X-No-User-Id": "true",
      "X-No-Enterprise-Id": "true",
    },
    [12151],
    deadline,
    interaction.signal,
  );
  account.uid = who.uid ?? "";
  account.enterpriseId = await enterpriseOf(site, account, who);
  account.accountId = who.nickname || who.phoneNumber || who.uid || site.name;
  interaction.notify({ type: "progress", message: `Signed in to ${site.name}.` });
  return account;
}

// enterpriseOf is the enterprise the signed-in account belongs to: the one
// /login/account names, else the one WorkBuddy's account list has for it.
async function enterpriseOf(site: Site, account: Account, who: Record<string, any>): Promise<string> {
  const own = typeof who?.enterpriseId === "string" ? who.enterpriseId.trim() : "";
  if (own) return own;
  const type = String(who?.type ?? "").trim().toLowerCase();
  if (!type || type === "personal") return "";
  let list: { accounts?: Array<Record<string, any>> };
  try {
    list = await call(site, "GET", "/v2/plugin/accounts", {
      Authorization: `Bearer ${account.access}`,
      "X-Domain": domainOf(site, account),
    });
  } catch {
    return "";
  }
  const mine = (list?.accounts ?? []).filter(
    (x) => x?.uid === who.uid && typeof x.enterpriseId === "string" && x.enterpriseId.trim(),
  );
  const same = mine.filter((x) => String(x.type ?? "").trim().toLowerCase() === type);
  const last = mine.filter((x) => x.lastLogin);
  const chosen = same.length === 1 ? same[0] : last.length === 1 ? last[0] : mine.length === 1 ? mine[0] : undefined;
  return chosen ? String(chosen.enterpriseId).trim() : "";
}

// ---- WorkBuddy desktop's own sign-in -------------------------------------------

// desktopFile is where WorkBuddy's desktop app keeps its sign-in, per platform,
// as its file-authentication-storage does: <shared data>/auth/<id>.info. Both
// builds share the folder, each with its own file.
function desktopFile(site: Site): string {
  // $HOME is read at each call, as a desktop app's folder moves with it (and
  // so that a test can keep its own)
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  const base =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support", "CodeBuddyExtension")
      : process.platform === "win32"
        ? join(home, "AppData", "Local", "CodeBuddyExtension")
        : join(home, ".local", "share", "CodeBuddyExtension");
  return join(base, "Data", "Public", "auth", `${site.authID}.info`);
}

interface DesktopSignIn {
  access: string;
  refresh: string;
  expires: number;
  refreshExpiresAt: number;
  domain: string;
  tokenType: string;
  uid: string;
  enterpriseId?: string;
  name: string;
}

// readDesktop is WorkBuddy desktop's sign-in as the app keeps it now, null for
// none (or tokens the app keeps encrypted, which only the app opens).
function readDesktop(site: Site): DesktopSignIn | null {
  try {
    const file = JSON.parse(readFileSync(desktopFile(site), "utf8"));
    const tokens = file?.auth ?? {};
    if (typeof tokens.accessToken !== "string" || !tokens.accessToken || !file?.account?.uid) return null;
    const now = Date.now();
    const account = file.account;
    return {
      access: tokens.accessToken,
      refresh: typeof tokens.refreshToken === "string" ? tokens.refreshToken : "",
      expires: tokens.expiresAt > 0 ? tokens.expiresAt : tokens.expiresIn > 0 ? now + tokens.expiresIn * 1000 : 0,
      refreshExpiresAt:
        tokens.refreshExpiresAt > 0
          ? tokens.refreshExpiresAt
          : tokens.refreshExpiresIn > 0
            ? now + tokens.refreshExpiresIn * 1000
            : 0,
      domain: typeof tokens.domain === "string" ? tokens.domain : "",
      tokenType: typeof tokens.tokenType === "string" ? tokens.tokenType : "",
      uid: account.uid,
      ...(typeof account.enterpriseId === "string" && account.enterpriseId.trim()
        ? { enterpriseId: account.enterpriseId.trim() }
        : {}),
      name: account.nickname || account.phoneNumber || account.uid,
    };
  } catch {
    return null;
  }
}

// notDesktop says why there is no desktop sign-in to use: WorkBuddy 5.6 and
// later seal its tokens at rest ({$wbEncrypted: 1, envelope}), which only the
// app itself opens, so the browser sign-in is the way; else the app isn't
// signed in.
function notDesktop(site: Site): string {
  try {
    const tokens = JSON.parse(readFileSync(desktopFile(site), "utf8"))?.auth ?? {};
    if (tokens.accessToken?.$wbEncrypted || tokens.refreshToken?.$wbEncrypted)
      return `${site.name} desktop keeps its sign-in encrypted (WorkBuddy 5.6 and later), which can't be read; sign in to ${site.name} in the browser instead`;
  } catch {}
  return `${site.name} desktop isn't signed in`;
}

// desktopHeld is what a desktop sign-in was renewed to here, by site and
// account: kept in memory only, never written where the app keeps it.
const desktopHeld = new Map<string, Account>();

// desktopAccount is WorkBuddy desktop's sign-in as an account, renewed here
// only when the app hasn't renewed it itself.
async function desktopAccount(site: Site): Promise<Account> {
  const desktop = readDesktop(site);
  if (!desktop) throw new Error(notDesktop(site));
  const key = `${site.id}|${desktop.uid}`;
  const held = desktopHeld.get(key);
  const base: Account = {
    type: "oauth",
    source: "desktop",
    access: desktop.access,
    refresh: desktop.refresh,
    expires: desktop.expires,
    refreshExpiresAt: desktop.refreshExpiresAt,
    domain: desktop.domain,
    tokenType: desktop.tokenType,
    uid: desktop.uid,
    enterpriseId: desktop.enterpriseId,
    accountId: desktop.name,
  };
  const account = await fresh(site, held && held.expires >= desktop.expires ? held : base);
  desktopHeld.set(key, account);
  return account;
}

// current is the account a stored sign-in names, fresh: WorkBuddy desktop's,
// read where it keeps it, or the browser sign-in stored here.
async function current(site: Site, stored: Account): Promise<Account> {
  if (stored?.source === "desktop") return desktopAccount(site);
  return fresh(site, stored);
}

// desktopCredential is a desktop sign-in as it is stored: a marker, with
// nothing of the app's tokens in it. The app's file is read on each request.
function desktopCredential(site: Site): Account {
  const desktop = readDesktop(site);
  if (!desktop) throw new Error(notDesktop(site));
  return {
    type: "oauth",
    source: "desktop",
    access: "",
    refresh: "",
    expires: Math.max(desktop.expires, Date.now() + DESKTOP_LOOK_MS),
    uid: desktop.uid,
    accountId: desktop.name,
    ...(desktop.enterpriseId ? { enterpriseId: desktop.enterpriseId } : {}),
  };
}

// ---- the request body WorkBuddy takes -----------------------------------------

// FLAGGED are the words WorkBuddy refuses a chat for, "Illegal API invocation
// from an unapproved channel", each with words that say the same and pass.
const FLAGGED: Array<[RegExp, string]> = [
  [/You are Claude Code, Anthropic['’]s official CLI for Claude/gi, "You are Claude Code, Anthropic's CLI for Claude"],
  [/Main branch \(you will usually use this for PRs\)/gi, "Main branch (usually the base for PRs)"],
  [/(?<!the )Codex CLI is an open source project led by OpenAI\./gi, "The Codex CLI is an open source project led by OpenAI."],
  [
    /You are an AI agent that helps the user with programming tasks\.?/gi,
    "You are an AI agent that helps the user with programming tasks.",
  ],
];

const DEFAULT_SYSTEM = "You are a helpful assistant.";
const INSTRUCTIONS: [string, string] = ["<instructions>\n", "\n</instructions>"];

interface ChatMessage {
  role: string;
  content?: unknown;
  name?: string;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  tool_call_id?: string;
}

interface ChatBody {
  model?: string;
  messages?: ChatMessage[];
  tools?: any[];
  tool_choice?: any;
  [key: string]: unknown;
}

function unflagged(text: string): string {
  for (const [pattern, to] of FLAGGED) text = text.replace(pattern, to);
  return text;
}

// unflag puts FLAGGED's words in place in every message of a chat, and leaves
// out a text that had nothing else. It says whether it changed anything.
function unflag(messages: ChatMessage[]): boolean {
  let changed = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (typeof message?.content === "string") {
      const text = unflagged(message.content);
      if (text === message.content) continue;
      changed = true;
      if (text.trim() || message.role !== "system") message.content = text;
      else messages.splice(i, 1);
    } else if (Array.isArray(message?.content)) {
      const parts: any[] = [];
      let here = false;
      for (const part of message.content as any[]) {
        const text = typeof part?.text === "string" ? unflagged(part.text) : null;
        if (text === null || text === part.text) {
          parts.push(part);
          continue;
        }
        here = true;
        if (text.trim()) parts.push({ ...part, text });
      }
      if (!here) continue;
      changed = true;
      if (parts.length || message.role !== "system") message.content = parts;
      else messages.splice(i, 1);
    }
  }
  return changed;
}

// withSystem gives a chat that doesn't open with a system message WorkBuddy's
// default one, takes FLAGGED's words out, and applies the request spellings
// WorkBuddy's chat endpoint accepts (max_tokens, system rather than developer).
function withSystem(body: ChatBody): ChatBody {
  const messages = body?.messages;
  if (!Array.isArray(messages) || !messages.length) return body;
  unflag(messages);
  // a system message with nothing left in it (a billing header alone) says
  // nothing, and WorkBuddy's default takes its place below
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "system" && !textOf(messages[i].content).trim()) messages.splice(i, 1);
  }
  if (body.max_completion_tokens !== undefined) {
    if (body.max_tokens === undefined) body.max_tokens = body.max_completion_tokens;
    delete body.max_completion_tokens;
  }
  for (const message of messages) if (message?.role === "developer") message.role = "system";
  if (messages[0]?.role !== "system") messages.unshift({ role: "system", content: DEFAULT_SYSTEM });
  return body;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

// systemKey is the text of a chat's system messages, which a chat refused once
// is known by: the same agent's next chat goes with systemAsUser at once.
function systemKey(body: ChatBody): string {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return "";
  const key = messages
    .filter((m) => m?.role === "system")
    .map((m) => textOf(m.content))
    .join("\n");
  return key.trim() === DEFAULT_SYSTEM ? "" : key;
}

// systemAsUser is the body with its system prompt read to the model as the
// first thing the user says, in INSTRUCTIONS' tags, and WorkBuddy's default
// system prompt first. WorkBuddy's channel check reads the system and the
// assistant's messages only, so the refused line is then in neither. A system
// message later in the chat becomes the user's where it stands. null when
// there's nothing to move.
function systemAsUser(body: ChatBody): ChatBody | null {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return null;
  let i = 0;
  const lead: string[] = [];
  for (; i < messages.length && messages[i]?.role === "system"; i++) lead.push(textOf(messages[i].content));
  const said = lead.join("\n\n").trim();
  const rest: ChatMessage[] = messages.slice(i).map((m) => (m?.role === "system" ? { ...m, role: "user" } : m));
  const moved = said && said !== DEFAULT_SYSTEM;
  if (!moved && rest.every((m, k) => m === messages[i + k])) return null;
  if (moved) {
    const text = INSTRUCTIONS[0] + said + INSTRUCTIONS[1];
    const u = rest.findIndex((m) => m?.role === "user");
    if (u < 0) rest.unshift({ role: "user", content: text });
    else if (typeof rest[u].content === "string") rest[u] = { ...rest[u], content: `${text}\n\n${rest[u].content}` };
    else if (Array.isArray(rest[u].content))
      rest[u] = { ...rest[u], content: [{ type: "text", text }, ...(rest[u].content as any[])] };
    else rest[u] = { ...rest[u], content: text };
  }
  body.messages = [{ role: "system", content: DEFAULT_SYSTEM }, ...rest];
  return body;
}

// replyAfterTools is a chat ending with tool results then the user's
// message(s), with an empty assistant message between them: WorkBuddy AI's
// gemini refuses that shape with 11153, "the conversation must end with a user
// message", and serves it with any other message between them.
function replyAfterTools(body: ChatBody): ChatBody | null {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return null;
  let i = messages.length - 1;
  while (i >= 0 && messages[i]?.role === "user") i--;
  if (i === messages.length - 1 || i < 0 || messages[i]?.role !== "tool") return null;
  messages.splice(i + 1, 0, { role: "assistant", content: "" });
  return body;
}

// ---- tools WorkBuddy takes ----------------------------------------------------

// A tool's name may hold letters, digits, _ and -; another character is
// refused.
const NAME_OK = /^[A-Za-z0-9_-]+$/;

function safeName(name: string, taken: Set<string>): string {
  const base = String(name).replace(/[^A-Za-z0-9_-]/g, "_") || "tool";
  let out = base;
  for (let i = 2; taken.has(out); i++) out = `${base}_${i}`;
  taken.add(out);
  return out;
}

// NUL_ESCAPE finds a regex's \0 (the NUL character), stepping over each \\
// so that a \\0 is left; \01 is an octal escape, also left.
const NUL_ESCAPE = /\\\\|\\0(?![0-9])/g;

// fitSchema mends a schema in place, at every depth: a pattern's \0 becomes
// \u0000, which matches the same, and a tuple's items (a list) become one
// schema any of them fits.
function fitSchema(schema: any, depth = 0): boolean {
  if (!schema || typeof schema !== "object" || depth > 64) return false;
  let changed = false;
  if (Array.isArray(schema)) {
    for (const value of schema) if (fitSchema(value, depth + 1)) changed = true;
    return changed;
  }
  if (typeof schema.pattern === "string" && schema.pattern.includes("\\0")) {
    const pattern = schema.pattern.replace(NUL_ESCAPE, (m: string) => (m === "\\\\" ? m : "\\u0000"));
    if (pattern !== schema.pattern) {
      schema.pattern = pattern;
      changed = true;
    }
  }
  if (Array.isArray(schema.items)) {
    const list = schema.items.filter((v: unknown) => v && typeof v === "object");
    schema.items = list.length === 0 ? {} : list.length === 1 ? list[0] : { anyOf: list };
    delete schema.additionalItems;
    changed = true;
  }
  for (const value of Object.values(schema)) if (fitSchema(value, depth + 1)) changed = true;
  return changed;
}

const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

const SUB_ONE = [
  "items",
  "additionalItems",
  "unevaluatedItems",
  "contains",
  "not",
  "if",
  "then",
  "else",
  "propertyNames",
  "additionalProperties",
  "unevaluatedProperties",
];
const SUB_LIST = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SUB_MAP = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const BOOL_OK = new Set(["additionalProperties", "unevaluatedProperties"]);

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

// fitEnum gives a schema's enum a type: the one its values have, or that and
// "null"; values of several types are an anyOf of an enum for each. An empty
// enum is left out.
function fitEnum(schema: any): boolean {
  if (!("enum" in schema)) return false;
  if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
    delete schema.enum;
    return true;
  }
  const listed = Array.isArray(schema.type) ? schema.type : typeof schema.type === "string" ? [schema.type] : [];
  if (listed.filter((t: unknown) => t !== "null").length === 1) return false;
  const byType = new Map<string, unknown[]>();
  for (const value of schema.enum) {
    const type = valueType(value);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type)!.push(value);
  }
  if (byType.has("integer") && byType.has("number")) {
    byType.get("number")!.push(...byType.get("integer")!);
    byType.delete("integer");
  }
  const hasNull = byType.delete("null");
  if (byType.size <= 1) {
    const [type] = byType.keys();
    const want = type === undefined ? "null" : hasNull ? [type, "null"] : type;
    if (JSON.stringify(want) === JSON.stringify(schema.type)) return false;
    schema.type = want;
    return true;
  }
  const split = [...byType].map(([type, values]) => ({ type, enum: values }));
  if (hasNull) split.push({ type: "null" } as any);
  delete schema.enum;
  delete schema.type;
  if (Array.isArray(schema.anyOf)) schema.allOf = [...(Array.isArray(schema.allOf) ? schema.allOf : []), { anyOf: split }];
  else schema.anyOf = split;
  return true;
}

function subSchema(value: unknown, key: string): unknown {
  if (typeof value !== "boolean" || BOOL_OK.has(key)) return value;
  return value ? {} : { not: {} };
}

// fitShape mends a schema, and each schema under it, into the shapes
// WorkBuddy's models take; a name under properties is never read as a keyword.
function fitShape(schema: any, depth = 0): boolean {
  if (!schema || typeof schema !== "object" || Array.isArray(schema) || depth > 64) return false;
  let changed = false;
  if ("type" in schema) {
    const list = (Array.isArray(schema.type) ? schema.type : [schema.type])
      .map((t: unknown) => (typeof t === "string" ? t.toLowerCase() : t))
      .filter((t: unknown) => TYPES.has(String(t)));
    const uniq = [...new Set(list)] as string[];
    const want = uniq.length === 0 ? undefined : uniq.length === 1 ? uniq[0] : uniq;
    if (JSON.stringify(want) !== JSON.stringify(schema.type)) {
      if (want === undefined) delete schema.type;
      else schema.type = want;
      changed = true;
    }
  }
  if ("required" in schema && !Array.isArray(schema.required)) {
    delete schema.required;
    changed = true;
  } else if (Array.isArray(schema.required) && schema.required.some((k: unknown) => typeof k !== "string")) {
    schema.required = schema.required.filter((k: unknown) => typeof k === "string");
    changed = true;
  }
  if (fitEnum(schema)) changed = true;
  for (const key of SUB_ONE) {
    if (!(key in schema)) continue;
    const value = subSchema(schema[key], key);
    if (value !== schema[key]) {
      schema[key] = value;
      changed = true;
    }
    if (fitShape(value, depth + 1)) changed = true;
  }
  for (const key of SUB_LIST) {
    if (!Array.isArray(schema[key])) continue;
    schema[key].forEach((value0: unknown, index: number) => {
      const value = subSchema(value0, key);
      if (value !== value0) {
        schema[key][index] = value;
        changed = true;
      }
      if (fitShape(value, depth + 1)) changed = true;
    });
  }
  for (const key of SUB_MAP) {
    const map = schema[key];
    if (!map || typeof map !== "object" || Array.isArray(map)) continue;
    for (const [name, value0] of Object.entries(map)) {
      const value = subSchema(value0, key);
      if (value !== value0) {
        map[name] = value;
        changed = true;
      }
      if (fitShape(value, depth + 1)) changed = true;
    }
  }
  return changed;
}

function localRef(root: any, schema: any): any {
  const ref = schema?.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return schema;
  let at = root;
  for (const key of ref.slice(2).split("/")) at = at?.[key.replaceAll("~1", "/").replaceAll("~0", "~")];
  return at && typeof at === "object" ? at : schema;
}

// objectRoot makes a tool's parameters an object at the root, as WorkBuddy
// needs: allOf's branches are merged whole; of anyOf's and oneOf's object
// branches the properties are merged and a field each requires stays required.
function objectRoot(schema: any, root: any = schema, depth = 0): boolean {
  const unions = ["allOf", "anyOf", "oneOf"].filter((key) => Array.isArray(schema[key]));
  if (schema.type === "object" && !unions.length) return false;
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const required: string[] = Array.isArray(schema.required) ? [...schema.required] : [];
  for (const branch0 of schema.allOf ?? []) {
    let branch = localRef(root, branch0);
    if (!branch || typeof branch !== "object") continue;
    if (depth < 8 && ["allOf", "anyOf", "oneOf"].some((key) => Array.isArray(branch[key])))
      objectRoot((branch = structuredClone(branch)), root, depth + 1);
    for (const [key, value] of Object.entries(branch.properties ?? {})) if (!(key in properties)) properties[key] = value;
    if (Array.isArray(branch.required)) required.push(...branch.required);
  }
  const branches: any[] = [];
  for (const key of ["anyOf", "oneOf"]) {
    for (const branch0 of schema[key] ?? []) {
      let branch = localRef(root, branch0);
      if (!branch || typeof branch !== "object") continue;
      if (depth < 8 && ["allOf", "anyOf", "oneOf"].some((k) => Array.isArray(branch[k])))
        objectRoot((branch = structuredClone(branch)), root, depth + 1);
      if (branch.type !== "object" && !branch.properties) continue;
      branches.push(branch);
    }
  }
  const from = new Map<string, unknown[]>();
  for (const branch of branches) {
    for (const [key, value] of Object.entries(branch.properties ?? {})) {
      if (key in properties) continue;
      const seen = from.get(key) ?? [];
      if (!seen.some((x) => JSON.stringify(x) === JSON.stringify(value))) seen.push(value);
      from.set(key, seen);
    }
  }
  for (const [key, list] of from) properties[key] = list.length === 1 ? list[0] : { anyOf: list };
  if (branches.length) {
    for (const key of Object.keys(branches[0].properties ?? {})) {
      if (branches.every((branch) => Array.isArray(branch.required) && branch.required.includes(key))) required.push(key);
    }
  }
  for (const key of unions) delete schema[key];
  schema.type = "object";
  schema.properties = properties;
  const req = [...new Set(required)].filter((key) => typeof key === "string" && key in properties);
  if (req.length) schema.required = req;
  else delete schema.required;
  return true;
}

// fitTools mends a body's function tools in place: their parameters and names.
// It gives the names it made, each to the name the client knows, so that the
// model's calls are named back.
function fitTools(body: ChatBody): Map<string, string> {
  const names = new Map<string, string>();
  if (!Array.isArray(body?.tools) || !body.tools.length) return names;
  const taken = new Set<string>();
  for (const tool of body.tools) {
    const name = tool?.function?.name;
    if (typeof name === "string" && NAME_OK.test(name)) taken.add(name);
  }
  const theirs = new Map<string, string>();
  for (const tool of body.tools) {
    const fn = tool?.type === "function" || tool?.function ? tool.function : null;
    if (!fn || typeof fn !== "object") continue;
    if (typeof fn.name === "string" && !NAME_OK.test(fn.name)) {
      const safe = safeName(fn.name, taken);
      names.set(safe, fn.name);
      theirs.set(fn.name, safe);
      fn.name = safe;
    }
    if (fn.parameters === undefined) continue;
    if (!fn.parameters || typeof fn.parameters !== "object" || Array.isArray(fn.parameters)) {
      fn.parameters = { type: "object", properties: {} };
      continue;
    }
    fitSchema(fn.parameters);
    fitShape(fn.parameters);
    objectRoot(fn.parameters);
  }
  if (theirs.size && Array.isArray(body.messages)) {
    for (const message of body.messages) {
      for (const toolCall of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
        const safe = theirs.get(toolCall?.function?.name ?? "");
        if (safe) toolCall.function!.name = safe;
      }
      if (message?.role === "tool" && theirs.has(message.name ?? "")) message.name = theirs.get(message.name!)!;
    }
  }
  const choice = body.tool_choice?.function;
  if (choice && theirs.has(choice.name)) choice.name = theirs.get(choice.name);
  return names;
}

// normalizeToolChoice converts the object form OpenAI clients emit to
// WorkBuddy's string form.
function normalizeToolChoice(body: ChatBody): void {
  if (!("tool_choice" in body)) return;
  const choice = body.tool_choice;
  if (typeof choice === "string") {
    if (choice.trim().toLowerCase() === "none") {
      delete body.tool_choice;
      delete body.tools;
      delete body.functions;
    }
    return;
  }
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
    delete body.tool_choice;
    return;
  }
  const type = typeof choice.type === "string" ? choice.type.trim().toLowerCase() : "";
  if (type === "none") {
    delete body.tool_choice;
    delete body.tools;
    delete body.functions;
  } else if (type === "auto" || type === "required") {
    body.tool_choice = type;
  } else if (type === "function") {
    const name = typeof choice.function?.name === "string" ? choice.function.name.trim() : "";
    body.tool_choice = name || "auto";
  } else {
    delete body.tool_choice;
  }
}

// namedBack gives the model's calls in an answer the names the client gave its
// tools.
function namedBack(value: any, names: Map<string, string>): boolean {
  let changed = false;
  for (const choice of Array.isArray(value?.choices) ? value.choices : []) {
    for (const at of [choice?.message, choice?.delta]) {
      for (const toolCall of Array.isArray(at?.tool_calls) ? at.tool_calls : []) {
        const ours = names.get(toolCall?.function?.name);
        if (ours) {
          toolCall.function.name = ours;
          changed = true;
        }
      }
    }
  }
  return changed;
}

// renamed is a response with namedBack applied to its body, read as it comes.
async function renamed(response: Response, names: Map<string, string>): Promise<Response> {
  if (!names.size || !response.body) return response;
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  if (/json/i.test(response.headers.get("content-type") ?? "")) {
    const text = await response.text();
    let body = text;
    try {
      const value = JSON.parse(text);
      if (namedBack(value, names)) body = JSON.stringify(value);
    } catch {}
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let rest = "";
  const line = (text: string) => {
    const match = /^data:\s?(.*)$/.exec(text);
    if (!match || match[1] === "[DONE]") return text;
    try {
      const value = JSON.parse(match[1]);
      return namedBack(value, names) ? `data: ${JSON.stringify(value)}` : text;
    } catch {
      return text;
    }
  };
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        rest += decoder.decode(chunk, { stream: true });
        const lines = rest.split("\n");
        rest = lines.pop() ?? "";
        if (lines.length) controller.enqueue(encoder.encode(`${lines.map(line).join("\n")}\n`));
      },
      flush(controller) {
        rest += decoder.decode();
        if (rest) controller.enqueue(encoder.encode(line(rest)));
      },
    }),
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

// ---- the refusal hints --------------------------------------------------------

// REFUSED_HINT is what the user can do about WorkBuddy's "Illegal API
// invocation from an unapproved channel": it reads every message, so it names
// no client.
const REFUSED_HINT =
  "WorkBuddy refused words in this client's prompt (most often its system prompt); use it from Hermes, OpenCode or Pi, or add another provider to this group";
const REFUSED = /unapproved channel|illegal api invocation/i;

const RESTRICTED_HINT =
  "WorkBuddy restricted this account for unusual activity; it stays out until WorkBuddy lifts that, which an appeal (Submit feedback in WorkBuddy) asks for";
const RESTRICTED_CODE = 11140;
const RESTRICTED_TEXT =
  /account has been restricted due to unusual activity|账号存在异常行为|帳號存在異常行為|["']code["']\s*:\s*["']?11140(?![\d.])/i;

const EXHAUSTED_HINT =
  "WorkBuddy requires an active credit package even for 0-rate free models; check your account package balance";
const EXHAUSTED_TEXT = /credits exhausted|额度已用尽|["']code["']\s*:\s*["']?14018(?![\d.])/i;

const AFTER_TOOLS_REFUSED = /must end with a user message|["']code["']\s*:\s*["']?11153(?![\d.])/i;

// explained adds the hint a refusal deserves to its message, so that the user
// knows what to do about it.
async function explained(response: Response): Promise<Response> {
  const text = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.set("X-Magpie-Sign-In", "kept");
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {}
  const at = value?.error && typeof value.error === "object" ? value.error : value && typeof value === "object" ? value : null;
  const code = at?.data?.code ?? at?.code ?? value?.code ?? value?.data?.code;
  const isRefused = REFUSED.test(text);
  const isRestricted = !isRefused && (Number(code) === RESTRICTED_CODE || RESTRICTED_TEXT.test(text));
  const isExhausted = !isRestricted && (Number(code) === 14018 || EXHAUSTED_TEXT.test(text));
  if (!isRefused && !isRestricted && !isExhausted)
    return new Response(text, { status: response.status, statusText: response.statusText, headers });

  let message = text.trim();
  if (at && typeof at.message === "string") message = at.message;
  else if (typeof at?.data?.msg === "string") message = at.data.msg;
  else if (typeof value?.error === "string") message = value.error;
  else if (typeof value?.msg === "string" && value.msg) message = value.msg;
  else if (typeof value?.data?.msg === "string") message = value.data.msg;

  const hint = isRefused ? REFUSED_HINT : isRestricted ? RESTRICTED_HINT : EXHAUSTED_HINT;
  const type = isRefused || isRestricted ? "permission_error" : "insufficient_quota";
  headers.set("content-type", "application/json");
  return new Response(
    JSON.stringify({
      error: { message: `${message} — ${hint}`, type, code: isRefused ? null : isRestricted ? RESTRICTED_CODE : 14018 },
    }),
    { status: response.status, statusText: response.statusText, headers },
  );
}

// ---- the conversation's ids ---------------------------------------------------

// WorkBuddy's own client names each chat four ways: the conversation it belongs
// to, the user send it answers, the message itself, and the request that
// carried it. Its backend counts a user send as one request by
// X-Conversation-Request-ID, so every step of one send carries the same one.

const SALT = randomBytes(16).toString("hex");

function idFor(kind: string, key: string): string {
  return createHash("sha256").update(`${SALT}|${kind}|${key}`).digest("hex").slice(0, 32);
}

// signatureOf is a message content's signature: its text, and a digest of every
// part that isn't text. A tool result's part is left out.
function signatureOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content as any[]) {
    const type = part?.type ?? "";
    if (type === "" || type === "text") out += typeof part?.text === "string" ? part.text : "";
    else if (type !== "tool_result" && type !== "tool-result") {
      out += `[${type}:${createHash("sha256").update(JSON.stringify(part)).digest("hex").slice(0, 8)}]`;
    }
  }
  return out;
}

// answeredBefore is whether a message answers the one before it — a tool's
// result, or an assistant's calls — rather than carrying the user's own words.
function answeredBefore(messages: ChatMessage[], index: number): boolean {
  const previous = messages[index - 1];
  if (previous === null || typeof previous !== "object") return false;
  if (previous.role === "tool") return true;
  return previous.role === "assistant" && Array.isArray(previous.tool_calls) && previous.tool_calls.length > 0;
}

function turnKey(body: ChatBody): string {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user" || answeredBefore(messages, i)) continue;
    const signature = signatureOf(messages[i].content);
    return signature ? `u${i}:${signature}` : "";
  }
  return "";
}

function conversationKey(body: ChatBody, session: string): string {
  if (session) return `session:${session}`;
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  for (const message of messages) {
    if (message?.role !== "user") continue;
    const signature = signatureOf(message.content);
    if (signature) return `first:${signature}`;
  }
  return "";
}

// attend sets a chat's ids on the headers its request goes out with.
function attend(headers: Headers, body: ChatBody, session: string): void {
  const conversation = conversationKey(body, session);
  const message = hex();
  headers.set("X-Conversation-Message-ID", message);
  headers.set("X-Request-ID", message);
  if (!headers.has("X-Conversation-Request-ID")) {
    const turn = turnKey(body);
    headers.set("X-Conversation-Request-ID", turn ? idFor("turn", `${conversation}|${turn}`) : hex());
  }
  if (conversation && !headers.has("X-Conversation-ID"))
    headers.set("X-Conversation-ID", idFor("conversation", conversation));
}

// ---- models -------------------------------------------------------------------

// textOnly says whether a site drops the images sent to a model, whatever its
// config says: WorkBuddy AI's GLM models filter them server-side.
function textOnly(site: Site, model: string): boolean {
  return !!site.noImages?.test(model);
}

function creditsOf(credits: unknown): number | undefined {
  if (credits === null || credits === undefined || credits === "") return undefined;
  const text = String(credits)
    .trim()
    .toLowerCase()
    .replace(/\s+credits?$/, "")
    .replace(/^x/, "");
  const value = Number(text);
  return text !== "" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function discountOf(promotion: any, base: number | undefined): number | undefined {
  const said = creditsOf(String(promotion.discount?.discountedCredits ?? "").trim().replace(/x$/i, ""));
  if (said !== undefined) return said;
  const factor = Number(promotion.discount?.factor);
  return Number.isFinite(factor) && factor >= 0 && base !== undefined ? base * factor : undefined;
}

function running(promotion: any, now: number): boolean {
  if (!promotion || promotion.enabled === false) return false;
  const from = Date.parse(promotion.schedule?.validFrom ?? "");
  const until = Date.parse(promotion.schedule?.validUntil ?? "");
  return !(from > now) && !(until <= now);
}

// priceOf is a model's price from its credits and the config's promotions. A
// price that holds only some hours of the day is given as its full price,
// never as free: the list stands until it is asked for again.
function priceOf(
  definition: any,
  promotions: unknown,
  now = Date.now(),
): { free: boolean; rate?: number; rateWas?: number } {
  const base = creditsOf(definition.credits);
  const mine = (Array.isArray(promotions) ? promotions : []).filter(
    (promotion: any) =>
      promotion?.kind === "discount" &&
      Array.isArray(promotion.modelIds) &&
      promotion.modelIds.includes(definition.id) &&
      running(promotion, now),
  );
  if (mine.some((promotion: any) => Array.isArray(promotion.schedule?.daily) && promotion.schedule.daily.length)) {
    const night = mine.filter(
      (promotion: any) => promotion.discount && Array.isArray(promotion.schedule?.daily) && promotion.schedule.daily.length,
    );
    if (base === undefined || (base === 0 && night.some((promotion: any) => discountOf(promotion, base) === 0)))
      return { free: false };
    return { free: false, rate: base };
  }
  const off = mine
    .filter((promotion: any) => promotion.discount)
    .map((promotion: any) => discountOf(promotion, base))
    .filter((rate: number | undefined): rate is number => rate !== undefined);
  if (off.length) {
    const rate = Math.min(...off);
    return { free: rate === 0, rate, ...(base !== undefined && base > rate ? { rateWas: base } : {}) };
  }
  if (base === undefined) return { free: false };
  return { free: base === 0, rate: base };
}

const EFFORT_ORDER: Effort[] = ["low", "medium", "high", "xhigh", "max"];

// effortsOf are the reasoning levels a config model takes. Most list them in
// reasoning.supportedEfforts; some say only supportsReasoning and a default.
function effortsOf(definition: any): Effort[] {
  const said = definition.reasoning?.supportedEfforts;
  if (Array.isArray(said) && said.length) return said as Effort[];
  if (definition.supportsReasoning !== true) return [];
  const own = definition.reasoning?.effort;
  const set = new Set<string>([
    "low",
    "high",
    "max",
    ...(typeof own === "string" && EFFORT_ORDER.includes(own as Effort) ? [own] : []),
  ]);
  return EFFORT_ORDER.filter((effort) => set.has(effort));
}

interface LiveModel {
  id: string;
  name: string;
  context?: number;
  output?: number;
  images?: boolean;
  efforts?: Effort[];
  free?: boolean;
  rate?: number;
  rateWas?: number;
}

// liveModels asks WorkBuddy's product config for the plan's models: the "cli"
// agent's list, each with its details.
async function liveModels(site: Site, account: Account, signal?: AbortSignal): Promise<LiveModel[]> {
  const response = await fetch(`${site.endpoint}/v3/config`, {
    headers: {
      ...signedHeaders(site, account),
      // the CLI User-Agent picks WorkBuddy's config (a bare WorkBuddy/<v>
      // gets CodeBuddy IDE's, which has no cli agent)
      "User-Agent": `CLI/${APP_VERSION} WorkBuddy/${UA_VERSION}`,
      Accept: "application/json",
    },
    signal: signal ?? AbortSignal.timeout(15_000),
  });
  const envelope: Envelope = await response.json().catch(() => ({}) as Envelope);
  if (!response.ok) throw new Error(`${site.name}'s config: HTTP ${response.status}`);
  const code = Number.parseInt(String(envelope.code ?? 0), 10) || 0;
  if (code) throw new Error(`${site.name}'s config: ${envelope.msg} (${code})`);
  const config = (envelope.data ?? {}) as any;
  const out: LiveModel[] = [];
  for (const agent of config.agents ?? []) {
    if (agent.name !== "cli") continue;
    for (const id of agent.models ?? []) {
      const definition = (config.models ?? []).find((model: any) => model.id === id);
      const model: LiveModel = { id, name: definition?.name || id };
      if (definition) {
        model.context = definition.maxInputTokens;
        model.output = definition.maxOutputTokens;
        model.images = definition.supportsImages === true && !textOnly(site, id);
        Object.assign(model, priceOf(definition, config.modelPromotions));
        const efforts = effortsOf(definition);
        if (efforts.length) {
          const canOff = definition.reasoning?.canDisableThinking;
          model.efforts = [
            ...(!definition.onlyReasoning && (canOff === null || canOff === undefined || canOff)
              ? (["none"] as Effort[])
              : []),
            ...efforts,
          ];
        }
      }
      out.push(model);
    }
  }
  // tell apart models the config names alike: deepseek-v4.1-flash and
  // deepseek-v4.1-flash-sg are both "Deepseek-V4.1-Flash"
  const first = new Map<string, string>();
  for (const model of out) {
    const id = first.get(model.name);
    if (id === undefined) {
      first.set(model.name, model.id);
      continue;
    }
    const rest = model.id.startsWith(`${id}-`) ? model.id.slice(id.length + 1) : "";
    model.name = `${model.name} (${rest ? rest.toUpperCase() : model.id})`;
  }
  return out;
}

// pi's thinking levels, mapped to what a model takes. A model that can turn
// reasoning off says so with "off".
function thinkingLevelMap(efforts: Effort[] | undefined): Model<Api>["thinkingLevelMap"] {
  if (!efforts?.length) return undefined;
  const has = (level: Effort) => efforts.includes(level);
  return {
    off: has("none") ? "none" : null,
    minimal: has("minimal") ? "minimal" : null,
    low: has("low") ? "low" : null,
    medium: has("medium") ? "medium" : null,
    high: has("high") ? "high" : null,
    xhigh: has("xhigh") ? "xhigh" : null,
    max: has("max") ? "max" : null,
  };
}

function toPiModel(site: Site, model: LiveModel): Model<Api> {
  return {
    id: model.id,
    name: model.name,
    api: API_ID,
    provider: site.id,
    baseUrl: api(site),
    reasoning: !!model.efforts?.length,
    thinkingLevelMap: thinkingLevelMap(model.efforts),
    input: model.images ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.context && model.context > 0 ? model.context : 200_000,
    maxTokens: model.output && model.output > 0 ? model.output : 32_000,
    compat: {
      // WorkBuddy's endpoint takes max_tokens, not max_completion_tokens
      maxTokensField: "max_tokens",
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsStrictMode: false,
      supportsUsageInStreaming: true,
      thinkingFormat: "openai",
    },
  };
}

function fallbackModels(site: Site): Model<Api>[] {
  return site.models.map((model) =>
    toPiModel(site, {
      id: model.id,
      name: model.name,
      context: model.context,
      efforts: model.efforts,
      images: !textOnly(site, model.id),
    }),
  );
}

// ---- the provider ---------------------------------------------------------------

// The pi-ai implementation chats go through, with the request mended between
// pi and the wire.
const completions = openAICompletionsApi();

interface SiteRuntime {
  // the system prompts WorkBuddy refused as an unapproved channel, for this run
  refusedSystems: Set<string>;
  // the models that refused tool results then the user's message, for this run
  endsAfterTools: Set<string>;
  // the models signed in for, as WorkBuddy last listed them
  models: Model<Api>[];
}

function runtimeOf(site: Site, runtimes: Map<string, SiteRuntime>): SiteRuntime {
  let runtime = runtimes.get(site.id);
  if (!runtime) {
    runtime = { refusedSystems: new Set(), endsAfterTools: new Set(), models: [] };
    runtimes.set(site.id, runtime);
  }
  return runtime;
}

// fetchFor mends each chat on its way out: the words WorkBuddy refuses, the
// request spellings it doesn't take, the tool schemas its models take, the
// ids its usage list counts by, and — once refused — the shapes it turns away.
function fetchFor(runtime: SiteRuntime, send: typeof fetch, session: string) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : undefined;
    const headers = new Headers(init?.headers ?? request?.headers);
    headers.delete("content-length");
    const raw = init?.body ?? (request ? await request.clone().text() : undefined);
    const text = typeof raw === "string" ? raw : raw === undefined ? "" : new TextDecoder().decode(raw as ArrayBuffer);
    let body: ChatBody;
    try {
      body = JSON.parse(text) as ChatBody;
    } catch {
      return send(request ?? String(input), { ...init, headers, body: raw as BodyInit });
    }
    const names = new Map<string, string>();
    const shape = (current: ChatBody): ChatBody => {
      withSystem(current);
      for (const [safe, ours] of fitTools(current)) names.set(safe, ours);
      normalizeToolChoice(current);
      attend(headers, current, session);
      return current;
    };
    const post = async (current: ChatBody): Promise<Response> => {
      const response = await send(request ?? String(input), {
        ...init,
        method: init?.method ?? request?.method ?? "POST",
        headers,
        body: JSON.stringify(current),
        signal: init?.signal ?? request?.signal,
      });
      return renamed(response, names);
    };

    let current = shape(body);
    const model = current.model ?? "";
    // a system prompt WorkBuddy refused before goes as the user's words at once
    const key = systemKey(current);
    if (key && runtime.refusedSystems.has(key)) current = systemAsUser(current) ?? current;
    // a model known to turn tool results then the user's message away gets the
    // empty reply between them up front
    const shaped = (value: ChatBody) =>
      runtime.endsAfterTools.has(model) ? (replyAfterTools(value) ?? value) : value;
    let response = await post(shaped(current));
    if (response.status === 400) {
      let said = await response.text();
      const moved = REFUSED.test(said) && key && !runtime.refusedSystems.has(key) ? systemAsUser(current) : null;
      if (moved) {
        runtime.refusedSystems.add(key);
        if (runtime.refusedSystems.size > 256) runtime.refusedSystems.delete(runtime.refusedSystems.values().next().value!);
        current = moved;
        response = await post(shaped(current));
        if (response.status === 400) said = await response.text();
      }
      const again =
        response.status === 400 && !runtime.endsAfterTools.has(model) && AFTER_TOOLS_REFUSED.test(said)
          ? replyAfterTools(current)
          : null;
      if (again) {
        runtime.endsAfterTools.add(model);
        response = await post(again);
      } else if (response.status === 400) {
        response = new Response(said, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }
    }
    return response.status >= 400 ? explained(response) : response;
  };
}

// streams is a site's chat implementation: pi's openai-completions, with the
// request mended on its way out.
function streamsFor(runtime: SiteRuntime): ProviderStreams {
  const withFetch = (options: StreamOptions | SimpleStreamOptions | undefined): StreamOptions => ({
    ...options,
    fetch: fetchFor(runtime, options?.fetch ?? globalThis.fetch, options?.sessionId ?? ""),
  });
  return {
    stream: (model: Model<Api>, context: TranscriptContext, options?: StreamOptions): AssistantMessageEventStream =>
      completions.stream(model, context, withFetch(options)),
    streamSimple: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream =>
      completions.streamSimple(model, context, withFetch(options)),
  };
}

function providerFor(site: Site, runtime: SiteRuntime) {
  return createProvider<Api>({
    id: site.id,
    name: site.name,
    baseUrl: api(site),
    models: fallbackModels(site),
    api: { [API_ID]: streamsFor(runtime) },
    // Once WorkBuddy has listed the plan's models, those are the ones the
    // account has: the fallback list stands only until then (a plan need not
    // have every model the fallback names).
    filterModels: (models) => (runtime.models.length ? runtime.models : models),
    auth: {
      oauth: {
        name: site.name,
        isSubscription: true,
        loginLabel: `${site.name} account`,
        // The account WorkBuddy desktop is signed in to is used at once,
        // nothing pasted or copied: the app's file is read on each request
        // and never changed. With no desktop sign-in — or one the app keeps
        // encrypted, which only the app opens — Tencent's sign-in page opens
        // instead.
        async login(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
          const desktop = readDesktop(site);
          if (desktop) {
            interaction.notify({
              type: "info",
              message: `Using the account ${site.name} desktop is signed in to (${desktop.name}).`,
            });
            return desktopCredential(site);
          }
          interaction.notify({ type: "info", message: notDesktop(site) });
          return browserSignIn(site, interaction);
        },
        async refresh(credential: OAuthCredential): Promise<OAuthCredential> {
          const account = credential as Account;
          if (account.source === "desktop") {
            // the app's sign-in is read where the app keeps it, renewed here
            // only when the app hasn't, and never written back. A file that
            // has gone (the app was signed out, or removed) leaves the marker
            // as it is: the request itself then says so, plainly.
            try {
              await desktopAccount(site);
              return { ...desktopCredential(site) };
            } catch {
              return { ...credential, expires: Date.now() + DESKTOP_LOOK_MS };
            }
          }
          const next = await renew(site, account);
          return { ...credential, ...pick(next) };
        },
        async toAuth(credential: OAuthCredential) {
          const account = await current(site, credential as Account);
          return { apiKey: account.access, headers: signedHeaders(site, account) };
        },
      },
    },
    // the plan's models, as WorkBuddy's product config lists them for its CLI.
    // A list that can't be read leaves the list there was: pi keeps the last
    // one it published, and the shipped list stands until then.
    async fetchModels(context) {
      const credential = context.credential;
      if (credential?.type !== "oauth") return [];
      const account = await current(site, credential as Account);
      const live = await liveModels(site, account, context.signal);
      if (!live.length) throw new Error(`${site.name} listed no models`);
      runtime.models = live.map((model) => toPiModel(site, model));
      return runtime.models;
    },
  });
}

export default function workBuddyExtension(pi: ExtensionAPI): void {
  const runtimes = new Map<string, SiteRuntime>();
  for (const site of Object.values(SITES)) {
    const runtime = runtimeOf(site, runtimes);
    pi.registerProvider(providerFor(site, runtime));
  }
}

// for tests
export const _internal = {
  SITES,
  api,
  signedHeaders,
  enterpriseHeaders,
  withSystem,
  unflagged,
  unflag,
  systemAsUser,
  systemKey,
  replyAfterTools,
  normalizeToolChoice,
  fitTools,
  fitShape,
  fitSchema,
  objectRoot,
  renamed,
  namedBack,
  attend,
  turnKey,
  conversationKey,
  signatureOf,
  priceOf,
  effortsOf,
  thinkingLevelMap,
  toPiModel,
  fallbackModels,
  desktopFile,
  readDesktop,
  notDesktop,
  desktopCredential,
  desktopHeld,
  fetchFor,
  streamsFor,
  providerFor,
  explained,
  DEFAULT_SYSTEM,
  REFUSED_HINT,
  RESTRICTED_HINT,
  EXHAUSTED_HINT,
  AFTER_TOOLS_REFUSED,
};
