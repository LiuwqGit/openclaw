// Unmocked production-boundary proof for the wide-area DNS zone writer.
//
// Unlike widearea-dns.test.ts, this file does NOT mock `./replace-file.js` or
// `fs.readFileSync`. It writes a real on-disk zone into a per-test temp
// directory, calls the production `writeWideAreaGatewayZone`, and reads the
// resulting file back through the real atomic-replace path. This is the
// after-fix unmocked zone write ClawSweeper asks for.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as utils from "../utils.js";
import {
  getWideAreaZonePath,
  renderWideAreaGatewayZoneText,
  type WideAreaGatewayZoneOpts,
  writeWideAreaGatewayZone,
} from "./widearea-dns.js";

const baseZoneOpts: WideAreaGatewayZoneOpts = {
  domain: "openclaw.internal.",
  gatewayPort: 18789,
  displayName: "Mac Studio (OpenClaw)",
  tailnetIPv4: "100.123.224.76",
  hostLabel: "studio-london",
  instanceLabel: "studio-london",
};

const FIXED_NOW = new Date("2026-03-13T12:00:00.000Z");

function makeZoneOpts(overrides: Partial<WideAreaGatewayZoneOpts> = {}): WideAreaGatewayZoneOpts {
  return { ...baseZoneOpts, ...overrides };
}

const SOA_SERIAL_RE = /^\s*@\s+IN\s+SOA\s+\S+\s+\S+\s+(\d+)\s+/m;

function readWrittenSerial(zonePath: string): number {
  const text = fs.readFileSync(zonePath, "utf8");
  const match = text.match(SOA_SERIAL_RE);
  if (!match?.[1]) {
    throw new Error(`SOA serial not found in written zone:\n${text}`);
  }
  return Number.parseInt(match[1], 10);
}

function writeExistingZone(stateDir: string, serial: number): string {
  const zonePath = getWideAreaZonePath("openclaw.internal.");
  fs.mkdirSync(path.dirname(zonePath), { recursive: true });
  fs.writeFileSync(zonePath, renderWideAreaGatewayZoneText({ ...makeZoneOpts(), serial }), "utf8");
  return zonePath;
}

describe("wide-area DNS zone writer — unmocked production boundary", () => {
  let stateDir: string;
  let originalConfigDir: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-widearea-dns-boundary-"));
    originalConfigDir = utils.CONFIG_DIR;
    utils.pinConfigDir({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
  });

  afterEach(() => {
    vi.useRealTimers();
    utils.pinConfigDir({ ...process.env, OPENCLAW_STATE_DIR: undefined });
    if (originalConfigDir) {
      utils.pinConfigDir(process.env);
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("writes a strictly-greater serial through the real atomic-replace path", async () => {
    const zonePath = writeExistingZone(stateDir, 2027010101);

    const result = await writeWideAreaGatewayZone(
      makeZoneOpts({ gatewayTlsEnabled: true, gatewayTlsFingerprintSha256: "abc123" }),
    );

    expect(result.changed).toBe(true);
    expect(result.zonePath).toBe(zonePath);
    // The on-disk file was actually replaced (not just captured by a mock).
    expect(fs.readFileSync(zonePath, "utf8")).toContain("gatewayTlsSha256=abc123");
    const serial = readWrittenSerial(zonePath);
    // Monotonic (greater than the existing future-dated serial) and bounded.
    expect(serial).toBe(2027010102);
    expect(serial).toBeLessThanOrEqual(0xffffffff);
  });

  it("keeps the maximum 32-bit serial bounded via RFC 1982 wrap arithmetic", async () => {
    const zonePath = writeExistingZone(stateDir, 0xffffffff);

    await writeWideAreaGatewayZone(
      makeZoneOpts({ gatewayTlsEnabled: true, gatewayTlsFingerprintSha256: "abc123" }),
    );

    const written = fs.readFileSync(zonePath, "utf8");
    // Never emits an out-of-range 33-bit serial.
    expect(written).not.toContain("4294967296");
    const serial = readWrittenSerial(zonePath);
    expect(serial).toBeLessThanOrEqual(0xffffffff);
    // RFC 1982: the written serial must be strictly greater than 0xffffffff in
    // bounded serial space so secondaries transfer the updated zone. Today's
    // base (2026031301) satisfies that, so the writer reuses it.
    expect(serial).toBe(2026031301);
  });

  it("does not regress after the same-day counter rolls past 99", async () => {
    writeExistingZone(stateDir, 2026031400);

    await writeWideAreaGatewayZone(
      makeZoneOpts({ gatewayTlsEnabled: true, gatewayTlsFingerprintSha256: "abc123" }),
    );

    const serial = readWrittenSerial(getWideAreaZonePath("openclaw.internal."));
    expect(serial).toBe(2026031401);
  });
});
