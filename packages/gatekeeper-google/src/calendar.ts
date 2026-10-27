// Google Calendar gatekeeper: user-authenticated reads and approved event writes of one calendar.
//
// Event writes queue as actions through the kit's ActionJournal, under the `pending:` keys the
// private store before it wrote. Every write also re-notifies attendees, so each is claimed before
// its dispatch and an interrupted one settles as outcome-unknown rather than being repeated: a
// re-delivered apply must never send a second round of invitation emails. See
// GoogleCalendarGatekeeperImpl.applyAction for the protocol.

import { DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import type {
  ActionKind, ApprovalQueue, Gatekeeper, GatekeeperUserVerifier, ResourceDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  ActionJournal, stageAction, ActionOutcomeUnknownError, APPLY_OUTCOME_UNKNOWN_MESSAGE,
} from "@gadgets/gatekeeper-kit/actions";
import { buildDescription, codeSpan } from "@gadgets/gatekeeper-kit/action-description";
import {
  calendarEventOverlaps, calendarEventSortKey, eventPatchToGoogle, GoogleCalendarApi,
  validateCalendarTimeWindow,
} from "./calendar-api";
import { GoogleApiError } from "./google-response";
import type {
  CalendarAvailabilityMode, CalendarEvent, CalendarEventDraft, CalendarEventPatch,
  CalendarListEventsOptions, CalendarSendUpdates, CalendarTime, GoogleCalendarCapabilities,
  GoogleCalendarInfo, GoogleCalendarSession, PersonAvailability,
} from "./calendar-types";
import CALENDAR_TYPES_CODE from "./calendar-types.txt";
import { AccessTokenCache, type AccessTokenRequest } from "./auth-retry";
import { type ObserverCheck, ObserverTracker } from "./observers";
import { errorMessage } from "./google-api";
import type { GoogleVerifierApi } from "./google-verifier-types";

type Env = Cloudflare.Env;

// =======================================================================================
// Google Calendar Gatekeeper
// =======================================================================================

type GoogleCalendarActionBase = {
  calendarId: string;
  submittedAt: number;
  sendUpdates: CalendarSendUpdates;
  // Revert data, recorded on the journal's retained copy when the action was applied. Absent on
  // queued actions; the retained record is what revertAction() reads.
  applied?: GoogleCalendarRevertInfo;
}

type GoogleCalendarCreateAction = GoogleCalendarActionBase & {
  type: "createEvent";
  event: CalendarEventDraft;
}

type GoogleCalendarUpdateAction = GoogleCalendarActionBase & {
  type: "updateEvent";
  eventId: string;
  patch: CalendarEventPatch;
}

type GoogleCalendarAction = GoogleCalendarCreateAction | GoogleCalendarUpdateAction;

/**
 * Recognizes a queued event write the private store wrote as a bare payload, for the journal's
 * legacy upgrade path. That store kept only unresolved records, so anything recognizable here was
 * pending; everything else at its keys is not ours to resurrect.
 */
function isGoogleCalendarAction(raw: unknown): raw is GoogleCalendarAction {
  if (typeof raw !== "object" || raw === null) return false;
  const { type, submittedAt } = raw as Partial<GoogleCalendarAction>;
  return (type === "createEvent" || type === "updateEvent") && typeof submittedAt === "number";
}

/** Coerces a legacy bare event-write row for the journal; `undefined` leaves anything else invisible. */
function upgradeCalendarAction(raw: unknown): GoogleCalendarAction | undefined {
  return isGoogleCalendarAction(raw) ? raw : undefined;
}

type GoogleCalendarRevertInfo =
  | {
      type: "createdEvent";
      calendarId: string;
      eventId: string;
      sendUpdates: CalendarSendUpdates;
    }
  | {
      type: "updatedEvent";
      calendarId: string;
      eventId: string;
      // Prior values of exactly the fields that were changed, so the edit can be patched back.
      previous: CalendarEventPatch;
      sendUpdates: CalendarSendUpdates;
    };

export type GoogleCalendarGatekeeperImplProps = {
  userObjectId: string;
  calendarId: string;
  availabilityMode: CalendarAvailabilityMode;
}

function pendingCalendarEventFromDraft(
  id: number,
  action: GoogleCalendarCreateAction,
  opts: CalendarListEventsOptions,
): CalendarEvent {
  return {
    id: `pending:create:${id}`,
    title: action.event.title,
    start: action.event.start,
    end: action.event.end,
    status: "confirmed",
    ...(action.event.location ? {location: action.event.location} : {}),
    ...(opts.includeDescriptions && action.event.description ? {description: action.event.description} : {}),
    ...(action.event.attendees ? {attendees: action.event.attendees} : {}),
    ...(action.event.transparency ? {transparency: action.event.transparency} : {}),
    ...(action.event.visibility ? {visibility: action.event.visibility} : {}),
    pending: true,
  };
}

// Apply a pending updateEvent's patch onto a fetched event in place, so listEvents() reflects the
// edit before it's approved.
function applyCalendarPatchToEvent(
  event: CalendarEvent,
  patch: CalendarEventPatch,
  opts: CalendarListEventsOptions,
): void {
  if (patch.title !== undefined) event.title = patch.title;
  if (patch.start !== undefined) event.start = patch.start;
  if (patch.end !== undefined) event.end = patch.end;
  if (patch.location !== undefined) event.location = patch.location;
  if (patch.transparency !== undefined) event.transparency = patch.transparency;
  if (patch.visibility !== undefined) event.visibility = patch.visibility;
  if (patch.description !== undefined && opts.includeDescriptions) {
    event.description = patch.description;
  }
  if (patch.attendees !== undefined) {
    event.attendees = patch.attendees;
  }
}

// Build the undo patch for an updateEvent.
function priorCalendarPatch(oldEvent: CalendarEvent, patch: CalendarEventPatch): CalendarEventPatch {
  let previous: CalendarEventPatch = {};
  if (patch.title !== undefined) previous.title = oldEvent.title;
  if (patch.start !== undefined) previous.start = oldEvent.start;
  if (patch.end !== undefined) previous.end = oldEvent.end;
  if (patch.location !== undefined) previous.location = oldEvent.location ?? "";
  if (patch.description !== undefined) previous.description = oldEvent.description ?? "";
  if (patch.transparency !== undefined) previous.transparency = oldEvent.transparency ?? "opaque";
  if (patch.visibility !== undefined) previous.visibility = oldEvent.visibility ?? "default";
  if (patch.attendees !== undefined) {
    previous.attendees = (oldEvent.attendees ?? []).map(a => ({
      email: a.email,
      ...(a.displayName ? {displayName: a.displayName} : {}),
      ...(a.optional ? {optional: a.optional} : {}),
    }));
  }
  return previous;
}

function applyPendingCalendarActions(
  events: CalendarEvent[],
  pending: {id: number, action: GoogleCalendarAction}[],
  opts: CalendarListEventsOptions,
): CalendarEvent[] {
  let byId = new Map(events.map(event => [event.id, {...event}]));
  let added: CalendarEvent[] = [];

  for (let {id, action} of pending) {
    if (action.type === "createEvent") {
      let event = pendingCalendarEventFromDraft(id, action, opts);
      if (calendarEventOverlaps(event, opts.timeMin, opts.timeMax)) added.push(event);
    } else if (action.type === "updateEvent") {
      let existing = byId.get(action.eventId);
      if (existing) {
        applyCalendarPatchToEvent(existing, action.patch, opts);
        existing.pending = true;
        if (!calendarEventOverlaps(existing, opts.timeMin, opts.timeMax)) {
          byId.delete(action.eventId);
        }
      }
    } else {
      const _exhaustive: never = action;
      void _exhaustive;
    }
  }

  return [...byId.values(), ...added]
      .toSorted((a, b) => calendarEventSortKey(a) - calendarEventSortKey(b));
}

function validateEventTimes(start: CalendarTime, end: CalendarTime): void {
  if (start.kind !== end.kind) {
    throw new Error("Event start and end must both be all-day (date) or both be timed (dateTime).");
  }
  let startMs = start.kind === "date" ? Date.parse(start.date) : start.dateTime.valueOf();
  let endMs = end.kind === "date" ? Date.parse(end.date) : end.dateTime.valueOf();
  if (!(endMs > startMs)) throw new Error("Event end must be after start.");
}

function summarizePeople(people: string[]): string {
  if (people.length <= 5) return people.join(", ");
  return `${people.slice(0, 5).join(", ")}, and ${people.length - 5} more`;
}

/**
 * Whether a failed Calendar write may still have landed. A 5xx answers nothing, and a network
 * failure means no answer arrived; both leave the outcome unknown. A refused 4xx arrived, so the
 * write provably did not land and the action can safely return to pending.
 */
function isCalendarOutcomeUnknown(error: unknown): boolean {
  return (error instanceof GoogleApiError && error.status >= 500) ||
      error instanceof TypeError;
}

export class GoogleCalendarGatekeeperImpl
    extends DurableObject<Env, GoogleCalendarGatekeeperImplProps>
    implements Gatekeeper<GoogleCalendarSession> {
  #tokens = new AccessTokenCache(opts => {
    let account = this.ctx.exports.UserAccount.get(
        this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return account.getAccessToken(opts);
  });

  // Actions queue through the kit journal under the same `pending:` keys the private store wrote,
  // so records a connector already holds stay live, now with the journal's capacity bound and the
  // claim protocol a write that emails attendees needs.
  #journal = new ActionJournal<GoogleCalendarAction>(
      this.ctx.storage.kv, { namespace: "pending", upgradeRecord: upgradeCalendarAction });

  // Revert data for actions applied before the journal, keyed by action id. The journal's retained
  // records carry it from here on.
  #revertKey(actionId: number): string {
    return `revert:info:${actionId}`;
  }

  async #getAccessToken(opts?: AccessTokenRequest): Promise<string> {
    return this.#tokens.get(opts);
  }

  async describe(): Promise<ResourceDescription> {
    let api = new GoogleCalendarApi(opts => this.#getAccessToken(opts));
    let calendar = await api.getCalendar(this.ctx.props.calendarId);
    let availability = this.ctx.props.availabilityMode === "allVisible"
        ? " Availability lookup covers all calendars visible to the account."
        : " Availability lookup is limited to this calendar.";
    return {
      url: `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(this.ctx.props.calendarId)}`,
      title: `Calendar: ${calendar.summary}`,
      snippet: `Google Calendar: ${calendar.summary}.${availability}`,
      suggestedBindingName: "GOOGLE_CALENDAR",
      tsType: "GoogleCalendarSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return CALENDAR_TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>)
      : Promise<GoogleCalendarSession> {
    let api = new GoogleCalendarApi(opts => this.#getAccessToken(opts));
    let pendingActions = this.#journal;
    return new GoogleCalendarSessionImpl(
      api,
      this.ctx.props.calendarId,
      this.ctx.props.availabilityMode,
      approvalQueue.dup(),
      pendingActions,
      calendarIds => this.#observers.prepareObservation(calendarIds),
    );
  }

  async applyAction(actionId: number): Promise<void> {
    let record = this.#journal.get(actionId);
    if (record === undefined) {
      throw new Error(`Unknown pending Google Calendar action: ${actionId}`);
    }
    // The Workshop marks its side applied only after applyAction() returns, so a re-delivered
    // apply settles instead of dispatching again.
    if (record.state === "applied") return;
    // A decided failure repeats its reason; a staged record was never submitted to the overseer.
    if (record.state === "failed") throw new Error(record.error);
    // A claim left behind means a dispatch already began and died without an answer, so the write
    // may have landed: creating the event again would send a second round of invitation emails.
    // Terminal, like every Calendar write whose outcome is unknown.
    if (record.state === "claimed") {
      let message = APPLY_OUTCOME_UNKNOWN_MESSAGE;
      this.#journal.markFailed(actionId, message, { outcome: "unknown" });
      throw new ActionOutcomeUnknownError(message);
    }
    let action = record.action;
    let api = new GoogleCalendarApi(opts => this.#getAccessToken(opts));
    try {
      switch (action.type) {
        case "createEvent": {
          // Claimed immediately before the irreversible write: no earlier await can strand one.
          this.#journal.markClaimed(actionId);
          let created = await api.createEvent(action.calendarId, action.event, action.sendUpdates);
          this.#journal.retain(actionId, {
            ...action,
            applied: {
              type: "createdEvent",
              calendarId: action.calendarId,
              eventId: created.id,
              sendUpdates: action.sendUpdates,
            },
          });
          return;
        }
        case "updateEvent": {
          let oldEvent = await api.getEvent(action.calendarId, action.eventId);
          let previous = priorCalendarPatch(oldEvent, action.patch);
          // Claimed after the read, so an orphan claim always means the patch may have gone out.
          this.#journal.markClaimed(actionId);
          await api.patchEvent(
            action.calendarId, action.eventId,
            eventPatchToGoogle(action.patch), action.sendUpdates);
          this.#journal.retain(actionId, {
            ...action,
            applied: {
              type: "updatedEvent",
              calendarId: action.calendarId,
              eventId: action.eventId,
              previous,
              sendUpdates: action.sendUpdates,
            },
          });
          return;
        }
        default: {
          const _exhaustive: never = action;
          throw new Error(`unknown action type: ${String(_exhaustive)}`);
        }
      }
    } catch (error) {
      if (isCalendarOutcomeUnknown(error)) {
        let message = `${APPLY_OUTCOME_UNKNOWN_MESSAGE} (${errorMessage(error)})`;
        this.#journal.markFailed(actionId, message, { outcome: "unknown" });
        throw new ActionOutcomeUnknownError(message);
      }
      // A refused request (4xx) provably changed nothing, so the action returns to pending.
      this.#journal.restorePending(actionId);
      throw error;
    }
  }

  async rejectAction(actionId: number): Promise<void | {restart?: boolean}> {
    // An action whose dispatch died without an answer stays for applyAction() to settle: rejecting
    // it would claim the write never happened, which nobody can know.
    if (this.#journal.get(actionId)?.state === "claimed") {
      throw new Error(
          "This Google Calendar action may already have reached Google. Apply it again to finish " +
          "it, then revert it if it isn't wanted.");
    }
    this.#journal.remove(actionId);
  }

  async revertAction(actionId: number)
      : Promise<void | {message?: string, canRetry?: boolean, restart?: boolean}> {
    let record = this.#journal.get(actionId);
    let legacyKey = this.#revertKey(actionId);
    // The journal's retained record carries the revert data; one applied before the migration
    // keeps it beside the queue under the legacy key.
    let revertInfo = record?.state === "applied"
      ? record.action.applied
      : this.ctx.storage.kv.get<GoogleCalendarRevertInfo>(legacyKey);
    if (!revertInfo) {
      return {
        message: "This Google Calendar action can no longer be reverted automatically. " +
            "Undo it manually from Google Calendar.",
      };
    }

    let api = new GoogleCalendarApi(opts => this.#getAccessToken(opts));
    switch (revertInfo.type) {
      case "createdEvent":
        await api.deleteEvent(revertInfo.calendarId, revertInfo.eventId, revertInfo.sendUpdates);
        break;
      case "updatedEvent":
        await api.patchEvent(
          revertInfo.calendarId, revertInfo.eventId,
          eventPatchToGoogle(revertInfo.previous), revertInfo.sendUpdates);
        break;
      default: {
        const _exhaustive: never = revertInfo;
        void _exhaustive;
      }
    }
    if (record !== undefined) {
      // The journal prunes its retained tier, so applied actions no longer accumulate forever.
      this.#journal.retire(actionId);
    } else {
      this.ctx.storage.kv.delete(legacyKey);
    }
  }

  async setHook(_hook: Fetcher | null): Promise<void> {
    // No hooks for Google Calendar.
  }

  // Observer tracking combines strategy B for the selected calendar with strategy C for the
  // optional all-visible availability scope. Full event reads can include private event details,
  // which Google hides from readers, so observers must currently be writers or owners.
  // TODO: Let the binding owner choose whether private events are included. A public-only mode
  // could admit readers instead of requiring writer access from every collaborator.

  get #observers(): ObserverTracker<string, Fetcher<GoogleVerifierApi>> {
    return new ObserverTracker(this.ctx.storage.kv, {
      setPrefix: "observedAvailabilityCalendar:",
      encode: calendarId => encodeURIComponent(calendarId),
      decode: encoded => decodeURIComponent(encoded),
      hasAccess: (verifier, calendarId) => verifier.hasCalendarFreeBusyAccess(calendarId),
      deniedMessage: calendarId =>
        `This collaborator cannot see free/busy availability for ${calendarId}, whose ` +
        "availability this workspace has read, so they cannot be allowed to observe it.",
      // In thisCalendar mode no foreign calendar is ever read, so there is never anyone to
      // forward-exclude and nothing to remember an observer for.
      recordObservers: this.ctx.props.availabilityMode === "allVisible",
    });
  }

  async addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<GoogleVerifierApi>;
    if (!(await verifier.hasCalendarWriterAccess(this.ctx.props.calendarId))) {
      throw new Error(
        "This collaborator does not have writer access to the bound Google Calendar, so they " +
        "cannot be allowed to observe its event details.");
    }
    await this.#observers.addObserver(id, verifier);
  }

  async removeObserver(id: string): Promise<void> {
    this.#observers.removeObserver(id);
  }
}

