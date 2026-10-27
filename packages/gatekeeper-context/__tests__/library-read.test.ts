import { describe, expect, it } from "vitest";
import { ObservationGate, type ObserverKv } from "@gadgets/gatekeeper-kit/observers";
import type {
  GatekeeperUserVerifier, ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { CONTEXT_OBSERVER_DENIED, contextObserverStrategy } from "../src/context-observers.js";
import type { ContextCollectionDurableObject } from "../src/context-collection.js";
import { LibraryReadSession } from "../src/library-read.js";
import type { UserLibraryDurableObject } from "../src/user-library.js";
import type { CollectionAccess } from "../src/collection-access.js";
import { domainName } from "../src/domain.js";

const DOMAIN = "workshop.example";

function makeKv(): ObserverKv {
  let map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: <T>(key: string, value: T) => void map.set(key, value),
    delete: (key: string) => void map.delete(key),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map.entries()].filter(([key]) => key.startsWith(prefix)) as [string, T][],
  };
}

function verifier(allowed: string[]): Fetcher<GatekeeperUserVerifier> {
  return {
    async hasCollectionsAccess(_sharingDomain: string, collectionIds: string[]) {
      return collectionIds.map(id => allowed.includes(id));
    },
  } as unknown as Fetcher<GatekeeperUserVerifier>;
}

const DOCUMENT = {
  path: "plan.md",
  name: "plan.md",
  description: "Launch plan",
  contentType: "text/markdown",
  body: "Ship it.",
};

// The owner's standing on the collections the library index covers: the public one, and a private
// one the owner's library lists. Tests inject any other collection's access via `resolvedAccess`.
const PUBLIC_ACCESS: CollectionAccess = {
  exists: true, visibility: "public", role: null, manager: false,
  everyoneCanView: false, hasOwner: false, shared: false,
};
const OWNER_ACCESS: CollectionAccess = {
  exists: true, visibility: "private", role: "owner", manager: false,
  everyoneCanView: false, hasOwner: true, shared: false,
};

// The owner's library: one public collection and one private collection.
function makeSession({ publicDiscoveryFails = false, publicAccessFails = false,
  resolvedAccess = {} as Record<string, CollectionAccess> } = {}) {
  let kv = makeKv();
  let strategy = contextObserverStrategy(kv, DOMAIN);
  let authorized: ObservationDescription[] = [];
  let authorizer = {
    async authorizeObservation(description: ObservationDescription) {
      authorized.push(description);
    },
    [Symbol.dispose]() {},
  };
  let collections = {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      async getAccess() {
        if (publicAccessFails && name === domainName(DOMAIN, "unavailable")) {
          throw new Error("Public collection is unavailable.");
        }
        return { exists: true, visibility: "public" };
      },
      async getResolvedAccess() {
        let id = name.split("\u0000").at(-1)!;
        if (publicAccessFails && id === "unavailable") {
          throw new Error("Public collection is unavailable.");
        }
        return resolvedAccess[id] ?? (id === "public" ? PUBLIC_ACCESS : OWNER_ACCESS);
      },
      async getMetadata() {
        let id = name.split("\u0000").at(-1)!;
        return { title: `${id} title`, description: `${id} description`, documentCount: 1 };
      },
      async listContextDocuments() { return [DOCUMENT]; },
      async getContextDocument() { return DOCUMENT; },
      async search() {
        return [{ path: DOCUMENT.path, name: DOCUMENT.name, description: DOCUMENT.description, score: 1 }];
      },
    }),
  } as unknown as DurableObjectNamespace<ContextCollectionDurableObject>;
  let userLibraries = {
    idFromName: (name: string) => name,
    get: () => ({
      async listPrivateLibrary() {
        return [{ id: "private" }];
      },
      async hasPrivateLibraryCollection(_domain: string, _accountId: string, id: string) {
        return id === "private";
      },
    }),
  } as unknown as DurableObjectNamespace<UserLibraryDurableObject>;
  let env = {
    CONTEXT_COLLECTIONS: {
      async get() {
        if (publicDiscoveryFails) throw new Error("Public discovery is unavailable.");
        let ids = publicAccessFails ? ["public", "unavailable"] : ["public"];
        return JSON.stringify(ids.map(id => ({ id, lastUpdated: new Date() })));
      },
    },
  } as unknown as Pick<Cloudflare.Env, "CONTEXT_COLLECTIONS">;
  let session = new LibraryReadSession(
    env, collections, userLibraries, DOMAIN, "owner",
    new ObservationGate(
      authorizer as unknown as ConstructorParameters<typeof ObservationGate>[0], strategy));
  return { session, strategy, authorized };
}

