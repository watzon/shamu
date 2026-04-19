/**
 * Newline-delimited JSON framing for ACP-stdio.
 *
 * ### Delimiter
 *
 * **LF only.** PLAN.md's Phase 7 recurring-constraint note for vendor
 * subprocess stdin is "strict LF, not a Unicode-aware line splitter" — the
 * same discipline applies on stdout. A Unicode-separator-aware reader (e.g.
 * `readline` with `\u2028` / `\u2029` handling) will desynchronize against a
 * JSON payload that legitimately contains those characters inside a string.
 *
 * ### Tolerance
 *
 * Empty lines are silently skipped (some vendor CLIs emit a trailing `\n\n`
 * when they flush). Any non-empty line that isn't valid JSON surfaces as an
 * `AcpProtocolError` on the out stream — the consumer decides whether to
 * keep draining or bail. We specifically do NOT throw, because Gemini CLI
 * (gemini-cli#22647) has a known stdout-corruption issue where non-ACP
 * writes can bleed into the JSON-RPC stream; the Phase 7.B kickoff decision
 * is "surface as error, don't crash."
 *
 * ### What this module is NOT
 *
 * - It does not validate JSON-RPC 2.0 shape. `jsonrpc: "2.0"` + `id` +
 *   `method` / `result` / `error` branching lives in `client.ts`. A parsed
 *   line may be an arbitrary object; framing only cares that it's JSON.
 * - It does not own the transport. `client.ts` wires framing to a
 *   `AcpJsonRpcTransport`; the stdio transport (subprocess-backed) lives in
 *   `transport-stdio.ts`.
 */

import { AcpProtocolError } from "./errors.ts";

/**
 * Encode a JSON object as a single newline-terminated UTF-8 string.
 *
 * Throws if the input cannot be JSON-stringified (circular refs, functions,
 * BigInt). Callers that need to redact before sending should do so BEFORE
 * the encode — this module deals in raw shape.
 */
export function encodeFrame(frame: object): string {
  const body = JSON.stringify(frame);
  if (typeof body !== "string") {
    throw new TypeError("encodeFrame: JSON.stringify returned undefined (non-serializable value)");
  }
  return `${body}\n`;
}

/**
 * Line-buffered JSON parser over an AsyncIterable of text chunks.
 *
 * - LF-only delimiter.
 * - Empty lines silently dropped.
 * - Malformed lines yielded as `{ kind: "error", error: AcpProtocolError }`.
 * - Valid JSON lines yielded as `{ kind: "frame", frame }`.
 *
 * Buffers across chunk boundaries so a single JSON object split across two
 * reads is still assembled correctly. On stream close, if the buffer holds a
 * partial non-empty line without a terminating LF, we yield it as a protocol
 * error (the line was truncated by the peer).
 */
export type DecodedLine =
  | { readonly kind: "frame"; readonly frame: unknown }
  | { readonly kind: "error"; readonly error: AcpProtocolError };

export async function* decodeFrames(
  stream: AsyncIterable<string>,
): AsyncGenerator<DecodedLine, void, unknown> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += chunk;
    while (true) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.length === 0) continue;
      yield parseLine(line);
    }
  }
  // Flush any trailing non-empty line on close. It is a protocol error to not
  // newline-terminate the last frame.
  if (buffer.length > 0) {
    yield {
      kind: "error",
      error: new AcpProtocolError(
        "ACP stream closed with a partial frame (no trailing LF)",
        buffer,
      ),
    };
  }
}

function parseLine(line: string): DecodedLine {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed === null || typeof parsed !== "object") {
      return {
        kind: "error",
        error: new AcpProtocolError("ACP frame was not a JSON object", line),
      };
    }
    return { kind: "frame", frame: parsed };
  } catch (cause) {
    return {
      kind: "error",
      error: new AcpProtocolError(
        `ACP frame failed to parse: ${(cause as Error)?.message ?? String(cause)}`,
        line,
        cause,
      ),
    };
  }
}

/**
 * Utility: bridge an `AsyncIterable<Uint8Array>` into an
 * `AsyncIterable<string>` by decoding UTF-8 and leaving multi-byte runs
 * buffered across chunk boundaries. The stdio transport wires its raw byte
 * stream through this before handing to `decodeFrames`.
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
