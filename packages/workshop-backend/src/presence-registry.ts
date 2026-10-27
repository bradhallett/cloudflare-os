import type { AiChatAuthorInfo, CollaboratorRole, PresenceParticipant } from "@gadgets/workshop-shared/api";
import { RpcStub as NativeRpcStub } from "cloudflare:workers";
import type { RpcStub } from "capnweb";
import type { PresenceSubscriber } from "@gadgets/workshop-shared/api";

/**
 * The workspace's presence roster: which viewers are present, at what role, and who wants to
 * hear about changes. Owned by OverseerCore as a collaborator; the partial classes delegate
 * joinPresence()/addPresenceSubscriber() to it, so roster state lives in exactly one place.
 *
 * Multiple sessions from the same profile collapse into one participant, whose role is the
 * strongest any of its sessions holds ("build" beats "use").
 */
export class PresenceRegistry {
  /** Active viewers, keyed by profileId; sessions collapse per profile. */
  #presence = new Map<string, {
    key: string;
    user: AiChatAuthorInfo;
    sessions: Map<object, CollaboratorRole>;
  }>();

  /** Subscribers to roster changes, registered via subscribe(). */
  #subscribers = new Map<object, RpcStub<PresenceSubscriber>>();

  #keyCounter = 0;

  #effectiveRole(sessions: Map<object, CollaboratorRole>): CollaboratorRole {
    for (let role of sessions.values()) {
      if (role === "build") return "build";
    }
    return "use";
  }

  #toParticipant(profileId: string): PresenceParticipant {
    let entry = this.#presence.get(profileId)!;
    return { key: entry.key, user: entry.user, role: this.#effectiveRole(entry.sessions) };
  }

  #broadcastAdd(participant: PresenceParticipant) {
    for (let [token, sub] of this.#subscribers) {
      sub.add(participant).catch(() => this.#removeSubscriber(token));
    }
  }

  #broadcastRemove(key: string) {
    for (let [token, sub] of this.#subscribers) {
      sub.remove(key).catch(() => this.#removeSubscriber(token));
    }
  }

  /** Mark a session as present. Returns a function that removes it. */
  join(profileId: string, user: AiChatAuthorInfo, role: CollaboratorRole): () => void {
    let token = {};
    let entry = this.#presence.get(profileId);
    if (entry) {
      let before = this.#effectiveRole(entry.sessions);
      entry.sessions.set(token, role);
      if (this.#effectiveRole(entry.sessions) !== before) {
        this.#broadcastAdd(this.#toParticipant(profileId));
      }
    } else {
      this.#presence.set(profileId, {
        key: `p${++this.#keyCounter}`, user, sessions: new Map([[token, role]]),
      });
      this.#broadcastAdd(this.#toParticipant(profileId));
    }

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      let e = this.#presence.get(profileId);
      if (!e) return;
      let before = this.#effectiveRole(e.sessions);
      e.sessions.delete(token);
      if (e.sessions.size === 0) {
        this.#presence.delete(profileId);
        this.#broadcastRemove(e.key);
      } else if (this.#effectiveRole(e.sessions) !== before) {
        this.#broadcastAdd(this.#toParticipant(profileId));
      }
    };
  }

  /**
   * Subscribe to roster changes. The current roster is delivered immediately via init().
   * Returns the disposal stub the RPC surface hands back to the client.
   */
  subscribe(subscriber: RpcStub<PresenceSubscriber>): RpcStub<{}> {
    subscriber = subscriber.dup();
    let token = {};
    this.#subscribers.set(token, subscriber);
    let snapshot = [...this.#presence.keys()].map(id => this.#toParticipant(id));
    subscriber.init(snapshot).catch(() => this.#removeSubscriber(token));
    subscriber.onRpcBroken(() => this.#removeSubscriber(token));
    // @ts-expect-error Bugs in native RPC types make this not work currently.
    return new NativeRpcStub<{}>({
      [Symbol.dispose]: () => this.#removeSubscriber(token),
    });
  }

  #removeSubscriber(token: object) {
    let sub = this.#subscribers.get(token);
    if (!sub) return;
    this.#subscribers.delete(token);
    sub[Symbol.dispose]();
  }
}
