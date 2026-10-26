/**
 * Where the messages the agent still holds verbatim begin, for a compaction boundary
 * announced further down. Only meaningful alongside the summary it belongs to, so it
 * renders only while that summary is open — on its own it would be a line with nothing
 * to explain it.
 */
export function CompactionCutRow({ className }: { className: string }) {
  return (
    <div className={`${className} mb-4 max-w-[860px]`}>
      <div className="flex items-center gap-3" role="separator">
        <span className="h-px flex-1 bg-kumo-line/60" aria-hidden="true" />
        <span className="flex-shrink-0 text-[11px] leading-4 font-medium tracking-[0.6px] text-kumo-inactive uppercase">
          Kept in full from here
        </span>
        <span className="h-px flex-1 bg-kumo-line/60" aria-hidden="true" />
      </div>
    </div>
  );
}
