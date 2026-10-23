/** Split out of the former overseer.ts (internal helper). */
export const MAX_CHAT_ATTACHMENTS_PER_MESSAGE = 5;

/** Split out of the former overseer.ts (internal helper). */
export const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 5 * 1024 * 1024;

/** Split out of the former overseer.ts (internal helper). */
export const CHAT_ATTACHMENT_EXTENSION_BY_MIME = new Map([
  ["text/csv", ".csv"],
  ["application/json", ".json"],
  ["text/markdown", ".md"],
  ["application/xml", ".xml"],
  ["text/xml", ".xml"],
  ["application/yaml", ".yaml"],
  ["text/yaml", ".yaml"],
  ["text/plain", ".txt"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
  ["application/pdf", ".pdf"],
  ["application/zip", ".zip"],
]);

const CHAT_ATTACHMENT_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Split out of the former overseer.ts (internal helper). */
export function validateChatAttachmentId(id: string): string {
  if (!CHAT_ATTACHMENT_ID_REGEX.test(id)) throw new Error("Invalid chat attachment ID.");
  return id;
}

// Sentinel gatekeeperId used on ActionRecords that originated from built-in agent tools
// (e.g. webFetch) rather than from a real gatekeeper. Real gatekeeper IDs are assigned
// starting at 1, so -1 is a safe out-of-band marker. Only "observation" records ever carry
// this value; observations never go through the approve/reject paths that would dereference
// the gatekeeper, so no lookup is ever attempted.
/** Split out of the former overseer.ts (internal helper). */
export const BUILTIN_TOOL_GATEKEEPER_ID = -1;
