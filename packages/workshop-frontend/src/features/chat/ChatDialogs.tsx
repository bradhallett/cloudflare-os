import { Suspense, type ComponentProps, type ReactNode } from "react";
import { Dialog } from "@cloudflare/kumo";
import { X } from "@phosphor-icons/react";
import { RpcStub } from "capnweb";
import type { Overseer, PlanRefusalCode } from "@gadgets/workshop-shared/api";
import type { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import GatekeeperModal from "../../GatekeeperModal";
import DeleteConfirmationDialog from "../../components/DeleteConfirmationDialog";
import AutoApproveConfirmDialog from "../../components/AutoApproveConfirmDialog";
import { WorkshopButton, WorkshopIconButton } from "../../components/WorkshopControls";
import OutOfCreditsModal from "../../components/billing/OutOfCreditsModal";
import { SaasUpgradeModal } from "../saas/commerceGate";
import type { UnresolvedConflict } from "./mergeConflicts";
import { UnresolvedConflictsDialog } from "./UnresolvedConflictsDialog";
import type { AutoApproveTarget } from "./transcript/ActionCard";

type GatekeeperCreated = ComponentProps<typeof GatekeeperModal>["onCreated"];

/** Props for {@link ChatDialogs}: the chat-level modals and dialogs rendered above the page. */
export interface ChatDialogsProps {
  /** The chat whose accept came back stale, or null when the dialog is closed. */
  staleAcceptChatId: number | null;
  setStaleAcceptChatId: (id: number | null) => void;
  isUpdatingFromMainline: boolean;
  handleUpdateFromMainline: () => Promise<void>;
  /** Conflict markers that held up an accept, awaiting the user's decision. */
  unresolvedConflicts: UnresolvedConflict[] | null;
  setUnresolvedConflicts: (conflicts: UnresolvedConflict[] | null) => void;
  handleMergeChanges: () => Promise<void>;
  deleteTarget: { id: number; title: string } | null;
  setDeleteTarget: (target: { id: number; title: string } | null) => void;
  isDeleting: boolean;
  handleDeleteConfirm: () => Promise<void>;
  /** True once the workspace has read restricted data; latched auto-approval is then hidden. */
  restricted: boolean | undefined;
  autoApproveConfirm: AutoApproveTarget | null;
  processingActions: Set<number>;
  setAutoApproveConfirm: (target: AutoApproveTarget | null) => void;
  alwaysApproveTag: (
    actionId: number,
    gatekeeperId: number,
    actionKind: ActionKind,
  ) => Promise<boolean>;
  /** The account-choice modal for a pending creation, rendered as-is when present. */
  creationAccountModal: ReactNode;
  connectionAccept: {
    requestId: string;
    vendorId: string;
    resourceUrl?: string;
    resourceUrlPattern?: string;
  } | null;
  setConnectionAccept: (
    accept: {
      requestId: string;
      vendorId: string;
      resourceUrl?: string;
      resourceUrlPattern?: string;
    } | null,
  ) => void;
  getOverseer: () => RpcStub<Overseer>;
  handleConnectionCreated: GatekeeperCreated;
  usageModalOpen: boolean;
  setUsageModalOpen: (open: boolean) => void;
  /** What opened the usage modal — the usage_limit surface or a plan-refusal code. */
  usageModalReason: "usage_limit" | PlanRefusalCode;
}
/**
 * The chat's modal layer: the stale-accept (update-from-mainline) dialog, unresolved-conflict
 * dialog, delete confirmation, auto-approve confirmation, the creation account modal, the
 * connection-request GatekeeperModal, and the out-of-credits modal. Extracted verbatim from
 * ChatInterface; each dialog's RPC flow stays in the shell and arrives as callbacks.
 */
export function ChatDialogs({
  staleAcceptChatId,
  setStaleAcceptChatId,
  isUpdatingFromMainline,
  handleUpdateFromMainline,
  unresolvedConflicts,
  setUnresolvedConflicts,
  handleMergeChanges,
  deleteTarget,
  setDeleteTarget,
  isDeleting,
  handleDeleteConfirm,
  restricted,
  autoApproveConfirm,
  processingActions,
  setAutoApproveConfirm,
  alwaysApproveTag,
  creationAccountModal,
  connectionAccept,
  setConnectionAccept,
  getOverseer,
  handleConnectionCreated,
  usageModalOpen,
  setUsageModalOpen,
  usageModalReason,
}: ChatDialogsProps) {
  return (
    <>
      {/* An accept came back stale: mainline advanced past this chat's pins, so the changes can
          only land after merging the gadget's current version into the chat first. */}
      <Dialog.Root
        open={staleAcceptChatId !== null}
        onOpenChange={(nextOpen) => {
          if (!isUpdatingFromMainline && !nextOpen) setStaleAcceptChatId(null);
        }}
      >
        <Dialog
          className="!z-[1000] !w-[min(440px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0 !top-[20%] !-translate-y-0"
          size="sm"
        >
          <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
                The gadget changed since this draft started
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
                Someone else&apos;s changes were accepted in the meantime, so this draft&apos;s
                changes can&apos;t be applied as-is. Bring the latest changes into this draft
                first; any conflicts will be marked in the code for you (or the agent) to resolve
                before accepting again.
              </Dialog.Description>
            </div>
            <Dialog.Close
              render={(props) => (
                <WorkshopIconButton
                  {...props}
                  className="!h-7 !w-7"
                  disabled={isUpdatingFromMainline}
                  aria-label="Close"
                >
                  <X size={16} />
                </WorkshopIconButton>
              )}
            />
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-kumo-line bg-kumo-base px-5 py-3">
            <Dialog.Close
              render={(props) => (
                <WorkshopButton
                  {...props}
                  className="!h-9"
                  disabled={isUpdatingFromMainline}
                >
                  Not now
                </WorkshopButton>
              )}
            />
            <WorkshopButton
              tone="primary"
              onClick={() => { void handleUpdateFromMainline(); }}
              disabled={isUpdatingFromMainline}
              className="!h-9 min-w-[64px]"
            >
              {isUpdatingFromMainline ? "Updating..." : "Bring in latest changes"}
            </WorkshopButton>
          </div>
        </Dialog>
      </Dialog.Root>

      {unresolvedConflicts !== null && (
        <UnresolvedConflictsDialog
          conflicts={unresolvedConflicts}
          onCancel={() => setUnresolvedConflicts(null)}
          onAcceptAnyway={() => {
            setUnresolvedConflicts(null);
            void handleMergeChanges();
          }}
        />
      )}

      <DeleteConfirmationDialog
        open={deleteTarget !== null}
        title="Delete conversation?"
        description={<>This removes <span className="font-medium text-kumo-default">{deleteTarget?.title}</span>. You can&apos;t undo this.</>}
        isDeleting={isDeleting}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={handleDeleteConfirm}
      />

      {/* The workspace latched: the affordance is gone and confirming could only error. */}
      {!restricted && autoApproveConfirm && (
        <AutoApproveConfirmDialog
          open
          actionLabel={autoApproveConfirm.actionLabel}
          resourceTitle={autoApproveConfirm.resourceTitle}
          isProcessing={processingActions.has(autoApproveConfirm.actionId)}
          onOpenChange={(open) => {
            if (!open) setAutoApproveConfirm(null);
          }}
          onConfirm={async () => {
            const { actionId, gatekeeperId, actionKind } = autoApproveConfirm;
            if (await alwaysApproveTag(actionId, gatekeeperId, actionKind)) {
              setAutoApproveConfirm(null);
            }
          }}
        />
      )}

      {creationAccountModal}

      {/* Accept flow for an agent connection request: pre-seeds the gatekeeper modal and, on
          creation, finalizes the request so the agent resumes. */}
      <GatekeeperModal
        open={connectionAccept !== null}
        onClose={() => setConnectionAccept(null)}
        getOverseer={getOverseer}
        onCreated={handleConnectionCreated}
        initialVendorId={connectionAccept?.vendorId}
        initialResourceUrl={connectionAccept?.resourceUrl}
        initialResourceUrlPattern={connectionAccept?.resourceUrlPattern}
      />
      {/* In a SaaS build the upgrade prompt replaces the out-of-credits modal at the same
          enforcement surface; the gate folds this choice to the OSS modal in OSS builds. */}
      {SaasUpgradeModal ? (
        <Suspense fallback={null}>
          <SaasUpgradeModal
            open={usageModalOpen}
            onClose={() => setUsageModalOpen(false)}
            reason={usageModalReason}
          />
        </Suspense>
      ) : (
        <OutOfCreditsModal
          open={usageModalOpen}
          onClose={() => setUsageModalOpen(false)}
        />
      )}
    </>
  );
}