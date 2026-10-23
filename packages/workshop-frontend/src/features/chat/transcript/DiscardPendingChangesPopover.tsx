import { ArrowUUpLeft } from "@phosphor-icons/react";
import { Popover } from "@cloudflare/kumo";

/** The "Discard…" button and its confirmation popover for all pending changes at once. */
export function DiscardPendingChangesPopover({
  open,
  disabled,
  isDiscarding,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  disabled: boolean;
  isDiscarding: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        render={
          <button
            type="button"
            disabled={disabled}
            className="inline-flex h-[30px] cursor-pointer items-center justify-center rounded-md border border-kumo-fill bg-kumo-base px-2.5 text-[12px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default transition-colors enabled:hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            Discard…
          </button>
        }
      />
      <Popover.Content
        align="center"
        side="top"
        sideOffset={8}
        positionMethod="fixed"
        className="themed-floating-shadow !z-[1100] !w-[min(300px,calc(100vw-24px))] !min-w-0 overflow-hidden rounded-xl border border-kumo-line bg-kumo-base !p-0 !outline-none [&>:first-child]:hidden"
      >
        <div className="px-3.5 pb-2.5 pt-3">
          <Popover.Title className="text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default">
            Discard all pending changes?
          </Popover.Title>
          <p className="mt-0.5 text-[11.5px] leading-4 tracking-[-0.15px] text-kumo-subtle">
            Return to the last accepted version. Any gadgets or worktrees created by these
            changes will be permanently deleted. Pending changes can&apos;t be restored.
          </p>
          <p className="mt-2 border-t border-kumo-line pt-2 text-[11px] leading-[15px] tracking-[-0.1px] text-kumo-inactive">
            Use the <ArrowUUpLeft size={12} className="mx-0.5 inline-block align-[-2px]" aria-hidden="true" /><span className="sr-only">undo arrow</span> under any agent response to discard from that turn onward.
          </p>
        </div>
        <div className="flex items-center justify-end gap-0.5 border-t border-kumo-line px-2 py-1.5">
          <button
            type="button"
            disabled={isDiscarding}
            onClick={() => onOpenChange(false)}
            className="flex h-6 cursor-pointer items-center rounded-md px-2 text-[12px] font-medium tracking-[-0.15px] text-kumo-inactive transition-colors enabled:hover:bg-kumo-tint enabled:hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={disabled || isDiscarding}
            onClick={onConfirm}
            className="flex h-6 cursor-pointer items-center rounded-md px-2 text-[12px] font-medium tracking-[-0.15px] text-kumo-default transition-colors enabled:hover:bg-kumo-tint enabled:hover:text-kumo-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isDiscarding ? "Discarding..." : "Discard changes"}
          </button>
        </div>
      </Popover.Content>
    </Popover>
  );
}
