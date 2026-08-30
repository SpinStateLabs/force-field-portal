// Rate limiting is APPROXIMATE (last-write-wins fixed windows) — a Declared limit,
// not an Enforced hard cap. These tests pass explicit `now` dates so windows are
// deterministic regardless of when the suite runs.

import { describe, it, expect, beforeEach } from "vitest";
import { freshStore } from "./helpers";
import { checkRateLimit } from "../src/lib/ratelimit";
import { TIERS } from "../src/lib/tiers";

describe("ratelimit", () => {
  beforeEach(() => {
    freshStore();
  });

  it("sandbox: allows rpm requests in one minute window, blocks the next with retry_after_s", async () => {
    const hash = "a".repeat(64);
    const now = new Date(Date.UTC(2026, 5, 15, 12, 0, 30));

    let last: Awaited<ReturnType<typeof checkRateLimit>> | undefined;
    for (let i = 0; i < TIERS.sandbox.rpm; i++) {
      last = await checkRateLimit(hash, "sandbox", now);
      expect(last.allowed).toBe(true);
    }
    // Minute budget exactly spent on the final allowed call.
    expect(last!.remaining_minute).toBe(0);
    expect(last!.remaining_day).toBe(TIERS.sandbox.rpd - TIERS.sandbox.rpm);

    const blocked = await checkRateLimit(hash, "sandbox", now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retry_after_s).toBeGreaterThan(0);
    // Minute-limited: retry points at the next minute window, never further.
    expect(blocked.retry_after_s!).toBeLessThanOrEqual(60);
  });

  it("sandbox: blocks after the day budget even in a fresh minute window", async () => {
    const hash = "b".repeat(64);
    const base = Date.UTC(2026, 5, 15, 8, 0, 0);
    const minutesNeeded = TIERS.sandbox.rpd / TIERS.sandbox.rpm; // 200 / 10 = 20

    let last: Awaited<ReturnType<typeof checkRateLimit>> | undefined;
    for (let m = 0; m < minutesNeeded; m++) {
      for (let i = 0; i < TIERS.sandbox.rpm; i++) {
        last = await checkRateLimit(hash, "sandbox", new Date(base + m * 60_000));
        expect(last.allowed).toBe(true);
      }
    }
    expect(last!.remaining_day).toBe(0);

    // Fresh minute window, but the UTC-day budget is spent.
    const blocked = await checkRateLimit(
      hash,
      "sandbox",
      new Date(base + minutesNeeded * 60_000)
    );
    expect(blocked.allowed).toBe(false);
    // Day-limited: retry points at the next UTC day, not the next minute.
    expect(blocked.retry_after_s).toBeGreaterThan(60);
  });

  it("windows are independent per key hash", async () => {
    const now = new Date(Date.UTC(2026, 5, 15, 9, 30, 0));
    const a = "c".repeat(64);
    const b = "d".repeat(64);

    for (let i = 0; i < TIERS.sandbox.rpm; i++) {
      await checkRateLimit(a, "sandbox", now);
    }
    const aBlocked = await checkRateLimit(a, "sandbox", now);
    expect(aBlocked.allowed).toBe(false);

    // Key B is untouched by key A's exhaustion.
    const bFirst = await checkRateLimit(b, "sandbox", now);
    expect(bFirst.allowed).toBe(true);
    expect(bFirst.remaining_minute).toBe(TIERS.sandbox.rpm - 1);
    expect(bFirst.remaining_day).toBe(TIERS.sandbox.rpd - 1);
  });

  it("a new minute window resets the minute budget (deterministic via explicit now)", async () => {
    const hash = "e".repeat(64);
    const t0 = new Date(Date.UTC(2026, 5, 15, 10, 0, 5));
    for (let i = 0; i < TIERS.sandbox.rpm; i++) {
      await checkRateLimit(hash, "sandbox", t0);
    }
    expect((await checkRateLimit(hash, "sandbox", t0)).allowed).toBe(false);

    // Same UTC day, next minute: minute budget is fresh, day budget still counting.
    const t1 = new Date(Date.UTC(2026, 5, 15, 10, 1, 5));
    const next = await checkRateLimit(hash, "sandbox", t1);
    expect(next.allowed).toBe(true);
  });
});
