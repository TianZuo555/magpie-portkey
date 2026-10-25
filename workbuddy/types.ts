// Types for Magpie's OpenCode-compatible plugin hooks and WorkBuddy's wire data.
// Wire records are intentionally open: tools carry arbitrary JSON Schema keywords,
// and WorkBuddy adds fields to its configuration and billing responses.
export type WireRecord = Record<string, any>
export type ModelSeed = [id: string, name: string, context: number, efforts?: string[]]
export interface Site {
  id: string
  name: string
  endpoint: string
  authID: string
  platform: string
  ai: boolean
  models: ModelSeed[]
  noImages?: RegExp
  messages?: boolean
}
export interface Account {
  type?: string
  source?: string
  access?: string
  refresh?: string
  expires?: number
  refreshExpiresAt?: number
  uid?: string
  domain?: string
  tokenType?: string
  enterpriseId?: string
  accountId?: string
  name?: string
  plan?: string
  key?: string
}
export interface Client {
  auth?: { set?: (input: { path: { id: string }; body: Account }) => Promise<unknown> }
}
export interface LiveModel {
  id: string
  name: string
  context?: number
  output?: number
  images?: boolean
  efforts?: string[]
  free?: boolean
  rate?: number
  rateWas?: number
}
export interface UsageWindow {
  name: string
  used: number
  display: string
  amount: number
  limit: number
  unit: string
  resetsAt?: string
  span?: number
  notModels?: string[]
  runsOutAt?: string
  runsOut?: number
}
export interface Usage {
  plan?: string
  windows?: UsageWindow[]
  error?: string
  signIn: "kept" | "renewed" | "expired"
}
export type GetAuth = () => Promise<Account | null | undefined>
export interface AuthResult extends Account {
  type: "success" | "failed"
  error?: string
}
export interface Authorization {
  url: string
  instructions: string
  method: "auto"
  callback: () => Promise<AuthResult>
}
export interface ProviderInfo {
  id: string
  models: Record<string, WireRecord>
}
export interface LoaderOptions {
  baseURL?: string
  apiKey?: string
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}
export interface PluginHooks {
  config: (config: { provider?: Record<string, WireRecord> }) => Promise<void>
  "chat.headers": (input: { model?: { providerID?: string }; provider?: { info?: { id?: string } }; sessionID?: string }, output: { headers: Record<string, string> }) => Promise<void>
  provider: {
    id: string
    models: (provider: ProviderInfo, context: { auth?: Account | null }) => Promise<Record<string, WireRecord>>
  }
  auth: {
    provider: string
    refreshLead: number
    refresh: (auth: Account | null | undefined, provider?: string) => Promise<Partial<Account> | undefined>
    loader: (getAuth: GetAuth) => Promise<LoaderOptions>
    usage: (getAuth: GetAuth) => Promise<Usage>
    methods: { type: "oauth"; label: string; authorize: () => Promise<Authorization> }[]
  }
}
export type MagpiePlugin = (input: { client: Client }) => Promise<PluginHooks>
