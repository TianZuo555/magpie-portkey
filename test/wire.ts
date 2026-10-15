import { crc32 } from "node:zlib";

export type WireEvent = [string, Record<string, unknown>];

// Real AWS event-stream frames, including both CRCs. Tests exercise the SDK's
// binary decoder as well as our conversion, without contacting Portkey.
export function frame([name, body]: WireEvent): Buffer {
  const headers = Buffer.concat(Object.entries({
    ":message-type": "event", ":event-type": name, ":content-type": "application/json",
  }).map(([key, value]) => {
    const k = Buffer.from(key);
    const v = Buffer.from(value);
    const prefix = Buffer.alloc(1 + k.length + 3);
    prefix[0] = k.length;
    k.copy(prefix, 1);
    prefix[1 + k.length] = 7;
    prefix.writeUInt16BE(v.length, 2 + k.length);
    return Buffer.concat([prefix, v]);
  }));
  const payload = Buffer.from(JSON.stringify(body));
  const bytes = Buffer.alloc(16 + headers.length + payload.length);
  bytes.writeUInt32BE(bytes.length, 0);
  bytes.writeUInt32BE(headers.length, 4);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, 8)), 8);
  headers.copy(bytes, 12);
  payload.copy(bytes, 12 + headers.length);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, -4)), bytes.length - 4);
  return bytes;
}

export const usage = { inputTokens: 11, outputTokens: 7, totalTokens: 23, cacheReadInputTokens: 3, cacheWriteInputTokens: 2 };
export const end = (reason = "end_turn"): WireEvent[] => [
  ["messageStop", { stopReason: reason }], ["metadata", { usage }],
];
export const textEvents = (text = "Hello 世界 🐦"): WireEvent[] => [
  ["messageStart", { role: "assistant" }],
  ["contentBlockStart", { contentBlockIndex: 0, start: {} }],
  ["contentBlockDelta", { contentBlockIndex: 0, delta: { text } }],
  ["contentBlockStop", { contentBlockIndex: 0 }],
  ...end(),
];

export function wireResponse(events = textEvents()): Response {
  const data = Buffer.concat(events.map(frame));
  return new Response(new ReadableStream({
    start(controller) {
      // Split headers, payloads and multibyte UTF-8 characters across reads.
      for (let i = 0; i < data.length; i += 7) controller.enqueue(data.subarray(i, i + 7));
      controller.close();
    },
  }), { headers: { "content-type": "application/vnd.amazon.eventstream", "x-amzn-requestid": "test-request" } });
}
