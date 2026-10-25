import { createRoot } from "react-dom/client";
import { RpcTarget, newMessagePortRpcSession, type RpcStub } from "capnweb";
import type {
  GatekeeperAppTheme,
  GatekeeperAppThemeReceiver,
} from "@gadgets/workshop-shared/theme";
import ComposioPage, { type ComposioAppUiClient } from "./ComposioPage";
import ErrorBoundary from "./ErrorBoundary";
import { installErrorReporting, reportIssue } from "./error-reporting";
import { applyAppTheme } from "./theme";
import "./styles.css";

installErrorReporting();

class AppIframe extends RpcTarget implements GatekeeperAppThemeReceiver {
  setTheme(theme: GatekeeperAppTheme): void {
    applyAppTheme(theme);
  }
}

interface HostCapability extends RpcTarget {
  readonly ui: RpcStub<ComposioAppUiClient>;
  subscribeTheme(receiver: GatekeeperAppThemeReceiver): Promise<GatekeeperAppTheme>;
}

function main() {
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing Composio app root.");

  const { port1, port2 } = new MessageChannel();
  window.parent.postMessage({ type: "handshake" }, "*", [port2]);
  const iframe = new AppIframe();
  const host = newMessagePortRpcSession<HostCapability>(port1, iframe);
  host
    .subscribeTheme(iframe)
    .then(applyAppTheme)
    .catch(() => {});

  createRoot(element, {
    onUncaughtError: (error) =>
      reportIssue("composio.react-root", error, {
        handled: false,
        severity: "fatal",
        captureMechanism: "react",
      }),
  }).render(
    <ErrorBoundary>
      <ComposioPage ui={host.ui} />
    </ErrorBoundary>,
  );
}

main();
