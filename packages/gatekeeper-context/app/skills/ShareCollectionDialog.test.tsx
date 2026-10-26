// @vitest-environment jsdom

import { Toasty } from "@cloudflare/kumo";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextApi, ContextCollectionSharing } from "../../src/context-types";
import type { SelectUsers, UserSelectionReceiver } from "../bridge";
import { ShareCollectionDialog } from "./ShareCollectionDialog";

const mocks = vi.hoisted(() => ({
  api: null as ContextApi | null,
  selectUsers: null as SelectUsers | null,
  closeDialog: null as (() => void) | null,
}));

vi.mock("../bridge", () => ({
  useContextApi: () => mocks.api,
  useSelectUsers: () => mocks.selectUsers,
}));

vi.mock("./useMutationDialog", () => ({
  useMutationDialog: (_busy: boolean, onClosed: () => void) => {
    mocks.closeDialog = onClosed;
    return {
      open: true,
      requestClose: () => { if (!_busy) onClosed(); },
      closeAfterSuccess: onClosed,
      onOpenChangeComplete: () => {},
    };
  },
}));

// jsdom lacks PointerEvent, which Kumo's Base UI controls dispatch.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, PointerEvent: MouseEvent });

const sharing: ContextCollectionSharing = {
  members: [{ memberId: "me", role: "owner", displayName: "Ada", isViewer: true }],
  everyoneCanView: false,
  hasOwner: true,
};

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>("button")]
  .find((candidate) => candidate.textContent?.trim() === label);

const addRole = () => document.querySelector<HTMLElement>("[aria-label='Role for users you add']");
const addOrg = () => document.querySelector<HTMLElement>("[aria-label='Add organization']");

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const choose = async (trigger: HTMLElement | null | undefined, label: string) => {
  await act(async () => {
    trigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    trigger?.click();
  });
  const option = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")]
    .find((candidate) => candidate.textContent === label);
  expect(option).toBeDefined();
  await act(async () => {
    option?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    option?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    option?.click();
  });
};

const ownerPermissions = { canEdit: true, canShare: true, canManageOwners: true, canDelete: true };
const viewerWithoutOrgs = async () => ({ isAdmin: false, supportsGitCollections: false, orgs: [] });
const twoOwners: ContextCollectionSharing = {
  members: [
    { memberId: "me", role: "owner", displayName: "Ada", isViewer: true },
    { memberId: "bob", role: "owner", displayName: "Bob", isViewer: false },
  ],
  everyoneCanView: false,
  hasOwner: true,
};

const renderDialog = async (onChanged: () => void = () => {}) => {
  const container = document.createElement("div");
  document.body.append(container);
  const created = createRoot(container);
  await act(async () => {
    created.render(
      <Toasty>
        <ShareCollectionDialog
          collection={{ id: "collection", title: "Engineering" }}
          onChanged={onChanged}
          onLeft={() => {}}
          onClose={() => {}}
        />
      </Toasty>,
    );
    await Promise.resolve();
  });
  return created;
};

const flush = () => act(async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
});

const PartialLeaveParent = () => {
  const [reconciled, setReconciled] = React.useState(false);
  return <Toasty>
    <p>{reconciled ? "Library refreshed" : "Library unchanged"}</p>
    <ShareCollectionDialog
      collection={{ id: "collection", title: "Engineering" }}
      onChanged={() => setReconciled(true)}
      onLeft={() => { throw new Error("A rejected leave must not report success"); }}
      onClose={() => {}}
    />
  </Toasty>;
};

