// The one idiom for expected errors that carry a stable machine-readable `code` across the RPC
// boundary, so clients branch on the code instead of parsing messages. Every family in the
// shared API — openGadget failures, auth failures, and plan-enforcement refusals in api.ts, and
// observation refusals in gatekeeper.ts — is built here, so creation and read-back stay
// shape-identical no matter which side of the RPC rebuilt the error.

/**
 * Builds the create/read helpers for a family of expected errors carrying stable
 * machine-readable codes. `codes` is the family's `*_CODES` const (member name → code), so the
 * valid set is read from the same declaration callers test against. `messages` optionally maps
 * each code to the message `create` throws when the caller passes no override; those messages
 * double as the classification fallback for errors from older deployments that lost the code in
 * transit, so changing one is a compatibility break. Families whose message is always composed
 * at the throw site (it names the refused thing) omit `messages` and pass the message to
 * `create` every time.
 */
export function codedErrorFamily<Code extends string>(
    codes: Record<string, Code>,
    messages: Partial<Record<Code, string>> = {}) {
  const codeSet = new Set<unknown>(Object.values(codes));
  return {
    /** Creates the family's expected error carrying its machine-readable code. */
    create: (code: Code, message?: string): Error & { code: Code } =>
      Object.assign(new Error(message ?? messages[code]), { code }),
    /** Reads the family's code from an error, if it carries one. */
    getCode: (error: unknown): Code | undefined => {
      const candidate = typeof error === "object" && error !== null && "code" in error
          ? error.code : undefined;
      return codeSet.has(candidate) ? candidate as Code : undefined;
    },
    /** Whether `code` is one of this family's codes — the client-side test for error surfaces. */
    isCode: (code: unknown): code is Code => codeSet.has(code),
  };
}
