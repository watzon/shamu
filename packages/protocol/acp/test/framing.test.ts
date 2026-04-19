/**
 * Unit tests for the framing module.
 *
 * Covers:
 *  - `encodeFrame` produces newline-terminated JSON.
 *  - `decodeFrames` parses a happy-path NDJSON stream.
 *  - Chunk boundaries that split a single frame across two reads.
 *  - Empty lines are skipped.
 *  - Malformed lines surface as protocol errors; the stream keeps draining.
 *  - LF-only delimiter; `\u2028` / `\u2029` inside strings do NOT split.
 *  - Trailing partial frame (no LF) is surfaced as a protocol error on close.
 */

import { describe, expect, it } from "vitest";
import { AcpProtocolError } from "../src/errors.ts";
import { bytesToStrings, type DecodedLine, decodeFrames, encodeFrame } from "../src/framing.ts";

async function collect<T>(gen: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of gen) out.push(v);
  return out;
}

async function* fromStrings(...chunks: string[]): AsyncGenerator<string, void, unknown> {
  for (const c of chunks) yield c;
}

describe("encodeFrame", () => {
  it("produces a single newline-terminated JSON line", () => {
    const encoded = encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.slice(-2)).toBe("}\n");
    const parsed = JSON.parse(encoded.trim()) as { method: string };
    expect(parsed.method).toBe("initialize");
  });

  it("throws on non-serializable values", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => encodeFrame(cyclic)).toThrow();
  });
});

describe("decodeFrames", () => {
  it("parses one frame per line on the happy path", async () => {
    const stream = fromStrings(
      '{"jsonrpc":"2.0","id":1,"result":{}}\n',
      '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1"}}\n',
    );
    const out: DecodedLine[] = await collect(decodeFrames(stream));
    expect(out).toHaveLength(2);
    expect(out[0]?.kind).toBe("frame");
    expect(out[1]?.kind).toBe("frame");
  });

  it("assembles frames that span chunk boundaries", async () => {
    const stream = fromStrings('{"js', 'onrpc":"2.0","id":', "7,", '"result":null}\n');
    const out = await collect(decodeFrames(stream));
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("frame");
    if (out[0]?.kind === "frame") {
      expect(out[0].frame).toMatchObject({ jsonrpc: "2.0", id: 7 });
    }
  });

  it("skips empty lines", async () => {
    const stream = fromStrings('\n\n{"jsonrpc":"2.0","method":"ping"}\n\n');
    const out = await collect(decodeFrames(stream));
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("frame");
  });

  it("surfaces malformed JSON as AcpProtocolError and keeps draining", async () => {
    const stream = fromStrings("not json\n", '{"jsonrpc":"2.0","method":"after"}\n');
    const out = await collect(decodeFrames(stream));
    expect(out).toHaveLength(2);
    expect(out[0]?.kind).toBe("error");
    if (out[0]?.kind === "error") {
      expect(out[0].error).toBeInstanceOf(AcpProtocolError);
      expect(out[0].error.raw).toBe("not json");
    }
    expect(out[1]?.kind).toBe("frame");
  });

  it("surfaces bare-primitive JSON as a protocol error (frame must be object)", async () => {
    const stream = fromStrings("42\n");
    const out = await collect(decodeFrames(stream));
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("error");
  });

  it("does NOT split on Unicode line separators (LF-only)", async () => {
    const payload = {
      jsonrpc: "2.0",
      method: "session/update",
      params: { text: "line1\u2028line2\u2029still-the-same-frame" },
    };
    // Serialize without the terminator so we can inject manually.
    const serialized = JSON.stringify(payload);
    const stream = fromStrings(`${serialized}\n`);
    const out = await collect(decodeFrames(stream));
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("frame");
    if (out[0]?.kind === "frame") {
      const f = out[0].frame as { params: { text: string } };
      expect(f.params.text).toContain("\u2028");
      expect(f.params.text).toContain("\u2029");
    }
  });

  it("yields a protocol error for a trailing partial frame at close", async () => {
    const stream = fromStrings('{"jsonrpc":"2.0","id":1,"result":{}}\n{"partial"');
    const out = await collect(decodeFrames(stream));
    expect(out).toHaveLength(2);
    expect(out[0]?.kind).toBe("frame");
    expect(out[1]?.kind).toBe("error");
  });
});

describe("bytesToStrings", () => {
  it("decodes UTF-8 chunks with multi-byte runs split across boundaries", async () => {
    // "héllo" — `é` (U+00E9) is 0xC3 0xA9 in UTF-8. Split across two chunks.
    const chunks = [new Uint8Array([0x68, 0xc3]), new Uint8Array([0xa9, 0x6c, 0x6c, 0x6f])];
    async function* gen(): AsyncGenerator<Uint8Array, void, unknown> {
      for (const c of chunks) yield c;
    }
    const decoded: string[] = [];
    for await (const s of bytesToStrings(gen())) decoded.push(s);
    expect(decoded.join("")).toBe("héllo");
  });
});
