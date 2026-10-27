import type { RpcStub } from "capnweb";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import type { ConsoleLogEvent, ConsoleLogSubscriber } from "@gadgets/workshop-shared/api";

/**
 * The workspace's live console tail: the set of connected log subscribers and the fan-out of
 * gadget log events to them. Owned by OverseerMainline as a collaborator, so the subscriber
 * set lives in exactly one place; deliverGadgetLogs()/subscribeToConsoleLogs() delegate to it.
 */
export class ConsoleTail {
  #subscribers = new Set<RpcStub<ConsoleLogSubscriber>>();

  /** Fan one batch of gadget console output out to every connected tail. */
  deliver(chatId: number | null, logs: ConsoleLogEvent[]): void {
    for (let sub of this.#subscribers) {
      sub.event(chatId, logs).catch(() => {
        sub[Symbol.dispose]();
        this.#subscribers.delete(sub);
      });
    }
  }

  /** Connect one tail. Returns the disposal stub handed back to the client. */
  subscribe(subscriber: RpcStub<ConsoleLogSubscriber>): RpcStub<{}> {
    let subscribers = this.#subscribers;
    let sub = subscriber.dup();
    sub.onRpcBroken(_ => unsubscribe());
    subscribers.add(sub);

    function unsubscribe() {
      subscribers.delete(sub);
      sub[Symbol.dispose]();
    }

    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return new NativeRpcStub<{}>({
      [Symbol.dispose]() {
        unsubscribe();
      }
    });
  }
}
