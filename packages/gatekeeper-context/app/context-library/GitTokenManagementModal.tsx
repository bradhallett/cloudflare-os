/** Modal for managing the git tokens backing a git-synced collection. */

import { Dialog, useKumoToastManager } from "@cloudflare/kumo";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextGitTokenCreateResult, ContextGitTokenInfo } from "../../src/context-types";
import { useContextApi, usePresentWhileOpen } from "../bridge";
import { FieldLabel, ModalHeader, WorkshopButton } from "./ui";

export function GitTokenManagementModal({
  open,
  collectionId,
  branch,
  onClose,
}: {
  open: boolean;
  collectionId: string;
  branch: string;
  onClose: () => void;
}) {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const toastsRef = useRef(toasts);
  const { presenting, onOpenChangeComplete } = usePresentWhileOpen(open);

  const [loadingTokens, setLoadingTokens] = useState(false);
  const [creatingToken, setCreatingToken] = useState(false);
  const [revokingToken, setRevokingToken] = useState<string | null>(null);
  const [gitTokens, setGitTokens] = useState<ContextGitTokenInfo[]>([]);
  const [newGitToken, setNewGitToken] = useState<ContextGitTokenCreateResult | null>(null);

  toastsRef.current = toasts;

  useEffect(() => {
    if (open) {
      setLoadingTokens(false);
      setCreatingToken(false);
      setRevokingToken(null);
      setGitTokens([]);
      setNewGitToken(null);
    }
  }, [open]);

  const loadGitTokens = useCallback(async () => {
    if (!open) return;
    setLoadingTokens(true);
    try {
      const result = await context.listContextCollectionGitTokens(collectionId);
      setGitTokens(result.tokens);
    } catch (err) {
      toastsRef.current.add({ title: `Failed to load Git tokens: ${(err as Error).message}`, variant: "error" });
    } finally {
      setLoadingTokens(false);
    }
  }, [open, context, collectionId]);

  useEffect(() => {
    void loadGitTokens();
  }, [loadGitTokens]);

  const handleCreateGitToken = async () => {
    setCreatingToken(true);
    try {
      const token = await context.createContextCollectionGitToken(collectionId);
      setNewGitToken(token);
      await loadGitTokens();
      toasts.add({ title: "Git token created", variant: "success" });
    } catch (err) {
      toasts.add({ title: `Failed to create Git token: ${(err as Error).message}`, variant: "error" });
    } finally {
      setCreatingToken(false);
    }
  };

  const handleRevokeGitToken = async (tokenId: string) => {
    setRevokingToken(tokenId);
    try {
      await context.revokeContextCollectionGitToken(collectionId, tokenId);
      await loadGitTokens();
      toasts.add({ title: "Git token revoked", variant: "success" });
    } catch (err) {
      toasts.add({ title: `Failed to revoke Git token: ${(err as Error).message}`, variant: "error" });
    } finally {
      setRevokingToken(null);
    }
  };

  const copyToClipboard = (value: string, successTitle: string, errorTitle: string) =>
    void navigator.clipboard
      .writeText(value)
      .then(() => toasts.add({ title: successTitle, variant: "success" }))
      .catch(() => toasts.add({ title: errorTitle, variant: "error" }));

  const busy = creatingToken || revokingToken !== null;

  return (
    <Dialog.Root
      open={open && presenting}
      onOpenChange={(next: boolean) => {
        if (!busy && !next) onClose();
      }}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <Dialog
        className="z-[1000]! w-[min(560px,calc(100vw-32px))]! overflow-visible bg-kumo-base p-0 top-[14%]! translate-y-0!"
        size="sm"
      >
        <ModalHeader
          title="Manage git tokens"
        />

        <div className="space-y-3 px-4 py-5 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <p className="max-w-sm text-[12px] leading-4 text-kumo-subtle">
              Create a token to mirror content from an external git repository.
            </p>
            <WorkshopButton
              tone="secondary"
              className="h-8!"
              onClick={handleCreateGitToken}
              loading={creatingToken}
              disabled={busy}
            >
              Create token
            </WorkshopButton>
          </div>

          {newGitToken && (
            <div className="space-y-3 rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-3 text-[12px] leading-5 text-kumo-subtle">
              <div>
                <div className="font-medium text-kumo-default">Token created</div>
                <p className="mt-0.5">
                  Use these credentials to push content to your collection. The password is only shown once.
                </p>
              </div>
              <div className="space-y-2">
                <div>
                  <FieldLabel>Remote URL</FieldLabel>
                  <div className="mt-1 flex gap-2">
                    <input
                      readOnly
                      value={newGitToken.remote}
                      className="min-w-0 flex-1 rounded border border-kumo-line bg-kumo-base px-2 py-1 font-mono text-[11px] text-kumo-default"
                    />
                    <WorkshopButton
                      tone="secondary"
                      className="h-8!"
                      onClick={() => copyToClipboard(newGitToken.remote, "Remote URL copied", "Failed to copy remote URL")}
                    >
                      Copy
                    </WorkshopButton>
                  </div>
                </div>
                <div>
                  <FieldLabel>Password</FieldLabel>
                  <div className="mt-1 flex gap-2">
                    <input
                      readOnly
                      type="password"
                      value={newGitToken.plaintext}
                      className="min-w-0 flex-1 rounded border border-kumo-line bg-kumo-base px-2 py-1 font-mono text-[11px] text-kumo-default"
                    />
                    <WorkshopButton
                      tone="secondary"
                      className="h-8!"
                      onClick={() => copyToClipboard(newGitToken.plaintext, "Password copied", "Failed to copy password")}
                    >
                      Copy
                    </WorkshopButton>
                  </div>
                </div>
              </div>
              <div className="border-t border-green-500/20 pt-3">
                <div className="font-medium text-kumo-default">Configure GitLab mirroring</div>
                <p className="mt-0.5">
                  These steps are specific to GitLab. Other git providers may use different setup flows.
                </p>
                <ol className="mt-2 list-decimal space-y-1.5 pl-4">
                  <li>Open your GitLab project and go to Settings &gt; Repository &gt; Mirroring repositories</li>
                  <li>Click "Add new" button to open setup flow</li>
                  <li>Set Git repository URL to the remote URL above</li>
                  <li>Set Mirror direction to Push</li>
                  <li>Set Authentication method to Username and Password</li>
                  <li>Set Username to "gitlab"</li>
                  <li>Set Password to the password above</li>
                  <li>Select Mirror specific branches and type in "{branch}"</li>
                  <li>Click "Mirror repository" button to finish</li>
                  <li>Click "Update now" button to trigger an initial push</li>
                </ol>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-kumo-line bg-kumo-base">
            {loadingTokens ? (
              <div className="px-3 py-2 text-[12px] text-kumo-subtle">Loading tokens...</div>
            ) : gitTokens.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-kumo-subtle">No Git tokens yet.</div>
            ) : (
              <div className="divide-y divide-kumo-line">
                {gitTokens.map((token) => (
                  <div
                    key={token.id}
                    className={`flex items-center justify-between gap-3 px-3 py-2 text-[12px] ${newGitToken?.id === token.id ? "bg-green-500/5" : ""}`}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[11px] text-kumo-default">{token.id}</div>
                      <div className="text-kumo-subtle">
                        expires {new Date(token.expiresAt).toLocaleDateString()}
                      </div>
                    </div>
                    <WorkshopButton
                      tone="secondary"
                      className="h-8!"
                      onClick={() => void handleRevokeGitToken(token.id)}
                      loading={revokingToken === token.id}
                      disabled={revokingToken !== null}
                    >
                      Revoke
                    </WorkshopButton>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
          <WorkshopButton tone="secondary" className="h-9!" disabled={busy} onClick={onClose}>
            Close
          </WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
