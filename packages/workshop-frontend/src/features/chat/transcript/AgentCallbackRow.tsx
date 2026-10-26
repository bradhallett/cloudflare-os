import { Code } from "@phosphor-icons/react";
import { Tooltip } from "@cloudflare/kumo";
import { formatFullTimestamp } from "../../../utils/formatTimestamp";
import type { AiChatMessage } from "@gadgets/workshop-shared/api";

/** A gadget RPC the agent received mid-turn: the method called, on which binding, with what. */
export function AgentCallbackRow({
  msg,
}: {
  msg: Extract<AiChatMessage, { type: "agentCallback" }>;
}) {
  return (
    <div className="max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
      <Tooltip content={`Call received at ${formatFullTimestamp(msg.timestamp)}`} asChild>
        <div className="flex items-center gap-3 px-1.5 py-1">
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
            <Code size={16} />
          </span>
          <span className="min-w-0 truncate font-mono text-[13px]">
            {msg.methodName}()
          </span>
          {msg.bindingName !== undefined && (
            <span className="min-w-0 flex-shrink truncate font-mono text-[12px] leading-4 text-kumo-inactive">
              env.{msg.bindingName}
            </span>
          )}
        </div>
      </Tooltip>
      {msg.argsSummary && (
        <div className="ml-8 mt-1">
          <pre className="max-h-24 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
            {msg.argsSummary}
          </pre>
        </div>
      )}
    </div>
  );
}
