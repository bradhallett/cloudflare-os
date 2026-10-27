// The Calendar session's RPC surface is validated: arguments a caller force-sends that do not
// match the declared TypeScript types are refused before the session runs anything (RC-1C —
// GoogleCalendarSession was the one agent-facing session without @validateRpc, and the one with
// the richest LLM-written arguments). The valid-call control proves the boundary is the decorator
// and the session still works behind it, not a dead class.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import type {
  ActionDescription, ApprovalQueue, GitCache, HookController, HookDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import { ActionJournal } from "@gadgets/gatekeeper-kit/actions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleCalendarApi } from "../../src/calendar-api";
import { GoogleCalendarSessionImpl, type GoogleCalendarAction } from "../../src/calendar";
import type { GoogleCalendarSession } from "../../src/calendar-types";
import { FakeKv } from "../fake-kv";

class TestApprovalQueue extends RpcTarget implements ApprovalQueue {
  readonly observations: string[] = [];
  submitted: ActionDescription[] = [];

  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.observations.push(description.description);
  }

  async getGitCache(): Promise<GitCache> {
    throw new Error("Unexpected git cache access");
  }

  async submitAction(_actionId: number, description: ActionDescription): Promise<void> {
    this.submitted.push(description);
  }

  async bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>,
    _callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    throw new Error("Unexpected hook binding");
  }
}

let providerRequests: URL[];

beforeEach(() => {
  providerRequests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    let request = new Request(input, init);
    let url = new URL(request.url);
    providerRequests.push(url);
    if (url.hostname !== "www.googleapis.com" || !url.pathname.startsWith("/calendar/v3/")) {
      throw new Error(`Unexpected provider request: ${url.origin}${url.pathname}`);
    }
    if (url.pathname.endsWith("/events")) return Response.json({ items: [] });
    return Response.json({ id: "cal-1", summary: "Work Calendar" });
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function newSession() {
  let queue = new TestApprovalQueue();
  let queueStub = new RpcStub<ApprovalQueue>(queue);
  let session = new RpcStub(new GoogleCalendarSessionImpl(
    new GoogleCalendarApi(async () => "access-token"),
    "cal-1",
    "thisCalendar",
    queueStub,
    new ActionJournal<GoogleCalendarAction>(new FakeKv(), { namespace: "pending" }),
    async () => ({ pendingSets: [], commit() {} }),
  ));
  return { queue, session };
}

/** Captures a malformed call however it surfaces — the wrapper may throw or reject. */
async function outcome(fn: () => unknown): Promise<unknown> {
  try {
    await Promise.resolve().then(fn);
    return undefined;
  } catch (err) {
    return err;
  }
}

function expectRefusedByValidation(err: unknown): void {
  expect(err).toBeInstanceOf(TypeError);
  expect((err as TypeError).message).toContain("capnweb-validate");
}

describe("Google Calendar session RPC validation", () => {
  it("serves a well-formed listEvents call, reaching Google once", async () => {
    let { queue, session } = newSession();
    using _session = session;

    let events = await session.listEvents({
      timeMin: new Date("2026-10-01T00:00:00Z"),
      timeMax: new Date("2026-10-08T00:00:00Z"),
    });

    expect(events).toEqual([]);
    expect(providerRequests.map(url => url.pathname)).toEqual(["/calendar/v3/calendars/cal-1/events"]);
    expect(queue.observations).toHaveLength(1);
  });

  it("refuses a string where the window wants a Date, before reaching Google", async () => {
    let { queue, session } = newSession();
    using _session = session;
    let malformed = session as unknown as {
      listEvents(opts: unknown): Promise<unknown>;
    };

    expectRefusedByValidation(await outcome(() => malformed.listEvents({
      timeMin: "2026-10-01",
      timeMax: new Date("2026-10-08T00:00:00Z"),
    })));

    expect(providerRequests).toEqual([]);
    expect(queue.observations).toEqual([]);
  });

  it("refuses an event draft whose title is not a string, before queuing anything", async () => {
    let { queue, session } = newSession();
    using _session = session;
    let malformed = session as unknown as {
      createEvent(event: unknown, opts?: unknown): Promise<void>;
    };

    expectRefusedByValidation(await outcome(() => malformed.createEvent(
      { title: 42, start: { dateTime: "2026-10-01T09:00:00Z" }, end: { dateTime: "2026-10-01T10:00:00Z" } },
    )));

    expect(queue.submitted).toEqual([]);
    expect(providerRequests).toEqual([]);
  });

  it("refuses an unknown sendUpdates policy an RPC caller force-sends", async () => {
    let { queue, session } = newSession();
    using _session = session;
    let malformed = session as unknown as {
      createEvent(event: unknown, opts?: unknown): Promise<void>;
    };

    expectRefusedByValidation(await outcome(() => malformed.createEvent(
      { title: "Review", start: { dateTime: "2026-10-01T09:00:00Z" }, end: { dateTime: "2026-10-01T10:00:00Z" } },
      { sendUpdates: "sometimes" },
    )));

    expect(queue.submitted).toEqual([]);
    expect(providerRequests).toEqual([]);
  });

  it("refuses availability checks whose people list is not a list", async () => {
    let { queue, session } = newSession();
    using _session = session;
    let malformed = session as unknown as GoogleCalendarSession;

    expectRefusedByValidation(await outcome(() =>
      (malformed as unknown as { checkAvailability(opts: unknown): Promise<unknown> }).checkAvailability({
        people: "alice@example.com",
        timeMin: new Date("2026-10-01T00:00:00Z"),
        timeMax: new Date("2026-10-02T00:00:00Z"),
      })));

    expect(providerRequests).toEqual([]);
    expect(queue.observations).toEqual([]);
  });
});
