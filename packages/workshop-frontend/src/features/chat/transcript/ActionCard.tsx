import type { ActionLogEntry } from "@gadgets/workshop-shared/api";
import { ActionKind } from "@gadgets/workshop-shared/gatekeeper";
import { CaretRight, Check, LinkSimple, MagnifyingGlass, ShieldCheck, X } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import { ActionFields, entryFields } from "../../../components/ActionFields";
import { GatekeeperIcon } from "../../../components/GatekeeperIcon";
import { HookToggle } from "../../../components/HookToggle";
import {
  IncompleteDescriptionNotice,
  isDescriptionIncomplete,
} from "../../../components/IncompleteDescriptionNotice";
import { AlwaysApproveButton, ResolveButton, type ResolveClickResult } from "../../../components/ResolveButton";
import { RestrictedApprovalNotice } from "../../../components/RestrictedApprovalNotice";
import { safeExternalUrl } from "../../../utils/safeExternalUrl";
import styles from "../../../ChatInterface.module.css";
import { MarkdownMessage } from "../markdown/MarkdownMessage";
import type { ActionChatMessage } from "./messageTypes";
import { WorkIcon } from "./WorkIcon";

type ActionDecision = "approve" | "deny";

/** The pending "always approve this type" confirmation a card asks the shell to open. */
export type AutoApproveTarget = {
  actionId: number;
  gatekeeperId: number;
  resourceTitle: string;
  actionKind: ActionKind;
  actionLabel: string;
};

/**
 * The transcript card for an "action" message: a gatekeeper permission request (pending,
 * blocking callout when it awaits a decision), an observation, or a hook-binding record.
 */