class GoogleCalendarSessionImpl extends RpcTarget implements GoogleCalendarSession {
  #api: GoogleCalendarApi;
  #calendarId: string;
  #availabilityMode: CalendarAvailabilityMode;
  #approvalQueue: RpcStub<ApprovalQueue>;
  #pendingActions: ActionJournal<GoogleCalendarAction>;
  #observeAvailabilityCalendars: (calendarIds: string[]) => Promise<ObserverCheck<string>>;

  constructor(
    api: GoogleCalendarApi,
    calendarId: string,
    availabilityMode: CalendarAvailabilityMode,
    approvalQueue: RpcStub<ApprovalQueue>,
    pendingActions: ActionJournal<GoogleCalendarAction>,
    observeAvailabilityCalendars: (calendarIds: string[]) => Promise<ObserverCheck<string>>,
  ) {
    super();
    this.#api = api;
    this.#calendarId = calendarId;
    this.#availabilityMode = availabilityMode;
    this.#approvalQueue = approvalQueue;
    this.#pendingActions = pendingActions;
    this.#observeAvailabilityCalendars = observeAvailabilityCalendars;
  }

  async getCapabilities(): Promise<GoogleCalendarCapabilities> {
    return {availabilityMode: this.#availabilityMode};
  }

  async getCalendar(): Promise<GoogleCalendarInfo> {
    let calendar = await this.#api.getCalendar(this.#calendarId);
    await this.#approvalQueue.authorizeObservation({
      title: "Read Google Calendar metadata",
      description: `Read metadata for Google Calendar ${calendar.summary} (${calendar.id}).`,
    });
    return calendar;
  }

  async listEvents(opts: CalendarListEventsOptions): Promise<CalendarEvent[]> {
    validateCalendarTimeWindow(opts.timeMin, opts.timeMax, 366);
    let events = await this.#api.listEvents(this.#calendarId, opts);
    let simulated = applyPendingCalendarActions(events, this.#pendingActions.listPending(), opts);

    await this.#approvalQueue.authorizeObservation({
      title: "List Google Calendar events",
      description:
          `List ${simulated.length} event(s) on calendar ${this.#calendarId} from ` +
          `${opts.timeMin.toISOString()} to ${opts.timeMax.toISOString()}.` +
          (opts.includeDescriptions ? " Event descriptions are included." : ""),
    });

    return simulated;
  }

  async checkAvailability(opts: {
    people: string[];
    timeMin: Date;
    timeMax: Date;
    timeZone?: string;
  }): Promise<PersonAvailability[]> {
    validateCalendarTimeWindow(opts.timeMin, opts.timeMax, 90);
    let people = [...new Set(opts.people.map(person => person.trim()).filter(Boolean))];
    if (people.length === 0) throw new Error("At least one person or calendar is required.");
    if (people.length > 50) throw new Error("At most 50 people/calendars can be checked at once.");
    if (people.includes("primary")) {
      throw new Error(
        "Availability checks must use a stable calendar ID or email address, not the " +
        "account-relative \"primary\" alias.");
    }

    let foreign = people.filter(id => id !== this.#calendarId);
    if (foreign.length > 0 && this.#availabilityMode === "thisCalendar") {
      throw new Error(
          "This connection only allows availability for the bound calendar. Reconnect with " +
          "\"All calendars visible to me\" to check other calendars' availability.");
    }

    let availability = await this.#api.freeBusy({...opts, people});
    let successfulForeign = availability
        .filter(result => foreign.includes(result.email) && !result.error)
        .map(result => result.email);
    let check = successfulForeign.length > 0
        ? await this.#observeAvailabilityCalendars(successfulForeign)
        : {pendingSets: [], commit() {}};

    await this.#approvalQueue.authorizeObservation({
      title: "Check Google Calendar availability",
      description:
          `Check free/busy availability for ${summarizePeople(people)} from ` +
          `${opts.timeMin.toISOString()} to ${opts.timeMax.toISOString()}. ` +
          "Only busy time blocks are returned; event details are not read.",
      excludeObservers: check.excludeObservers,
    });
    check.commit();

    return availability;
  }

  async createEvent(
    event: CalendarEventDraft,
    opts?: { sendUpdates?: CalendarSendUpdates },
  ): Promise<void> {
    if (!event.title.trim()) throw new Error("Event title is required.");
    validateEventTimes(event.start, event.end);
    let action: GoogleCalendarAction = {
      type: "createEvent",
      calendarId: this.#calendarId,
      submittedAt: Date.now(),
      sendUpdates: opts?.sendUpdates ?? "all",
      event,
    };
    await stageAction(this.#pendingActions, this.#approvalQueue, action, {
      title: `Create calendar event: ${event.title}`,
      // The JSON is the event exactly as it will be created, so the title, times, description,
      // location, attendee names and reminders are all there to read. None of them sits in the
      // prose, where agent text could open Markdown or HTML structure.
      ...buildDescription(
        `Create an event on calendar ${codeSpan(this.#calendarId)}.`)
        .inline("Calendar ID", this.#calendarId)
        .inline("Send updates", action.sendUpdates)
        .json("Event", event)
        .finish(),
      implementsRevert: true,
    });
  }

  async updateEvent(
    eventId: string,
    patch: CalendarEventPatch,
    opts?: { sendUpdates?: CalendarSendUpdates },
  ): Promise<void> {
    if (!eventId.trim()) throw new Error("eventId is required.");
    if (Object.keys(patch).length === 0) throw new Error("patch must change at least one field.");
    if (patch.start !== undefined || patch.end !== undefined) {
      // Validate the resulting start/end pair. If only one side is patched, fetch the event to
      // get the other side.
      let start = patch.start;
      let end = patch.end;
      if (start === undefined || end === undefined) {
        let current = await this.#api.getEvent(this.#calendarId, eventId);
        start ??= current.start;
        end ??= current.end;
      }
      validateEventTimes(start, end);
    }
    let action: GoogleCalendarAction = {
      type: "updateEvent",
      calendarId: this.#calendarId,
      submittedAt: Date.now(),
      sendUpdates: opts?.sendUpdates ?? "all",
      eventId,
      patch,
    };
    await stageAction(this.#pendingActions, this.#approvalQueue, action, {
      title: `Update calendar event ${eventId}`,
      ...buildDescription(
        `Update an event on calendar ${codeSpan(this.#calendarId)}.`)
        .inline("Calendar ID", this.#calendarId)
        .inline("Event", eventId)
        .inline("Send updates", action.sendUpdates)
        .json("Changes", patch)
        .finish(),
      implementsRevert: true,
    });
  }
}

