/**
 * LF-delimited JSON framing for Pi's custom JSONL RPC transport.
 *
 * Pi's RPC doc (`github.com/badlogic/pi-mono/.../coding-agent/docs/rpc.md`)
 * specifies strict JSONL semantics with LF (`\n`) as the only record
 * delimiter. We mirror the same approach as `@shamu/protocol-acp`'s
 * `framing.ts` — Unicode line-separator-aware splitters (`\u2028` /
 * `\u2029`) will desynchronize against a JSON payload that legitimately
 * contains those characters inside a string, so we stay strictly byte-level
 * LF here.
 *
 * Pi's doc also notes clients "may accept optional `\r\n` input by stripping
 * a trailing `\r`", meaning incoming input may legally end with CRLF. We
 * handle that by trimming a trailing `\r` from each candidate line before
 * parsing. Unicode line separators inside a JSON string are preserved (the
 * chunk-reader does not split on them).
 *
 * ### Tolerance
 *
 * - Empty lines are silently skipped (Pi may flush a trailing `\n\n`).
 * - Any non-empty line that isn't valid JSON surfaces as a
 *   `PiProtocolError` — the consumer decides whether to keep draining or
 *   bail. We specifically do NOT throw on a malformed line; the mission's
 *   "don't crash on malformed lines" rule holds.
 *
 * ### What this module is NOT
 *
 * - It does not validate Pi's command/response shape. That lives in
 *   `rpc-client.ts` which checks `type`, `id`, `success` fields.
 * - It does not own the transport. `rpc-client.ts` wires framing to a
 *   pluggable sink/source.
 */

import { PiProtocolError } from "./errors.ts";

/**
 * Encode a JSON object as a single LF-terminated UTF-8 string.
 *
 * Throws if the input cannot be JSON-stringified. Callers that need to
 * redact before sending should do so BEFORE the encode — this module deals
 * in raw shape.
 */
export function encodeFrame(frame: object): string {
  const body = JSON.stringify(frame);
  if (typeof body !== "string") {
    throw new TypeError("encodeFrame: JSON.stringify returned undefined (non-serializable value)");
  }
  return `${body}\n`;
}

/**
 * One emission from the line decoder.
 *
 * - `frame` — a successfully parsed JSON object
 * - `error` — a malformed line (invalid JSON, or a JSON value that isn't an
 *   object); carries the raw line for diagnostics.
 */
export type DecodedLine =
  | { readonly kind: "frame"; readonly frame: unknown }
  | { readonly kind: "error"; readonly error: PiProtocolError };

/**
 * Line-buffered JSON parser over an AsyncIterable of text chunks.
 *
 * - **LF-only delimiter.** Unicode-separator-aware splitters are forbidden.
 * - **Chunk-span-aware.** A single JSON frame split across two reads is
 *   reassembled correctly.
 * - Empty lines silently dropped.
 * - Trailing `\r` (CRLF input) stripped before parse.
 * - Malformed lines yielded as `{ kind: "error", error }`.
 * - On stream close with a partial non-empty trailing line (no LF), we
 *   yield a protocol error — Pi must newline-terminate every frame.
 */
export async function* decodeFrames(
  stream: AsyncIterable<string>,
): AsyncGenerator<DecodedLine, void, unknown> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk;
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      const rawLine = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const line = stripTrailingCR(rawLine);
      if (line.length === 0) continue;
      yield parseLine(line);
    }
  }
  if (buffer.length > 0) {
    const line = stripTrailingCR(buffer);
    if (line.length > 0) {
      yield {
        kind: "error",
        error: new PiProtocolError(
          "Pi JSONL stream closed with a partial frame (no trailing LF)",
          buffer,
        ),
      };
    }
  }
}

function stripTrailingCR(line: string): string {
  if (line.length > 0 && line.charCodeAt(line.length - 1) === 0x0d) {
    return line.slice(0, -1);
  }
  return line;
}

function parseLine(line: string): DecodedLine {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        kind: "error",
        error: new PiProtocolError("Pi frame was not a JSON object", line),
      };
    }
    return { kind: "frame", frame: parsed };
  } catch (cause) {
    return {
      kind: "error",
      error: new PiProtocolError(
        `Pi frame failed to parse: ${(cause as Error)?.message ?? String(cause)}`,
        line,
        cause,
      ),
    };
  }
}

/**
 * Utility: bridge an `AsyncIterable<Uint8Array>` into an
 * `AsyncIterable<string>` by decoding UTF-8 with multi-byte run buffering
 * across chunk boundaries. The rpc-client wires its raw byte stream
 * through this before handing off to `decodeFrames`.
 */
export async function* bytesToStrings(
  stream: AsyncIterable<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    if (text.length > 0) yield text;
  }
  const tail = decoder.decode();
  if (tail.length > 0) yield tail;
}
