/**
 * Unit tests for Pi's strict LF-only JSONL framing.
 */

import { describe, expect, it } from "vitest";
import { PiProtocolError } from "../src/errors.ts";
import { bytesToStrings, type DecodedLine, decodeFrames, encodeFrame } from "../src/framing.ts";

async function collect(stream: AsyncIterable<DecodedLine>): Promise<DecodedLine[]> {
  const out: DecodedLine[] = [];
  for await (const line of stream) out.push(line);
  return out;
}

async function* fromChunks(chunks: readonly string[]): AsyncGenerator<string, void, unknown> {
  for (const c of chunks) yield c;
}

describe("encodeFrame", () => {
  it("encodes an object with a trailing LF", () => {
    const encoded = encodeFrame({ id: "a", type: "prompt", message: "hi" });
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.split("\n")).toHaveLength(2);
    expect(JSON.parse(encoded)).toEqual({ id: "a", type: "prompt", message: "hi" });
  });

  it("throws on non-serializable input", () => {
    expect(() => encodeFrame({ bigint: BigInt(1) } as unknown as object)).toThrow();
  });
});

describe("decodeFrames — LF-only delimiter", () => {
  it("parses a single complete line", async () => {
    const out = await collect(decodeFrames(fromChunks(['{"type":"ready"}\n'])));
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("frame");
    if (out[0]?.kind === "frame") {
      expect(out[0].frame).toEqual({ type: "ready" });
    }
  });

  it("buffers incomplete lines across chunks", async () => {
    const out = await collect(
      decodeFrames(fromChunks(['{"ty', 'pe":"ev', 'ent","x":1}\n{"type":"b"}\n'])),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ kind: "frame", frame: { type: "event", x: 1 } });
    expect(out[1]).toEqual({ kind: "frame", frame: { type: "b" } });
  });

  it("silently drops empty lines", async () => {
    const out = await collect(decodeFrames(fromChunks(["\n\n", '{"type":"x"}\n', "\n"])));
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("frame");
  });

  it("does NOT split on Unicode line separators (U+2028 / U+2029)", async () => {
    // A JSON payload with a U+2028 INSIDE a string must not be split. If the
    // decoder mis-treated U+2028 as a line terminator, we'd see either a
    // protocol error or two frames instead of the single correct frame.
    const u2028 = "\u2028";
    const u2029 = "\u2029";
    // JSON spec allows unescaped U+2028 / U+2029 in strings; json.stringify
    // preserves them as literal characters.
    const payload = JSON.stringify({ type: "msg", text: `hello${u2028}world${u2029}!` });
    const out = await collect(decodeFrames(fromChunks([`${payload}\n`])));
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("frame");
    if (out[0]?.kind === "frame") {
      const obj = out[0].frame as { type: string; text: string };
      expect(obj.type).toBe("msg");
      expect(obj.text).toBe(`hello${u2028}world${u2029}!`);
    }
  });

  it("strips trailing CR (accepts CRLF input)", async () => {
    const out = await collect(decodeFrames(fromChunks(['{"type":"x"}\r\n'])));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ kind: "frame", frame: { type: "x" } });
  });

  it("yields a PiProtocolError on malformed JSON without crashing", async () => {
    const out = await collect(
      decodeFrames(
        fromChunks(['{"type":"good"}\n', "this is not json\n", '{"type":"also_good"}\n']),
      ),
    );
    expect(out).toHaveLength(3);
    expect(out[0]?.kind).toBe("frame");
    expect(out[1]?.kind).toBe("error");
    if (out[1]?.kind === "error") {
      expect(out[1].error).toBeInstanceOf(PiProtocolError);
      expect(out[1].error.raw).toBe("this is not json");
    }
    expect(out[2]?.kind).toBe("frame");
  });

  it("yields a PiProtocolError on a JSON value that isn't an object", async () => {
    const out = await collect(decodeFrames(fromChunks(["42\n", '"a string"\n', "[1,2]\n"])));
    expect(out).toHaveLength(3);
    for (const line of out) {
      expect(line.kind).toBe("error");
    }
  });

  it("yields a PiProtocolError on a stream closed mid-frame (no trailing LF)", async () => {
    const out = await collect(decodeFrames(fromChunks(['{"type":"partial"'])));
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("error");
    if (out[0]?.kind === "error") {
      expect(out[0].error).toBeInstanceOf(PiProtocolError);
      expect(out[0].error.message).toMatch(/partial frame/);
    }
  });
});

describe("bytesToStrings", () => {
  it("decodes UTF-8 chunks and preserves multi-byte runs across boundaries", async () => {
    const enc = new TextEncoder();
    const full = "héllo\n"; // 'é' is 2 bytes in UTF-8
    const bytes = enc.encode(full);
    // Split the two bytes of 'é' across chunks.
    const first = bytes.subarray(0, 2);
    const rest = bytes.subarray(2);
    async function* gen(): AsyncGenerator<Uint8Array, void, unknown> {
      yield first;
      yield rest;
    }
    const out: string[] = [];
    for await (const s of bytesToStrings(gen())) out.push(s);
    expect(out.join("")).toBe(full);
  });
});
