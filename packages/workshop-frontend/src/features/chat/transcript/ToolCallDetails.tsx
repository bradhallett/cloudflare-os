import { memo } from "react";
import type { AiToolCall } from "@gadgets/workshop-shared/api";

/** The expanded body of one tool call: error, code/output, or the raw input JSON. */
export const ToolCallDetails = memo(function ToolCallDetails(
  { toolCall: tc }: { toolCall: AiToolCall },
) {
  return (
    <div className="space-y-2">
      {tc.error && (
        <pre className="rounded-xl border border-kumo-danger/20 bg-kumo-danger-tint/40 p-3 font-mono text-[12px] leading-[18px] text-kumo-danger whitespace-pre-wrap">
          {tc.error}
        </pre>
      )}
      {tc.toolName === "executeCode" ? (
        <>
          <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">
            Code
          </span>
          <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
            {tc.input.code}
          </pre>
          {tc.output && (
            <>
              <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">
                Output
              </span>
              <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                {tc.output}
              </pre>
            </>
          )}
        </>
      ) : tc.toolName === "describeBinding" && tc.output !== undefined ? (
        // The description names the binding it describes, so the input would only repeat it.
        <pre className="max-h-96 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
          {tc.output}
        </pre>
      ) : (
        <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
          {JSON.stringify(tc.input, null, 2)}
        </pre>
      )}
    </div>
  );
});
