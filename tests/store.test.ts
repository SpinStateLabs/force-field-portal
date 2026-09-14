// The production store adapter: which Netlify Blobs store is opened, with which
// consistency, and how the create-only write maps the client's answer. The
// blobs module is mocked at the import boundary; nothing here touches Netlify.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const opened: { fn: string; opts: any }[] = [];
const setJSON = vi.fn(async (_key: string, _value: unknown, _opts?: any) => ({ modified: true }));
const fake = { get: vi.fn(async () => null), setJSON, delete: vi.fn(async () => undefined), list: vi.fn(async () => ({ blobs: [], directories: [] })) };

vi.mock("@netlify/blobs", () => ({
  getStore: (opts: any) => {
    opened.push({ fn: "getStore", opts });
    return fake;
  },
  getDeployStore: (opts: any) => {
    opened.push({ fn: "getDeployStore", opts });
    return fake;
  },
}));

import { portalStore, setStoreForTesting } from "../src/lib/store";

describe("portalStore (production adapter)", () => {
  beforeEach(() => {
    setStoreForTesting(null);
    opened.length = 0;
    setJSON.mockClear();
  });
  afterEach(() => {
    delete process.env.CONTEXT;
  });

  it("opens the site-wide 'portal' store with STRONG consistency in production, a deploy-scoped one elsewhere", async () => {
    process.env.CONTEXT = "production";
    await portalStore();
    expect(opened).toEqual([{ fn: "getStore", opts: { name: "portal", consistency: "strong" } }]);
    opened.length = 0;
    process.env.CONTEXT = "deploy-preview";
    await portalStore();
    expect(opened).toEqual([{ fn: "getDeployStore", opts: { name: "portal", consistency: "strong" } }]);
  });

  it("setJSONIfNew is a create-only write (onlyIfNew) and reports the client's `modified` flag", async () => {
    process.env.CONTEXT = "production";
    const store = await portalStore();
    setJSON.mockResolvedValueOnce({ modified: true });
    expect(await store.setJSONIfNew("k", { a: 1 })).toBe(true);
    expect(setJSON).toHaveBeenLastCalledWith("k", { a: 1 }, { onlyIfNew: true });
    setJSON.mockResolvedValueOnce({ modified: false });
    expect(await store.setJSONIfNew("k", { a: 2 })).toBe(false);
    await store.setJSON("k", { a: 3 });
    expect(setJSON).toHaveBeenLastCalledWith("k", { a: 3 });
  });
});