export function ActionCard({
  msg,
  restricted,
  open,
  isProcessing,
  onToggleExpansion,
  onResolve,
  onAlwaysApprove,
  isTagAutoApproved,
  onToggleHook,
}: {
  msg: ActionChatMessage;
  restricted: boolean;
  open: boolean;
  isProcessing: boolean;
  onToggleExpansion: (actionId: number) => void;
  onResolve: (log: ActionLogEntry, decision: ActionDecision) => ResolveClickResult;
  onAlwaysApprove: (target: AutoApproveTarget) => void;
  isTagAutoApproved: (gatekeeperId: number, tag: string) => boolean;
  onToggleHook: (actionId: number, hookId: number, enabled: boolean) => void;
}) {
  const log = msg.actionLog;
  if (!log) return null;

  const isAct = log.type === "action";
  const state = log.state;
  const isProc = isProcessing;
  const safeResourceUrl = safeExternalUrl(log.resourceUrl);

  if (log.type === "bindHook") {
    const isDeleted = log.hookId === undefined;
    const stateLabel = isDeleted
      ? "Deleted"
      : log.enabled
        ? "Enabled"
        : "Disabled";
    const stateLabelCls = isDeleted
      ? "text-kumo-inactive"
      : log.enabled
        ? "text-kumo-success"
        : "text-kumo-subtle";

    return (
      <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
        <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-3">
          <div className="flex items-start gap-3">
            <GatekeeperIcon
              fallbackText={log.resourceTitle}
              className="h-9 w-9 flex-shrink-0 rounded-lg"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium text-kumo-default">
                  Hook: {log.description.title}
                </span>
                <span className={`text-[12px] font-medium ${stateLabelCls}`}>
                  {stateLabel}
                </span>
              </div>
              {log.description.description && (
                <div className={`mt-1 text-[13px] leading-[18px] text-kumo-subtle ${styles.markdownContent}`}>
                  <MarkdownMessage message={log.description.description} />
                </div>
              )}
              {log.resourceTitle && (
                <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-4 text-kumo-inactive">
                  <span className="min-w-0 truncate">
                    {safeResourceUrl ? (
                      <a
                        href={safeResourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {log.resourceTitle}
                      </a>
                    ) : (
                      log.resourceTitle
                    )}
                  </span>
                </div>
              )}
            </div>
            {!isDeleted && (
              <div className="ml-3 flex flex-shrink-0 items-center self-center">
                <HookToggle
                  hookTitle={log.description.title}
                  enabled={log.enabled}
                  pending={isProc}
                  onToggle={(enabled) => onToggleHook(msg.actionId, log.hookId!, enabled)}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (!isAct) {
    const metadata = log.resourceTitle;

    return (
      <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
        <button
          type="button"
          onClick={() => onToggleExpansion(msg.actionId)}
          className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
          aria-expanded={open}
        >
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
            <WorkIcon Icon={MagnifyingGlass} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 truncate">{log.description.title}</span>
              <CaretRight
                size={13}
                weight="bold"
                className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
              />
            </span>
            {metadata && (
              <span className="mt-1 block truncate text-[12px] leading-4 text-kumo-inactive">
                {metadata}
              </span>
            )}
          </span>
        </button>
        {open && (
          <div className="themed-surface-inset ml-8 mt-1 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3 text-[13px] leading-[19px] text-kumo-subtle">
            <MarkdownMessage message={log.description.description} />
            <ActionFields fields={entryFields(log)} className="mt-2" />
          </div>
        )}
      </div>
    );
  }

  const isPending = state === "pending";
  const isApproved = state === "approved";
  const isRejected = state === "rejected";
  // A blocking (awaitDecision) pending action suspends the agent turn and blocks the composer, so
  // present it as a prominent callout with its details expanded by default.
  const isBlocking = isPending && log.description.awaitDecision === true;
  // A pending request is never collapsed: its description is the thing the user has to read in
  // order to answer it, so hiding it behind a disclosure would just add a step before every
  // decision. Resolved actions are history, and collapse so a long thread stays scannable.
  const showDescription = isPending || open;
  const metadata = log.resourceTitle;
  const stateLabel = isApproved
    ? "Approved"
    : isRejected
      ? "Denied"
      : null;
  const stateLabelCls = isRejected
    ? "text-kumo-danger"
    : "text-kumo-inactive";
  // Auto-approval target: offer "Always approve this type" only when enabling a rule would
  // actually apply this action -- a tagged action on a connection that the gatekeeper marked
  // auto-approvable. (A non-auto-approvable action stays a manual gate even with a rule; an
  // auto-approvable action with an existing rule wouldn't still be pending.) Not offered while
  // restricted.
  const autoApproveTarget =
    !restricted &&
    log.gatekeeperId !== undefined && log.description.actionKind !== undefined &&
    log.description.autoApprovable === true
      ? {
          actionId: msg.actionId,
          gatekeeperId: log.gatekeeperId,
          resourceTitle: log.resourceTitle,
          actionKind: log.description.actionKind,
          actionLabel: log.description.title,
        }
      : undefined;

  // While restricted the notices and the request follow the controls in DOM order, so the
  // approve/deny buttons name them as their description. Ids derive from the action id: kept from
  // the render closure this card was extracted from (useId would change them), one card renders
  // per action.
  const restrictedReview = restricted && isPending;
  const noticeId = `action-${msg.actionId}-restricted-notice`;
  const requestId = `action-${msg.actionId}-request`;
  const fieldsId = `action-${msg.actionId}-fields`;
  const incompleteId = `action-${msg.actionId}-incomplete-notice`;
  const hasFields = entryFields(log).length > 0;
  const incomplete = isPending && isDescriptionIncomplete(log);
  const describedBy = restrictedReview
    ? [
      noticeId,
      requestId,
      ...(hasFields ? [fieldsId] : []),
      ...(incomplete ? [incompleteId] : []),
    ].join(" ")
    : undefined;

  const actionControls = isPending ? (
    <>
      {autoApproveTarget &&
        !isTagAutoApproved(autoApproveTarget.gatekeeperId, autoApproveTarget.actionKind.tag) && (
        <Tooltip content="Always approve this type of action on this connection, without future prompts." asChild>
          <span className="flex">
            <AlwaysApproveButton
              onClick={() => onAlwaysApprove(autoApproveTarget)}
              disabled={isProc}
            />
          </span>
        </Tooltip>
      )}
      <ResolveButton
        tone="deny"
        onClick={() => onResolve(log, "deny")}
        disabled={isProc}
        describedBy={describedBy}
      />
      <ResolveButton
        tone="approve"
        variant={isBlocking ? "filled" : "quiet"}
        onClick={() => onResolve(log, "approve")}
        disabled={isProc}
        describedBy={describedBy}
      />
    </>
  ) : null;

  // Resource label, shown at the top of the blocking callout and at the bottom of the subtle
  // inline row.
  const resourceMeta = metadata ? (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-4 text-kumo-inactive">
      {log.resourceTitle && (
        <span className="min-w-0 truncate">
          {safeResourceUrl ? (
            <a
              href={safeResourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
              onClick={(e) => e.stopPropagation()}
            >
              {log.resourceTitle}
            </a>
          ) : (
            log.resourceTitle
          )}
        </span>
      )}
    </div>
  ) : null;

  // A blocking (awaitDecision) action suspends the agent turn, so present it as a prominent
  // callout laid out like the connection-request card: a permissions icon, title + resource +
  // details, and the approve/deny actions.
  if (isBlocking) {
    return (
      <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
        <div className="rounded-2xl border border-kumo-brand/40 bg-kumo-brand/10 px-4 py-3">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-kumo-tint text-kumo-brand" aria-hidden="true">
              <ShieldCheck size={20} weight="fill" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="min-w-0 truncate font-medium text-kumo-default">
                  {log.description.title}
                </span>
                {resourceMeta}
              </div>
              {restricted && <RestrictedApprovalNotice id={noticeId} className="mt-2" />}
              <div id={requestId} className={`chat-panel mt-1 pr-1 text-[13px] leading-[18px] text-kumo-subtle ${restricted ? "" : "max-h-[200px] overflow-y-auto"} ${styles.markdownContent}`}>
                <MarkdownMessage message={log.description.description} />
              </div>
              {hasFields && (
                <div id={fieldsId} className={`chat-panel mt-2 pr-1 ${restricted ? "" : "max-h-[360px] overflow-y-auto"}`}>
                  <ActionFields fields={entryFields(log)} uncapped={restricted} />
                </div>
              )}
              {incomplete && <IncompleteDescriptionNotice id={incompleteId} className="mt-2" />}
            </div>
            <div className="ml-3 flex flex-shrink-0 items-center gap-1 self-center">
              {actionControls}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const titleIcon = (
    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center" aria-hidden="true">
      {isPending ? (
        <span className="h-1.5 w-1.5 rounded-full bg-kumo-brand" />
      ) : (
        <WorkIcon Icon={LinkSimple} />
      )}
    </span>
  );

  return (
    <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
      {isPending ? (
        <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-1.5 py-1">
          <div className="flex min-w-[8rem] flex-1 items-center gap-3">
            {titleIcon}
            <span className="min-w-0 flex-1 truncate text-kumo-default">
              {log.description.title}
            </span>
          </div>
          <div className="ml-auto flex flex-shrink-0 items-center gap-0.5">{actionControls}</div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onToggleExpansion(msg.actionId)}
          className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none"
          aria-expanded={open}
        >
          {titleIcon}
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 truncate">{log.description.title}</span>
            {stateLabel && (
              <span
                className={`flex flex-shrink-0 items-center gap-0.5 text-[12px] font-medium ${stateLabelCls} ${styles.resolvedBadge}`}
              >
                {isApproved ? (
                  <Check size={11} weight="bold" aria-hidden="true" />
                ) : (
                  <X size={11} weight="bold" aria-hidden="true" />
                )}
                {stateLabel}
              </span>
            )}
            <CaretRight
              size={13}
              weight="bold"
              className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
            />
          </span>
        </button>
      )}
      {showDescription && (
        <div className="themed-surface-inset ml-8 mt-1 space-y-1.5 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3 text-[13px] leading-[19px] tracking-[-0.25px] text-kumo-subtle">
          {restrictedReview && <RestrictedApprovalNotice id={noticeId} />}
          <div id={requestId} className={`chat-panel pr-1 ${restrictedReview ? "" : "max-h-[200px] overflow-y-auto"} ${styles.markdownContent}`}>
            <MarkdownMessage message={log.description.description} />
          </div>
          {hasFields && (
            <div id={fieldsId} className={`chat-panel pr-1 ${restrictedReview ? "" : "max-h-[360px] overflow-y-auto"}`}>
              <ActionFields fields={entryFields(log)} uncapped={restrictedReview} />
            </div>
          )}
          {incomplete && <IncompleteDescriptionNotice id={incompleteId} />}
          {resourceMeta}
        </div>
      )}
    </div>
  );
}
