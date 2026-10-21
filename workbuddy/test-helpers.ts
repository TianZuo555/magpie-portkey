import { expect } from "bun:test"
import type { LoaderOptions, WireRecord } from "./types.ts"

export type FetchMock = (input: string | URL | Request, init: RequestInit) => Promise<Response>
export function setFetch(mock: FetchMock): void {
  globalThis.fetch = Object.assign(
    (input: string | URL | Request, init: RequestInit = {}) => mock(input, init),
    { preconnect: globalThis.fetch.preconnect },
  ) as typeof fetch
}
export function parse(body: unknown): WireRecord {
  expect(typeof body).toBe("string")
  return JSON.parse(body as string)
}
export function chatFetch(loader: LoaderOptions): NonNullable<LoaderOptions["fetch"]> {
  expect(loader.fetch).toBeFunction()
  return loader.fetch!
}
export type Call = { url: URL; init: RequestInit; headers: Headers }
export type Save = { path: { id: string }; body: import("./types.ts").Account }
