const SHOW_THINKING_TRACES_KEY = "showThinkingTraces";

/** The persisted "show thinking traces" preference, defaulting to on. */
export function getStoredShowThinkingTraces(): boolean {
  try {
    // Clean up the key this setting replaced.
    window.localStorage.removeItem("expandReasoningByDefault");
    return window.localStorage.getItem(SHOW_THINKING_TRACES_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Persist the "show thinking traces" preference (silently unwritable in private mode). */
export function persistShowThinkingTraces(show: boolean): void {
  try {
    window.localStorage.setItem(SHOW_THINKING_TRACES_KEY, show ? "true" : "false");
  } catch {
    // private mode / sandboxed iframes
  }
}
