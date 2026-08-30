import { describe, it, expect, beforeEach } from "vitest";
import { freshStore } from "./helpers";
import { issueSession, readSession, sessionCookie } from "../src/lib/session";

describe("session", () => {
  beforeEach(() => {
    freshStore(); // sets SESSION_SECRET
  });

  it("issueSession -> readSession round-trips via the ff_session cookie", async () => {
    const userId = "11111111-2222-3333-4444-555555555555";
    const token = await issueSession(userId);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);

    const cookie = sessionCookie(token);
    expect(cookie.startsWith("ff_session=")).toBe(true);

    const req = new Request("http://portal.test/api/me", {
      headers: { cookie },
    });
    const sub = await readSession(req);
    expect(sub).toBe(userId);
  });

  it("returns null for a tampered token", async () => {
    const token = await issueSession("tamper-target");
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const req = new Request("http://portal.test/api/me", {
      headers: { cookie: sessionCookie(tampered) },
    });
    expect(await readSession(req)).toBeNull();
  });

  it("returns null when no cookie is present", async () => {
    const req = new Request("http://portal.test/api/me");
    expect(await readSession(req)).toBeNull();
  });
});
