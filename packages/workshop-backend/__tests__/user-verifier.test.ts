import { describe, expect, it } from "vitest";
import type { GatekeeperUser, GatekeeperUserVerifier } from "@gadgets/workshop-shared/gatekeeper";
import { UserDurableObject } from "../src/user.js";
import { UserAccountStore } from "../src/user-accounts.js";

function makeUserWithAccount(vendorId: string) {
  const verifier = {} as Fetcher<GatekeeperUserVerifier>;
  let verifierRequests = 0;
  const account = {
    async getVerifier() {
      verifierRequests++;
      return verifier;
    },
  } as Fetcher<GatekeeperUser>;
  const storageSlice = {
    connectedAccounts: {
      get: (accountId: number) => accountId === 7
        ? { id: accountId, account, vendorId }
        : undefined,
    },
  };
  const user = Object.create(UserDurableObject.prototype) as UserDurableObject;
  Object.assign(user, {
    storage: storageSlice,
    // getVerifier lives on the account store (user-accounts.ts); the empty env binds no vendors,
    // which this path never touches.
    accounts: new UserAccountStore({} as DurableObjectState, {} as Cloudflare.Env,
        storageSlice, {} as never, async () => {}),
  });
  return { user, verifier, verifierRequests: () => verifierRequests };
}

describe("UserDurableObject.getVerifier", () => {
  it("returns a verifier when the connected account belongs to the expected vendor", async () => {
    const { user, verifier, verifierRequests } = makeUserWithAccount("notion");

    await expect(user.getVerifier(7, "notion")).resolves.toBe(verifier);
    expect(verifierRequests()).toBe(1);
  });

  it("returns null when the account is missing", async () => {
    const { user, verifierRequests } = makeUserWithAccount("notion");

    await expect(user.getVerifier(999, "notion")).resolves.toBeNull();
    expect(verifierRequests()).toBe(0);
  });

  it("throws when the connected account belongs to another vendor", async () => {
    const { user, verifierRequests } = makeUserWithAccount("linear");

    await expect(user.getVerifier(7, "notion")).rejects.toThrow(
        "Invalid account selection for this service.");
    expect(verifierRequests()).toBe(0);
  });
});