describe("LibraryReadSession sharing", () => {
  it("lists every collection without restricting who may open the workspace", async () => {
    let { session, strategy, authorized } = makeSession();
    await strategy.addObserver("existing", verifier(["public"]));

    let listing = await session.list();

    expect(listing.entries.map(entry => entry.type === "collection" && entry.id))
      .toEqual(["private", "public"]);
    expect(authorized).toHaveLength(1);
    expect(authorized[0].excludeObservers).toBeUndefined();
    await strategy.addObserver("later", verifier(["public"]));
  });

  it("restricts sharing once a private collection's contents are listed or read", async () => {
    for (let reveal of [
      (session: LibraryReadSession) => session.list({ collectionId: "private" }),
      (session: LibraryReadSession) => session.read("private/plan.md"),
    ]) {
      let { session, strategy, authorized } = makeSession();
      await strategy.addObserver("existing", verifier(["public"]));

      await reveal(session);

      expect(authorized[0].excludeObservers).toEqual(["existing"]);
      await expect(strategy.addObserver("later", verifier(["public"])))
        .rejects.toThrow(CONTEXT_OBSERVER_DENIED);
      await strategy.addObserver("owner-account", verifier(["public", "private"]));
    }
  });

  it("keeps healthy private and public results when another public collection is unavailable", async () => {
    using session = makeSession({ publicAccessFails: true }).session;

    expect((await session.list()).entries.map(entry => entry.type === "collection" && entry.id))
      .toEqual(["private", "public"]);
    expect((await session.search("plan")).map(result => result.docId))
      .toEqual(["private/plan.md", "public/plan.md"]);
  });

  it("reads, lists and searches a private collection while public discovery is unavailable", async () => {
    let { session } = makeSession({ publicDiscoveryFails: true });

    expect(await session.read("private/plan.md")).toMatchObject({
      docId: "private/plan.md", content: "Ship it.",
    });
    expect((await session.list({ collectionId: "private" })).entries)
      .toMatchObject([{ path: "plan.md", type: "document" }]);
    expect(await session.search("plan", { collectionId: "private" }))
      .toMatchObject([{ docId: "private/plan.md", collectionId: "private" }]);
  });
});

describe("LibraryReadSession everyone-viewable", () => {
  // A stranger on an everyone-viewable collection: no grant, no library index entry, not public.
  const EVERYONE_CAN_VIEW: CollectionAccess = {
    exists: true, visibility: "private", role: null, manager: false,
    everyoneCanView: true, hasOwner: true, shared: true,
  };

  it("reads and searches an everyone-viewable collection by id, but never lists it", async () => {
    let { session } = makeSession({ resolvedAccess: { everyone: EVERYONE_CAN_VIEW } });

    // Id-addressed reads answer from the access authority, not the library index.
    expect(await session.read("everyone/plan.md")).toMatchObject({
      docId: "everyone/plan.md", content: "Ship it.",
    });
    expect(await session.search("plan", { collectionId: "everyone" }))
      .toMatchObject([{ docId: "everyone/plan.md", collectionId: "everyone" }]);

    // Discovery stays index-driven: the collection never lists, on its own or among results.
    expect((await session.list()).entries.map(entry => entry.type === "collection" && entry.id))
      .toEqual(["private", "public"]);
    expect((await session.list({ collectionId: "everyone" })).entries).toEqual([]);
    expect((await session.search("plan")).map(result => result.collectionId))
      .toEqual(["private", "public"]);
  });

  it("takes everyone-viewable read back away once the flag is off", async () => {
    let { session } = makeSession({
      resolvedAccess: { everyone: { ...EVERYONE_CAN_VIEW, everyoneCanView: false } },
    });

    expect(await session.read("everyone/plan.md")).toBeNull();
    expect(await session.search("plan", { collectionId: "everyone" })).toEqual([]);
  });
});
