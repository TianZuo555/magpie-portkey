import { expect } from "bun:test"

// the tests run without the sidecars: no bridge, no auxiliary title asks
process.env.WORKBUDDY_BRIDGE = "off"
process.env.WORKBUDDY_AUXILIARY = "off"
import { gunzipSync } from "node:zlib"
import { mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { LoaderOptions, WireRecord } from "./types.ts"

// The run has one HOME, and bun runs one test file at a time in it. A file
// that writes where WorkBuddy keeps the desktop's sign-in must take it back,
// and a file that needs none must clear it: the order the files run in is the
// filesystem's, so a file that left one behind failed the check on CI's Linux
// checkout while it passed on a Mac.
function appAuthDir(): string {
  const home = homedir()
  const base =
    process.platform === "darwin" ? join(home, "Library", "Application Support", "CodeBuddyExtension")
    : process.platform === "win32" ? join(home, "AppData", "Local", "CodeBuddyExtension")
    : join(home, ".local", "share", "CodeBuddyExtension")
  return join(base, "Data", "Public", "auth")
}

// desktopAuthFile is where the desktop keeps a site's sign-in, its directory made
export function desktopAuthFile(name: string): string {
  const dir = appAuthDir()
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

// clearDesktopAuth leaves no desktop sign-in behind, for a file that needs none
export function clearDesktopAuth(): void {
  rmSync(appAuthDir(), { recursive: true, force: true })
}

export type FetchMock = (input: string | URL | Request, init: RequestInit) => Promise<Response>
export function setFetch(mock: FetchMock): void {
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init: RequestInit = {}) => mock(input, init),
    { preconnect: globalThis.fetch.preconnect },
  ) as typeof fetch
}
export function parse(body: unknown): WireRecord {
  // a chat's body goes to WorkBuddy gzipped; read either back
  if (body instanceof Uint8Array) body = gunzipSync(body).toString()
  expect(typeof body).toBe("string")
  return JSON.parse(body as string)
}
export function chatFetch(loader: LoaderOptions): NonNullable<LoaderOptions["fetch"]> {
  expect(loader.fetch).toBeFunction()
  return loader.fetch!
}
export type Call = { url: URL; init: RequestInit; headers: Headers }
export type Save = { path: { id: string }; body: import("./types.ts").Account }
