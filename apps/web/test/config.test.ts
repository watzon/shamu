import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PORT,
  originAllowList,
  resolveConfig,
  resolveDatabasePath,
} from "../src/server/config.ts";

describe("resolveConfig", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shamu-web-config-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("defaults port to 4711 and binds to loopback", () => {
    const cfg = resolveConfig({ cwd: tmp });
    expect(cfg.port).toBe(DEFAULT_PORT);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.allowedOrigins).toEqual(["http://127.0.0.1:4711", "http://localhost:4711"]);
  });

  it("honors an explicit port override in the allow-list", () => {
    const cfg = resolveConfig({ cwd: tmp, port: 9000 });
    expect(cfg.port).toBe(9000);
    expect(cfg.allowedOrigins).toContain("http://127.0.0.1:9000");
    expect(cfg.allowedOrigins).toContain("http://localhost:9000");
  });

  it("resolves the DB under the state dir", () => {
    const cfg = resolveConfig({ cwd: tmp, stateDir: join(tmp, "state") });
    expect(cfg.dbPath).toBe(join(tmp, "state", "shamu.db"));
  });
});

describe("resolveDatabasePath", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shamu-web-db-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("uses .shamu/state relative to cwd by default", () => {
    const path = resolveDatabasePath({ cwd: tmp });
    expect(path).toBe(join(tmp, ".shamu", "state", "shamu.db"));
  });

  it("prefers an explicit stateDir over env/cwd defaults", () => {
    const override = join(tmp, "my-state");
    const path = resolveDatabasePath({ cwd: tmp, stateDir: override });
    expect(path).toBe(join(override, "shamu.db"));
  });
});

describe("originAllowList", () => {
  it("returns the loopback pair for the given port", () => {
    expect(originAllowList(4711)).toEqual(["http://127.0.0.1:4711", "http://localhost:4711"]);
  });
});
