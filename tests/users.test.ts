import { describe, it, expect, beforeEach } from "vitest";
import { freshStore } from "./helpers";
import {
  createUser,
  verifyUser,
  getUserById,
  BadEmail,
  WeakPassword,
  EmailTaken,
} from "../src/lib/users";

const GOOD_PASSWORD = "sufficiently-long-pass";

describe("users", () => {
  beforeEach(() => {
    freshStore();
  });

  it("registers a user on the sandbox tier with a bcrypt-hashed password", async () => {
    const u = await createUser("alice@example.com", GOOD_PASSWORD);
    expect(u.email).toBe("alice@example.com");
    expect(u.tier).toBe("sandbox");
    expect(u.id).toBeTruthy();
    expect(u.created_at).toBeTruthy();
    expect(Array.isArray(u.keys)).toBe(true);
    expect(u.keys).toHaveLength(0);
    // Password is never stored in the clear.
    expect(u.pw_hash).not.toBe(GOOD_PASSWORD);
    expect(u.pw_hash.startsWith("$2")).toBe(true); // bcrypt marker
  });

  it("rejects a duplicate email with EmailTaken", async () => {
    await createUser("dup@example.com", GOOD_PASSWORD);
    await expect(createUser("dup@example.com", GOOD_PASSWORD)).rejects.toBeInstanceOf(
      EmailTaken
    );
  });

  it("rejects malformed emails with BadEmail", async () => {
    await expect(createUser("plainly-wrong", GOOD_PASSWORD)).rejects.toBeInstanceOf(BadEmail);
    await expect(createUser("missing@dot", GOOD_PASSWORD)).rejects.toBeInstanceOf(BadEmail);
  });

  it("rejects passwords shorter than 10 chars with WeakPassword", async () => {
    await expect(createUser("shorty@example.com", "nine-char")).rejects.toBeInstanceOf(
      WeakPassword
    );
  });

  it("verifyUser accepts the right password and rejects the wrong one", async () => {
    const u = await createUser("verify@example.com", GOOD_PASSWORD);
    const ok = await verifyUser("verify@example.com", GOOD_PASSWORD);
    expect(ok).not.toBeNull();
    expect(ok!.id).toBe(u.id);
    const bad = await verifyUser("verify@example.com", "wrong-password-here");
    expect(bad).toBeNull();
    const unknown = await verifyUser("nobody@example.com", GOOD_PASSWORD);
    expect(unknown).toBeNull();
  });

  it("getUserById round-trips through the uid pointer", async () => {
    const u = await createUser("roundtrip@example.com", GOOD_PASSWORD);
    const found = await getUserById(u.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(u.id);
    expect(found!.email).toBe("roundtrip@example.com");
    expect(found!.tier).toBe("sandbox");
    const missing = await getUserById("00000000-0000-0000-0000-000000000000");
    expect(missing).toBeNull();
  });
});
