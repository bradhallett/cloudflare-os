import { GatekeeperCreationSpec, ObserverBindingNeed, BlueprintBinding, BlueprintScreenshotUpload, validateBindingName } from "@gadgets/workshop-shared/api";
import type { GatekeeperRecord } from "./storage-schema/overseer-storage";
import type { ProductAnalyticsConnectionType } from "./analytics";

/** Split out of the former overseer.ts (internal helper). */
export function defaultBlueprintBindingTitle(record: GatekeeperRecord, bindingName?: string): string {
  return record.resourceTitle || bindingName || "Connection";
}

/** Split out of the former overseer.ts (internal helper). */
export function gatekeeperVendorId(record: GatekeeperRecord | undefined): string | undefined {
  let spec = record?.creationSpec;
  return spec && "vendorId" in spec ? spec.vendorId.toLowerCase() : undefined;
}

// Produce a valid, unused binding name from a suggested base name: sanitized to identifier
// characters (uppercased, in keeping with the ALL_CAPS convention), then suffixed _2/_3/...
// until it passes validateBindingName and isn't taken. Used wherever a name is needed and the
// quick model is unavailable or failed. Deliberately fed suggested binding names or generic
// bases, never titles -- title-to-identifier transformation is the quick model's job.
/** Split out of the former overseer.ts (internal helper). */
export function fallbackBindingName(base: string, isTaken: (name: string) => boolean): string {
  let sanitized = base.toUpperCase().replace(/[^A-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/^[A-Z_]/.test(sanitized)) sanitized = sanitized ? `X_${sanitized}` : "RESOURCE";
  let candidate = sanitized;
  for (let i = 2; ; i++) {
    try {
      validateBindingName(candidate);
      if (!isTaken(candidate)) return candidate;
    } catch {
      // Invalid despite sanitization; a suffix always fixes it. (Defensive: sanitized ALL_CAPS
      // names don't currently hit any validateBindingName rejection, which are all lowercase.)
    }
    candidate = `${sanitized}_${i}`;
  }
}

// The env name under which a call's arguments are delivered to a callable agent:
// `<method>_ARGS`, or `CALL_ARGS` when the method name isn't an identifier (e.g. "foo-bar"), in
// either case suffixed _2/_3/... until it isn't taken. Stamped on the agentCallback message when
// the call is appended to the log (see drainPendingAgentCalls); the `_ARGS` suffix keeps it from
// colliding with a reserved word or an Object.prototype member, so only the identifier check can
// fail.
/** Split out of the former overseer.ts (internal helper). */
export function callArgsBindingName(methodName: string, isTaken: (name: string) => boolean): string {
  let base = `${methodName}_ARGS`;
  try {
    validateBindingName(base);
  } catch {
    base = "CALL_ARGS";
  }
  let candidate = base;
  for (let i = 2; isTaken(candidate); i++) {
    candidate = `${base}_${i}`;
  }
  return candidate;
}

/** Split out of the former overseer.ts (internal helper). */
export function observerVendorId(record: GatekeeperRecord): string | null {
  if (!record.creationSpec) {
    throw new Error(
        "This workspace has a legacy connection that cannot verify collaborators' access. Its " +
        "owner must remove the connection before the workspace can be shared, or start a new " +
        "workspace.");
  }
  return "vendorId" in record.creationSpec ? record.creationSpec.vendorId : null;
}

// Human-readable title for an observer binding -- what the user sees both in the config modal and in
// a verification-failure message, so both must derive it the same way.
/** Split out of the former overseer.ts (internal helper). */
export function observerBindingTitle(record: GatekeeperRecord): string {
  return record.resourceTitle || "Connection";
}

/** Split out of the former overseer.ts (internal helper). */
export function observerBindingNeed(record: GatekeeperRecord): ObserverBindingNeed {
  return {
    gatekeeperId: record.id,
    vendorId: observerVendorId(record)!,
    resourceTitle: observerBindingTitle(record),
    resourceUrl: record.resourceUrl,
  };
}

// Copied from normalizeText() in agent-catalog.ts, minus its length clamp
/** Split out of the former overseer.ts (internal helper). */
export function oneLineReason(reason: string): string {
  return reason.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim();
}

/** Split out of the former overseer.ts (internal helper). */
export function connectionTypeFromCreationSpec(
    type: GatekeeperCreationSpec["type"] | undefined): ProductAnalyticsConnectionType | undefined {
  switch (type) {
    case "gatekeeper": return "gatekeeper";
    case "aiModel": return "ai_model";
    case "agentSpawner": return "agent_spawner";
    case "ambient": return undefined;   // auto-provided, not a user-initiated connection
    case undefined: return undefined;
  }
}

// Compact kind label for a blueprint binding, used in agent-facing blueprint listings.
/** Split out of the former overseer.ts (internal helper). */
export function describeBindingKind(binding: BlueprintBinding): string {
  switch (binding.type) {
    case "gatekeeper": return `external resource: ${binding.gatekeeperName}`;
    case "aiModel": return binding.modelKind === "decision" ? `AI decision model` : `AI model`;
    case "agentSpawner": return `agent spawner`;
    default: return binding satisfies never;
  }
}

// The agent-facing section of a binding's type definitions: worktree-binding.txt and
// exports-binding.txt are symlinks to their .d.ts files shipped as text modules (the
// agent-spawner-binding.txt pattern), and describeBinding serves everything below the marker.
const AGENT_API_MARKER = "// ---- BEGIN AGENT API ----\n";

/** Split out of the former overseer.ts (internal helper). */
export function agentApiText(types: string): string {
  let index = types.indexOf(AGENT_API_MARKER);
  return index < 0 ? types : types.slice(index + AGENT_API_MARKER.length).trimStart();
}

const MAX_BLUEPRINT_SCREENSHOT_BYTES = 1024 * 1024;

/** Split out of the former overseer.ts (internal helper). */
export function validateBlueprintScreenshotUpload(screenshot: BlueprintScreenshotUpload): BlueprintScreenshotUpload {
  if (screenshot.mimeType !== "image/jpeg" && screenshot.mimeType !== "image/png") {
    throw new Error("Blueprint screenshot must be a JPEG or PNG image.");
  }
  if (screenshot.content.byteLength > MAX_BLUEPRINT_SCREENSHOT_BYTES) {
    throw new Error("Blueprint screenshot must be under 1 MB.");
  }
  return screenshot;
}
