import { describe, expect, it } from "vitest";
import type { SupportedResource, VendorDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { GatekeeperVendorInfo } from "@gadgets/workshop-shared/api";
import { UserAccountStore } from "../src/user-accounts.js";

// Unit seam for the account store: a plain object with a GATEKEEPER_<NAME> key is all
// buildGatekeeperVendorMap needs (it enumerates env), and the store's remaining inputs are
// the storage slice, directory, and sweep callback -- none of which listGatekeeperVendors
// and getCloudflareGatekeeperAccount touch beyond the fields faked here.
function makeStore(options: {
  resources: () => Promise<SupportedResource[]>,
  describe?: () => Promise<VendorDescription>,
  records?: Array<{ id: number, vendorId?: string, broken?: boolean, [key: string]: unknown }>,
}) {
  let counts = { resources: 0, described: 0 };
  const vendor = {
    describe: async () => {
      counts.described++;
      return options.describe?.() ?? Promise.resolve({
        displayName: "Counter",
        url: "https://counter.example",
      });
    },
    getSupportedResources: async () => {
      counts.resources++;
      return options.resources();
    },
  };
  const records = new Map(options.records?.map(rec => [rec.id, rec]));
  const storageSlice = {
    connectedAccounts: {
      get: (id: number) => {
        const rec = records.get(id);
        if (rec?.broken) throw new Error("Stub refers to a service that doesn't exist");
        return rec;
      },
    },
    nextAccountId: {
      get: () => records.size,
    },
    profile: {
      get: () => ({ id: "user-1", name: "User", type: "user" }),
    },
  };
  const env = {
    GATEKEEPER_COUNTER: vendor,
    // readAdminConfig reads a single KV key; null parses to the default (nothing disabled).
    BLUEPRINTS: { get: async () => null },
  };
  const store = new UserAccountStore(
      { id: { toString: () => "user-1" } } as unknown as DurableObjectState,
      env as unknown as Cloudflare.Env,
      storageSlice as never,
      {} as never,
      async () => {});
  return { store, counts };
}

describe("UserAccountStore.listGatekeeperVendors", () => {
  it("fetches a vendor's supported resources once per listing, filter or not", async () => {
    const resources = [{
      urlPattern: "https://counter.example/items/*",
      title: "Item",
      description: "",
    }];

    const plain = makeStore({ resources: () => Promise.resolve(resources) });
    const listed = await plain.store.listGatekeeperVendors();
    expect(listed).toHaveLength(1);
    expect(plain.counts.resources).toBe(1);

    // The resourceUrl filter runs over the same fetch: exactly one RPC, not one for the
    // filter plus one for the payload.
    const filtered = makeStore({ resources: () => Promise.resolve(resources) });
    const matched = await filtered.store.listGatekeeperVendors(
        { resourceUrl: "https://counter.example/items/7" });
    expect(matched).toHaveLength(1);
    expect(filtered.counts.resources).toBe(1);
  });

  it("hides a vendor whose resources do not match the filter, without describing it", async () => {
    const resources = [{
      urlPattern: "https://counter.example/items/*",
      title: "Item",
      description: "",
    }];
    const { store, counts } = makeStore({ resources: () => Promise.resolve(resources) });
    const listed = await store.listGatekeeperVendors(
        { resourceUrl: "https://elsewhere.example/items/7" });
    expect(listed).toEqual([]);
    // The filter answer comes from the single resources fetch; a non-matching vendor is
    // never described.
    expect(counts.resources).toBe(1);
    expect(counts.described).toBe(0);
  });

  it("surfaces a vendor as unavailable when it cannot be loaded unfiltered", async () => {
    const { store } = makeStore({
      resources: () => Promise.reject(new Error("binding reset")),
    });
    const listed: GatekeeperVendorInfo[] = await store.listGatekeeperVendors();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.unavailable).toBe(true);
  });
});

describe("UserAccountStore.getCloudflareGatekeeperAccount", () => {
  it("finds the account through the shared scan, skipping records that fail to load", async () => {
    const account = { getVerifier: async () => ({}) };
    const { store } = makeStore({
      resources: async () => [],
      records: [
        { id: 0, vendorId: "counter", broken: true },
        { id: 1, vendorId: "cloudflare", account },
        { id: 2, vendorId: "counter" },
      ],
    });
    await expect(store.getCloudflareGatekeeperAccount()).resolves.toBe(account);
  });

  it("returns null when no Cloudflare account survives the scan", async () => {
    const { store } = makeStore({
      resources: async () => [],
      records: [
        { id: 0, vendorId: "cloudflare", broken: true },
        { id: 1, vendorId: "counter" },
      ],
    });
    await expect(store.getCloudflareGatekeeperAccount()).resolves.toBeNull();
  });
});
