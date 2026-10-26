// The frame adapter from the gatekeeper-context app, parameterized only by this app's
// failure-site prefix ("composio.*") and the shared VITE_FRONTEND_ERROR_REPORTING gate: the
// management app runs as an opaque-origin srcDoc frame, so reports travel to the Workshop host
// via postMessage rather than a same-origin POST (the host adds surface context there). The
// long-term home for this adapter is @gadgets/error-reporting itself alongside the shared
// serialization core — proposed to the coordinator; it stays a small local copy until then,
// because the configurator-ui frame runtime is Preact-based and not importable here.

import {
  FRONTEND_ERROR_MESSAGE_TYPE,
  serializeException,
  type FrontendCaptureMechanism,
  type FrontendFrameErrorReportV1,
} from "@gadgets/error-reporting";

type Options = Readonly<{
  severity?: FrontendFrameErrorReportV1["severity"];
  handled?: boolean;
  captureMechanism?: FrontendCaptureMechanism;
}>;

export function reportIssue(site: string, caught: unknown, options?: Options): void {
  try {
    if (import.meta.env.VITE_FRONTEND_ERROR_REPORTING !== "true") return;
    const report: FrontendFrameErrorReportV1 = {
      failureSite: site,
      severity: options?.severity ?? "error",
      handled: options?.handled ?? true,
      captureMechanism: options?.captureMechanism ?? "explicit",
      exception: serializeException(caught),
    };
    window.parent.postMessage({ type: FRONTEND_ERROR_MESSAGE_TYPE, report }, "*");
  } catch {
    // Reporting must never affect the management UI.
  }
}

export function installErrorReporting(): void {
  if (import.meta.env.VITE_FRONTEND_ERROR_REPORTING !== "true") return;
  window.addEventListener("error", (event) => {
    if (event.error !== undefined) {
      reportIssue("composio.window-error", event.error, {
        handled: false,
        captureMechanism: "window.error",
      });
    }
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportIssue("composio.unhandled-rejection", event.reason, {
      handled: false,
      captureMechanism: "unhandledrejection",
    });
  });
}
