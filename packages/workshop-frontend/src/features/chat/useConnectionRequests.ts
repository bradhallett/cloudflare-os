import { useRef, useState } from "react";
import { AiChatMessage, GatekeeperClient, Overseer } from "@gadgets/workshop-shared/api";
import { RpcStub } from "capnweb";
import type { Toasts } from "./useChatSubscription";

/** The accept-flow GatekeeperModal's pre-seeded connection request (see AiChatMetadata). */
export interface ConnectionAccept {
  requestId: string;
  vendorId: string;
  resourceUrl?: string;
  resourceUrlPattern?: string;
}

/** Props {@link useConnectionRequests} reads from its host component. */
export interface UseConnectionRequestsArgs {
  overseer: RpcStub<Overseer>;
  toasts: Toasts;
}

/**
 * Connection-request accept/deny: opens the gatekeeper modal pre-seeded with the agent's
 * request, finalizes the accept once the resource is connected, and denies. Owns the accept
 * state and the in-flight sets, so the host component orchestrates rather than holding setters.
 * Extracted verbatim from useChatActions.
 */
export function useConnectionRequests({ overseer, toasts }: UseConnectionRequestsArgs) {
  const [connectionAccept, setConnectionAccept] = useState<ConnectionAccept | null>(null);
  /** Latest connectionAccept, for the GatekeeperModal's onCreated callback. */
  const connectionAcceptRef = useRef<ConnectionAccept | null>(null);
  connectionAcceptRef.current = connectionAccept;
  const [processingConnections, setProcessingConnections] = useState<Set<string>>(
    () => new Set());

  // Open the gatekeeper modal pre-seeded with the agent's requested vendor/resource.
  const handleAcceptConnection = (msg: AiChatMessage & { type: "connectionRequest" }) => {
    setConnectionAccept({
      requestId: msg.requestId,
      vendorId: msg.vendorId,
      resourceUrl: msg.resourceUrl,
      resourceUrlPattern: msg.resourceUrlPattern,
    });
  };

  // Invoked by the accept-flow GatekeeperModal once the user has connected + configured a resource.
  // The gatekeeper is bound into no gadget; finalizing the request surfaces it to the agent as a
  // binding in the chat's env, under the name the agent chose when it made the request (the agent
  // wires it into a gadget itself if that gadget's code needs it).
  const handleConnectionCreated = async (gk: RpcStub<GatekeeperClient<any>>) => {
    const accept = connectionAcceptRef.current;
    if (!accept) {
      gk[Symbol.dispose]();
      return;
    }
    setProcessingConnections((prev) => new Set(prev).add(accept.requestId));
    try {
      const id = await gk.getId();
      await overseer.acceptConnectionRequest(accept.requestId, {
        gatekeeperId: id,
      });
      setConnectionAccept(null);
    } catch (err) {
      console.error("Failed to finalize connection:", err);
      toasts.add({ title: "Failed to add connection", variant: "error" });
    } finally {
      gk[Symbol.dispose]();
      setProcessingConnections((prev) => {
        const next = new Set(prev);
        next.delete(accept.requestId);
        return next;
      });
    }
  };

  const handleDenyConnection = async (requestId: string) => {
    setProcessingConnections((prev) => new Set(prev).add(requestId));
    try {
      await overseer.denyConnectionRequest(requestId);
      // If the accept modal happens to be open for this same request, close it.
      if (connectionAcceptRef.current?.requestId === requestId) {
        setConnectionAccept(null);
      }
    } catch (err) {
      console.error("Failed to deny connection:", err);
      toasts.add({ title: "Failed to deny connection", variant: "error" });
    } finally {
      setProcessingConnections((prev) => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    }
  };

  return {
    connectionAccept,
    setConnectionAccept,
    processingConnections,
    handleAcceptConnection,
    handleConnectionCreated,
    handleDenyConnection,
  };
}
