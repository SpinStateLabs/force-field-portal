// NOTE: the 5-active-key cap is a function-layer rule (enforced in keys.mts),
// not a lib rule — deliberately NOT tested here.

import { describe, it, expect, beforeEach } from "vitest";
import { freshStore, type MemStore } from "./helpers";
import { createUser, getUserById, type User } from "../src/lib/users";
import { keyHash, issueKey, lookupKey, revokeKey } from "../src/lib/keys";

describe("keys", () => {
  let store: MemStore;
  let user: User;

  beforeEach(async () => {
    store = freshStore();
    user = await createUser("keys@example.com", "sufficiently-long-pass");
  });

  it("issueKey produces a well-formed key, ref, and blob record", async () => {
    const { plaintext, ref } = await issueKey(user, "ci-pipeline");

    // ff_live_ + 40 lowercase hex = 48 chars total
    expect(plaintext).toMatch(/^ff_live_[0-9a-f]{40}$/);
    expect(plaintext).toHaveLength(48);

    expect(ref.prefix).toBe(plaintext.slice(0, 12));
    expect(ref.label).toBe("ci-pipeline");
    expect(ref.hash).toBe(keyHash(plaintext));
    expect(ref.revoked).toBe(false);
    expect(ref.created_at).toBeTruthy();

    // Ref pushed onto the user's key list and persisted.
    expect(user.keys.some((k) => k.hash === ref.hash)).toBe(true);
    const persisted = await getUserById(user.id);
    expect(persisted!.keys.some((k) => k.hash === ref.hash)).toBe(true);

    // keys/<hash> blob written with the lookup record.
    const blob = await store.get("keys/" + ref.hash, { type: "json" });
    expect(blob).not.toBeNull();
    expect(blob.user_id).toBe(user.id);
    expect(blob.label).toBe("ci-pipeline");
    expect(blob.prefix).toBe(ref.prefix);
    expect(blob.revoked).toBe(false);
  });

  it("lookupKey resolves a known key and returns null for an unknown one", async () => {
    const { plaintext, ref } = await issueKey(user, "lookup-me");
    const hit = await lookupKey(plaintext);
    expect(hit).not.toBeNull();
    expect(hit!.user.id).toBe(user.id);
    expect(hit!.ref.hash).toBe(ref.hash);
    expect(hit!.ref.label).toBe("lookup-me");

    const miss = await lookupKey("ff_live_" + "f".repeat(40));
    expect(miss).toBeNull();
  });

  it("revokeKey flips both records; lookupKey still returns the key with revoked true", async () => {
    const { plaintext, ref } = await issueKey(user, "to-revoke");

    const ok = await revokeKey(user, ref.hash);
    expect(ok).toBe(true);

    // Blob record flipped.
    const blob = await store.get("keys/" + ref.hash, { type: "json" });
    expect(blob.revoked).toBe(true);

    // User record flipped and persisted.
    const persisted = await getUserById(user.id);
    const entry = persisted!.keys.find((k) => k.hash === ref.hash);
    expect(entry).toBeDefined();
    expect(entry!.revoked).toBe(true);

    // lookupKey still returns revoked keys — the caller decides what to do.
    const hit = await lookupKey(plaintext);
    expect(hit).not.toBeNull();
    expect(hit!.ref.revoked).toBe(true);
  });

  it("revokeKey returns false for an absent hash", async () => {
    const ok = await revokeKey(user, "0".repeat(64));
    expect(ok).toBe(false);
  });
});