describe("ShareCollectionDialog", () => {
  let root: Root | undefined;

  afterEach(() => {
    if (root) act(() => root?.unmount());
    document.body.replaceChildren();
  });

  it("delivers picks with the role chosen when the picker opened and surfaces backend refusals", async () => {
    const shareContextCollection = vi.fn<ContextApi["shareContextCollection"]>(async (_id, ticket) => {
      if (ticket === "refused") throw new Error("They have no Context account yet.");
    });
    mocks.api = {
      getViewerInfo: viewerWithoutOrgs,
      getContextCollectionSharing: async () => sharing,
      getContextCollectionPermissions: async () => ({
        canEdit: true,
        canShare: true,
        canManageOwners: true,
        canDelete: true,
      }),
      shareContextCollection,
    } as unknown as ContextApi;
    let receiver: UserSelectionReceiver | undefined;
    let closePicker: (() => void) | undefined;
    mocks.selectUsers = vi.fn<SelectUsers>((picked) => {
      receiver = picked;
      return new Promise<void>((resolve) => { closePicker = resolve; });
    });

    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <ShareCollectionDialog
          collection={{ id: "collection", title: "Engineering" }}
          onChanged={() => {}}
          onLeft={() => {}}
          onClose={() => {}}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => button("Select users")?.click());
    expect(receiver).toBeDefined();

    // Change the role control while the picker is still open.
    const roleTrigger = [...document.querySelectorAll<HTMLElement>("button")]
      .find((candidate) => candidate.textContent?.includes("Viewer"));
    await act(async () => {
      roleTrigger?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      roleTrigger?.click();
    });
    const editorOption = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")]
      .find((option) => option.textContent === "Editor");
    expect(editorOption).toBeDefined();
    await act(async () => {
      editorOption?.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      editorOption?.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
      editorOption?.click();
    });

    await act(async () => receiver!.receive({ ticket: "accepted" }));
    expect(shareContextCollection).toHaveBeenLastCalledWith("collection", "accepted", "viewer");

    await act(async () => {
      await expect(receiver!.receive({ ticket: "refused" }))
        .rejects.toThrow("They have no Context account yet.");
    });
    expect(shareContextCollection).toHaveBeenLastCalledWith("collection", "refused", "viewer");

    await act(async () => closePicker?.());
  });

  it("stops granting owner once the viewer can no longer manage owners", async () => {
    let permissions = ownerPermissions;
    const shareContextCollection = vi.fn<ContextApi["shareContextCollection"]>(async () => {});
    mocks.api = {
      getViewerInfo: viewerWithoutOrgs,
      getContextCollectionSharing: async () => twoOwners,
      getContextCollectionPermissions: async () => permissions,
      setContextCollectionMemberRole: async () => {
        permissions = { ...ownerPermissions, canManageOwners: false };
      },
      shareContextCollection,
    } as unknown as ContextApi;
    let receiver: UserSelectionReceiver | undefined;
    mocks.selectUsers = vi.fn<SelectUsers>(async (picked) => { receiver = picked; });
    root = await renderDialog();

    await choose(addRole(), "Owner");
    expect(addRole()?.textContent).toContain("Owner");

    await choose(document.querySelector<HTMLElement>("[aria-label='Role for you']"), "Can edit");
    await flush();
    expect(addRole()?.textContent).toContain("Editor");

    await act(async () => button("Select users")?.click());
    await act(async () => receiver!.receive({ ticket: "picked" }));
    expect(shareContextCollection).toHaveBeenLastCalledWith("collection", "picked", "editor");
  });

  it("reports possibly committed rejections on close and surfaces failed refreshes", async () => {
    let loads = 0;
    const getContextCollectionSharing = vi.fn<ContextApi["getContextCollectionSharing"]>(async () => {
      loads += 1;
      if (loads === 2) throw new Error("Network down.");
      return twoOwners;
    });
    mocks.api = {
      getViewerInfo: viewerWithoutOrgs,
      getContextCollectionSharing,
      getContextCollectionPermissions: async () => ownerPermissions,
      setContextCollectionMemberRole: async () => {
        throw new Error("Access was changed, but Git tokens could not be revoked yet.");
      },
    } as unknown as ContextApi;
    const onChanged = vi.fn<() => void>();
    root = await renderDialog(onChanged);

    await choose(document.querySelector<HTMLElement>("[aria-label='Role for Bob']"), "Can edit");
    await flush();
    expect(document.body.textContent).toContain("Git tokens could not be revoked yet");
    expect(document.body.textContent).toContain("Network down.");
    expect(document.body.textContent).toContain("Bob");
    expect(button("Select users")?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("[aria-label='Role for Bob']")?.disabled).toBe(true);

    await act(async () => button("Retry")?.click());
    await flush();
    expect(getContextCollectionSharing).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).not.toContain("Network down.");
    expect(button("Select users")?.disabled).toBe(false);

    act(() => mocks.closeDialog?.());
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation before the current member leaves and preserves partial-leave errors", async () => {
    const leaveContextCollection = vi.fn<ContextApi["leaveContextCollection"]>(async () => {
      throw new Error("Access was changed, but Git tokens could not be revoked yet.");
    });
    mocks.api = {
      getViewerInfo: viewerWithoutOrgs,
      getContextCollectionSharing: async () => ({
        members: [{ memberId: "me", role: "editor", isViewer: true }],
        everyoneCanView: true,
        hasOwner: false,
      }),
      getContextCollectionPermissions: async () => ({ ...ownerPermissions, canManageOwners: false }),
      leaveContextCollection,
    } as unknown as ContextApi;
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<PartialLeaveParent />));

    await choose(document.querySelector("[aria-label='Role for you']"), "Leave collection");
    expect(leaveContextCollection).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("permanently deletes");
    expect(document.body.textContent).toContain("even if anyone in the organization can view it");
    await act(async () => button("Cancel")?.click());
    expect(button("Leave")).toBeUndefined();
    expect(leaveContextCollection).not.toHaveBeenCalled();
    await choose(document.querySelector("[aria-label='Role for you']"), "Leave collection");
    await act(async () => button("Leave")?.click());
    expect(document.body.textContent).toContain("Library refreshed");
    expect(document.body.textContent).toContain("Git tokens could not be revoked yet");
    expect(button("Leave")).toBeDefined();
  });

  it("keeps old-role actions disabled until both sharing and permissions have refreshed", async () => {
    const refreshedSharing = deferred<ContextCollectionSharing>();
    const refreshedPermissions = deferred<typeof ownerPermissions>();
    let changed = false;
    mocks.api = {
      getViewerInfo: viewerWithoutOrgs,
      getContextCollectionSharing: () => changed ? refreshedSharing.promise : Promise.resolve(twoOwners),
      getContextCollectionPermissions: () => changed ? refreshedPermissions.promise : Promise.resolve(ownerPermissions),
      setContextCollectionMemberRole: async () => { changed = true; },
    } as unknown as ContextApi;
    root = await renderDialog();

    await choose(document.querySelector("[aria-label='Role for you']"), "Can edit");
    expect(button("Select users")?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("[aria-label='Role for Bob']")?.disabled).toBe(true);
    await act(async () => refreshedSharing.resolve({
      ...twoOwners,
      members: twoOwners.members.map((member) => member.isViewer ? { ...member, role: "editor" } : member),
    }));
    expect(button("Select users")?.disabled).toBe(true);
    await act(async () => refreshedPermissions.resolve({ ...ownerPermissions, canManageOwners: false }));
    expect(button("Select users")?.disabled).toBe(false);
    expect(document.querySelector("[aria-label='Role for Bob']")).toBeNull();
  });

  it.each([false, true])("reconciles late picker deliveries after cancellation (cleanup rejects: %s)", async (rejectCleanup) => {
    const delivery = deferred<void>();
    const picker = deferred<void>();
    let delivered = false;
    let receiver: UserSelectionReceiver | undefined;
    mocks.api = {
      getViewerInfo: viewerWithoutOrgs,
      getContextCollectionSharing: async () => delivered ? {
        ...sharing,
        members: [...sharing.members, { memberId: "late", role: "viewer", displayName: "Late arrival", isViewer: false }],
      } : sharing,
      getContextCollectionPermissions: async () => ownerPermissions,
      shareContextCollection: async () => {
        await delivery.promise;
        delivered = true;
        if (rejectCleanup) throw new Error("Grant saved, cleanup failed.");
      },
    } as unknown as ContextApi;
    mocks.selectUsers = (picked) => { receiver = picked; return picker.promise; };
    root = await renderDialog();
    await act(async () => button("Select users")?.click());
    const receive = receiver!.receive({ ticket: "late" });
    const outcome = receive.catch(() => {});
    await act(async () => picker.resolve());
    expect(document.body.textContent).not.toContain("Late arrival");
    expect(button("Select users")?.disabled).toBe(false);

    await act(async () => { delivery.resolve(); await outcome; });
    expect(document.body.textContent).toContain("Late arrival");
    expect(button("Select users")?.disabled).toBe(false);
  });

  it("refreshes the parent listing when a delivery finishes after Share has closed", async () => {
    const delivery = deferred<void>();
    const picker = deferred<void>();
    let memberCount = 1;
    let receiver: UserSelectionReceiver | undefined;
    mocks.api = {
      getViewerInfo: viewerWithoutOrgs,
      getContextCollectionSharing: async () => sharing,
      getContextCollectionPermissions: async () => ownerPermissions,
      shareContextCollection: async () => { await delivery.promise; memberCount = 2; },
    } as unknown as ContextApi;
    mocks.selectUsers = (picked) => { receiver = picked; return picker.promise; };
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const Parent = () => {
      const [open, setOpen] = React.useState(true);
      const [count, setCount] = React.useState(memberCount);
      return <>
        <p>Members in library: {count}</p>
        {open && <ShareCollectionDialog
          collection={{ id: "collection", title: "Engineering" }}
          onChanged={() => setCount(memberCount)}
          onLeft={() => {}}
          onClose={() => setOpen(false)}
        />}
      </>;
    };
    await act(async () => root?.render(<Parent />));
    await act(async () => button("Select users")?.click());
    const receive = receiver!.receive({ ticket: "late" });
    await act(async () => picker.resolve());
    act(() => mocks.closeDialog?.());
    expect(document.body.textContent).toContain("Members in library: 1");
    await act(async () => { delivery.resolve(); await receive; });
    expect(document.body.textContent).toContain("Members in library: 2");
    expect(button("Select users")).toBeUndefined();
  });

  it("offers the viewer's ungranted orgs and shares with the chosen role, surfacing refusals", async () => {
    const shareContextCollectionWithOrg = vi.fn<ContextApi["shareContextCollectionWithOrg"]>(async () => {});
    mocks.api = {
      getViewerInfo: async () => ({
        isAdmin: false,
        supportsGitCollections: false,
        orgs: [
          { orgId: "org-1", role: "member" },
          { orgId: "org-granted", role: "admin" },
        ],
      }),
      getContextCollectionSharing: async () => ({
        members: [
          { memberId: "me", role: "owner", displayName: "Ada", isViewer: true },
          { memberId: "org-granted", subject: "org" as const, role: "editor", isViewer: false },
        ],
        everyoneCanView: false,
        hasOwner: true,
      }),
      getContextCollectionPermissions: async () => ownerPermissions,
      shareContextCollectionWithOrg,
    } as unknown as ContextApi;
    root = await renderDialog();

    // An org that already holds a grant is a member row, never an add target again.
    expect(document.body.textContent).toContain("Organization org-granted");

    await choose(addRole(), "Owner");
    await choose(addOrg(), "Organization org-1");
    expect(shareContextCollectionWithOrg).toHaveBeenCalledWith("collection", "org-1", "owner");

    shareContextCollectionWithOrg.mockRejectedValueOnce(
      new Error("You must belong to an organization to give it access to this collection."));
    await choose(addOrg(), "Organization org-1");
    expect(document.body.textContent)
      .toContain("You must belong to an organization to give it access to this collection.");
  });

  it("changes an org grant's role through its member row", async () => {
    const setContextCollectionMemberRole = vi.fn<ContextApi["setContextCollectionMemberRole"]>(async () => {});
    mocks.api = {
      getViewerInfo: viewerWithoutOrgs,
      getContextCollectionSharing: async () => ({
        members: [
          { memberId: "me", role: "owner", displayName: "Ada", isViewer: true },
          { memberId: "org-9", subject: "org" as const, role: "editor", isViewer: false },
        ],
        everyoneCanView: false,
        hasOwner: true,
      }),
      getContextCollectionPermissions: async () => ownerPermissions,
      setContextCollectionMemberRole,
    } as unknown as ContextApi;
    root = await renderDialog();

    await choose(document.querySelector<HTMLElement>("[aria-label='Role for Organization org-9']"), "Can view");
    expect(setContextCollectionMemberRole).toHaveBeenCalledWith("collection", "org-9", "viewer");
  });
});
