// The connection's daily read budget, shared by every binding of a ZoomInfo connection. Mirrors
// the X gatekeeper's budget (see `x-credentials.ts`): the account Durable Object holds one counter
// per UTC day, and every ZoomInfo API call a session or an approved enrichment makes reserves one
// request against it, settling with whether ZoomInfo ever answered.

import { createLogger } from "@gadgets/observability/logger";
import { isOutcomeUnknown } from "./zoominfo-api";
import { VENDOR_ID } from "./zoominfo-env";

const logger = createLogger<{ vendorId: string }>({ component: "gatekeeper.zoominfo", vendorId: VENDOR_ID });

/** The connection's daily read limit refused the request; it was never sent. */
export class ReadLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadLimitError";
  }
}

/** A read reservation's answer: allowed, or refused with the limit and when it resets. */
export type ReadReservation =
  /** `day` is the UTC day the read was reserved against, absent when reads are unlimited. */
  | { ok: true; day?: string }
  | { ok: false; limit: number; resetsAt: number };

/** The account's daily read budget, which every binding of a connection draws on. */
export type ReadBudget = {
  reserveRead(): Promise<ReadReservation>;
  settleRead(day: string, spent: boolean): Promise<void>;
};

/**
 * The display-safe refusal of a read the connection's daily limit no longer allows.
 * @param whose Whose connection it is, as the sentence's subject.
 */
export function readLimitMessage(reservation: { limit: number; resetsAt: number },
                                 whose = "This ZoomInfo connection"): string {
  const resets = new Date(reservation.resetsAt).toISOString().slice(11, 16);
  return `${whose} has used today's ${reservation.limit.toLocaleString("en-US")} ZoomInfo reads; ` +
    `the limit resets at ${resets} UTC.`;
}

/**
 * Runs one ZoomInfo API request within the connection's daily limit: it reserves a request first
 * and settles with whether the request was spent — it was, unless ZoomInfo definitively refused
 * it. A request whose answer was lost keeps its reservation, since ZoomInfo may have served (and
 * charged) one nobody saw; a 5xx answer still proves the request reached ZoomInfo and was counted,
 * so for the budget it is spent like any other answer.
 * @param whose Whose connection a refusal names.
 */
export async function withinReadLimit<T>(budget: ReadBudget, read: () => Promise<T>,
                                         whose?: string): Promise<T> {
  const reservation = await budget.reserveRead();
  if (!reservation.ok) throw new ReadLimitError(readLimitMessage(reservation, whose));
  let spent = false;
  try {
    const result = await read();
    spent = true;
    return result;
  } catch (error) {
    // Anything that leaves whether ZoomInfo answered unknown -- a lost answer, and a 5xx, which
    // still proves the request reached ZoomInfo and was counted -- keeps the reservation spent,
    // per the policy the doc comment above states.
    if (isOutcomeUnknown(error)) spent = true;
    throw error;
  } finally {
    if (reservation.day !== undefined) {
      try {
        await budget.settleRead(reservation.day, spent);
      } catch (error) {
        logger.warn("failed to settle a ZoomInfo read", {
          event: "zoominfo.reads.settle.failed", error,
        });
      }
    }
  }
}
