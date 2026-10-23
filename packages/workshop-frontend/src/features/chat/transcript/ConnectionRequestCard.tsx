import type { AiChatMessage } from "@gadgets/workshop-shared/api";
import { GatekeeperIcon } from "../../../components/GatekeeperIcon";

/**
 * The transcript card for a "connectionRequest" message: the vendor, the scope asked for, and
 * while pending the Deny / Set up controls.
 */
export function ConnectionRequestCard({
  msg,
  isProcessing,
  onAccept,
  onDeny,
}: {
  msg: AiChatMessage & { type: "connectionRequest" };
  isProcessing: boolean;
  onAccept: (msg: AiChatMessage & { type: "connectionRequest" }) => void;
  onDeny: (requestId: string) => void;
}) {
  const isPending = msg.state === "pending";
  const isAccepted = msg.state === "accepted";
  const isDenied = msg.state === "denied";
  const isProc = isProcessing;

  const stateLabel = isAccepted ? "Connected" : isDenied ? "Denied" : null;
  const stateLabelCls = isDenied ? "text-kumo-danger" : "text-kumo-success";
  const scope = msg.resourceTitle ?? msg.resourceUrl;

  return (
    <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
      <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-3">
        <div className="flex items-start gap-3">
          <GatekeeperIcon
            vendorId={msg.vendorId}
            logoUrl={msg.vendorLogoUrl}
            className="h-9 w-9 flex-shrink-0 rounded-lg"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
              <span className="font-medium text-kumo-default">
                Connect {msg.vendorName}
              </span>
              {scope && (
                <span className="rounded-full bg-kumo-tint px-2 py-0.5 text-[11px] leading-4 text-kumo-subtle">
                  {scope}
                </span>
              )}
              {stateLabel && (
                <span className={`text-[12px] font-medium ${stateLabelCls}`}>
                  {stateLabel}
                </span>
              )}
            </div>
            {msg.reason && (
              <p className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">
                {msg.reason}
              </p>
            )}
          </div>
          {isPending && (
            <div className="ml-3 flex flex-shrink-0 items-center gap-2 self-center text-[13px] leading-4">
              <button
                type="button"
                onClick={() => onDeny(msg.requestId)}
                disabled={isProc}
                className="cursor-pointer rounded-md px-2 py-1 font-medium text-kumo-inactive transition-colors duration-150 ease-out hover:text-kumo-danger focus-visible:text-kumo-danger focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
              >
                Deny
              </button>
              <button
                type="button"
                onClick={() => onAccept(msg)}
                disabled={isProc}
                className="cursor-pointer rounded-md bg-kumo-brand px-3 py-1 font-medium text-white transition-[opacity,transform] duration-150 ease-out hover:opacity-90 focus-visible:outline-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Set up
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
