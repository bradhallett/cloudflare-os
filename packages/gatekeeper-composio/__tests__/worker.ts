// Test worker for the workerd suite: re-exports the production entrypoint so miniflare can bind
// the Durable Objects, and adds the TestHooks Durable Object the suites drive everything through
// (see ./workerd/TestHooks.ts for why it has to be a Durable Object).

export { default } from "../src/worker.js";
export {
  ComposioAccount,
  ComposioSingletonGatekeeper,
  ComposioToolkitGatekeeper,
  ComposioVerifier,
  GatekeeperVendor,
  startAppUi,
} from "../src/worker.js";

export { TestHooks } from "./workerd/TestHooks.js";
