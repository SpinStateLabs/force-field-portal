// Force-Field Portal — storage + environment access.
//
// A minimal KV abstraction over Netlify Blobs so tests can swap in an
// in-memory store via setStoreForTesting(). The KV surface is deliberately
// restricted to the store methods this codebase uses:
//   get(key, {type}), setJSON(key, value), delete(key), list({prefix}).

export type KV = {
  get(key: string, opts?: { type?: "json" | "text" }): Promise<any>;
  setJSON(key: string, value: any): Promise<void>;
  /**
   * Create-only write (the store's own compare-and-set, `onlyIfNew` in
   * @netlify/blobs >= 10): true when the key was written, false when it
   * already existed — the caller then knows another writer got there first.
   */
  setJSONIfNew(key: string, value: any): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string }): Promise<{ blobs: { key: string }[] }>;
};

let testStore: KV | null = null;

/** Install (or clear, with null) a substitute store for tests. */
export function setStoreForTesting(s: KV | null): void {
  testStore = s;
}

/**
 * Read an environment variable. Prefers the Netlify runtime global
 * (Netlify.env.get) and falls back to process.env so tests and plain
 * Node tooling work unchanged.
 */
export function env(name: string): string | undefined {
  return (globalThis as any).Netlify?.env?.get?.(name) ?? process.env[name];
}

/**
 * The portal's blob store.
 * - testStore when installed (unit tests);
 * - the site-wide "portal" store in the production deploy context;
 * - a deploy-scoped "portal" store elsewhere (previews / branch deploys),
 *   so non-production deploys never touch production data.
 * @netlify/blobs is lazily imported so importing this module never requires
 * the Netlify runtime.
 */
export async function portalStore(): Promise<KV> {
  if (testStore) return testStore;
  const { getStore, getDeployStore } = await import("@netlify/blobs");
  const store = env("CONTEXT") === "production" ? getStore("portal") : getDeployStore("portal");
  return {
    get: (key, opts) => store.get(key, opts as any),
    setJSON: async (key, value) => {
      await store.setJSON(key, value);
    },
    setJSONIfNew: async (key, value) => (await store.setJSON(key, value, { onlyIfNew: true })).modified,
    delete: (key) => store.delete(key),
    list: (opts) => store.list(opts),
  };
}
