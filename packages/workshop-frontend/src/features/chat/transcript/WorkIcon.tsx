import type { PhosphorIcon } from "./toolCalls";

/** The small inactive icon that marks a row of agent work. */
export function WorkIcon({ Icon }: { Icon: PhosphorIcon }) {
  return <Icon size={15} className="text-kumo-inactive" />;
}
