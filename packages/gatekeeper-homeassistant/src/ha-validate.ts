// Defensive runtime validation of write bodies: catches the common single-options-object-
// instead-of-positional-arguments mistake and renders a corrected positional call in the error.

import { HomeAssistantAction } from "./ha-gatekeeper";

/**
 * The fields of a HomeAssistantAction that the caller fills in (everything except `id`, which
 * the gatekeeper assigns). Exported for the action store, which stamps the id in.
 */
export type SubmitWriteBody =
  | Omit<HomeAssistantAction & { type: "callService" }, "id">
  | Omit<HomeAssistantAction & { type: "fireEvent" }, "id">
  | Omit<HomeAssistantAction & { type: "saveDashboard" }, "id">;

/**
 * Defensive runtime validation of action bodies. Catches the common mistake of passing a
 * single options object where positional arguments were expected, and produces an error
 * message that includes a corrected positional call when possible.
 */
export function validateWriteBody(body: SubmitWriteBody): void {
  if (!body || typeof body !== "object") {
    throw new TypeError(
      `Internal error: gatekeeper received a non-object action body (got ${typeof body}).`,
    );
  }
  switch (body.type) {
    case "callService": {
      if (typeof body.domain !== "string" || !body.domain) {
        throw new TypeError(buildCallServiceError(body));
      }
      if (typeof body.service !== "string" || !body.service) {
        throw new TypeError(buildCallServiceError(body));
      }
      return;
    }
    case "fireEvent": {
      if (typeof body.eventType !== "string" || !body.eventType) {
        throw new TypeError(
          `fireEvent(eventType, data?): the first argument must be a non-empty event-type ` +
            `string, but got ${describeBadArg(body.eventType)}.\n\n` +
            `Correct usage (positional, not an options object):\n` +
            `    await session.fireEvent("my_event_type", { foo: "bar" });`,
        );
      }
      return;
    }
    case "saveDashboard": {
      if (body.config == null || typeof body.config !== "object") {
        throw new TypeError(
          `saveConfig(config): config must be a Lovelace dashboard configuration object, ` +
            `but got ${describeBadArg(body.config)}.\n\n` +
            `Correct usage: read with getConfig(), modify the JSON, then write back:\n` +
            `    const config = await dashboard.getConfig();\n` +
            `    config.views.push({ title: "New", cards: [] });\n` +
            `    await dashboard.saveConfig(config);`,
        );
      }
      return;
    }
  }
}

/**
 * Produce a rich error message for a malformed callService body. Inspects the actual values
 * passed and, when the agent appears to have used an options-object form, constructs the
 * equivalent correct positional call so the agent can fix it on the next attempt.
 */
export function buildCallServiceError(
  body: Omit<HomeAssistantAction & { type: "callService" }, "id">,
): string {
  const { domain, service, data, target, origin } = body;
  const isEntityOrigin = origin?.kind === "entity";

  // Detect options-object form: domain is an object with a "domain" or "service" key inside.
  let suggested: string | undefined;
  if (
    domain &&
    typeof domain === "object" &&
    !Array.isArray(domain) &&
    ("domain" in (domain as object) || "service" in (domain as object))
  ) {
    const opts = domain as Record<string, unknown>;
    const innerDomain = typeof opts.domain === "string" ? opts.domain : undefined;
    const innerService = typeof opts.service === "string" ? opts.service : undefined;
    // Common renames seen in the wild:
    const innerData =
      (opts.data as Record<string, unknown> | undefined) ??
      (opts.serviceData as Record<string, unknown> | undefined) ??
      (opts.service_data as Record<string, unknown> | undefined);
    const innerTargetRaw =
      (opts.target as Record<string, unknown> | undefined) ??
      (opts.targets as Record<string, unknown> | undefined);
    const innerTarget = innerTargetRaw ? normalizeBadTarget(innerTargetRaw) : undefined;

    if (innerDomain || innerService) {
      suggested = renderCallExample({
        domain: innerDomain ?? "<domain>",
        service: innerService ?? "<service>",
        data: innerData,
        target: innerTarget,
        isEntityOrigin,
      });
    }
  }

  const correctExample = renderCallExample({
    domain: typeof domain === "string" && domain ? domain : "light",
    service: typeof service === "string" && service ? service : "turn_on",
    data: typeof data === "object" && data ? data : { brightness: 200 },
    target:
      target && Object.keys(target).length > 0
        ? target
        : isEntityOrigin
          ? undefined
          : { entity_id: "light.kitchen" },
    isEntityOrigin,
  });

  const lines: string[] = [];
  lines.push(
    `Invalid callService arguments. This method takes POSITIONAL arguments (domain, ` +
      `service, data?, target?), NOT a single options object.`,
  );
  lines.push("");
  lines.push(`What you passed:`);
  lines.push(`    domain  = ${describeBadArg(domain)}`);
  lines.push(`    service = ${describeBadArg(service)}`);
  if (data !== undefined) lines.push(`    data    = ${describeBadArg(data)}`);
  if (target !== undefined) lines.push(`    target  = ${describeBadArg(target)}`);
  lines.push("");
  if (suggested) {
    lines.push(`It looks like you wanted to write:`);
    lines.push(`    ${suggested}`);
    lines.push("");
  }
  lines.push(`Correct positional form, for example:`);
  lines.push(`    ${correctExample}`);
  lines.push("");
  lines.push(
    `Tip: prefer typed helpers when available — e.g. ` +
      `\`(await session.getEntity("light.kitchen")).turnOn({ brightness: 200 })\` ` +
      `— they have stronger types and are harder to misuse.`,
  );
  return lines.join("\n");
}

// Map common bad target field names (e.g. entityIds, entity_ids) to the canonical
// ServiceCallTarget field names (entityId, deviceId, etc.) so the suggested call is correct.
function normalizeBadTarget(target: Record<string, unknown>): Record<string, unknown> {
  const renames: Record<string, string> = {
    entity_id: "entityId",
    entity_ids: "entityId",
    entityIds: "entityId",
    device_id: "deviceId",
    device_ids: "deviceId",
    deviceIds: "deviceId",
    area_id: "areaId",
    area_ids: "areaId",
    areaIds: "areaId",
    label_id: "labelId",
    label_ids: "labelId",
    labelIds: "labelId",
    floor_id: "floorId",
    floor_ids: "floorId",
    floorIds: "floorId",
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(target)) {
    const key = renames[k] ?? k;
    // If the source was a singular id but value is an array, keep it; ServiceCallTarget allows
    // string | string[].
    out[key] = v;
  }
  return out;
}

function renderCallExample(opts: {
  domain: string;
  service: string;
  data?: Record<string, unknown>;
  target?: Record<string, unknown>;
  isEntityOrigin: boolean;
}): string {
  const { domain, service, data, target, isEntityOrigin } = opts;
  const args: string[] = [];
  if (isEntityOrigin) {
    args.push(JSON.stringify(service));
    if (data !== undefined) args.push(JSON.stringify(data));
  } else {
    args.push(JSON.stringify(domain));
    args.push(JSON.stringify(service));
    if (data !== undefined || target !== undefined) args.push(JSON.stringify(data ?? {}));
    if (target !== undefined) args.push(JSON.stringify(target));
  }
  const receiver = isEntityOrigin ? "entity" : "session";
  return `await ${receiver}.callService(${args.join(", ")});`;
}

function describeBadArg(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "number" || typeof value === "boolean") return `${typeof value} ${value}`;
  if (Array.isArray(value)) {
    try {
      return `array ${JSON.stringify(value)}`;
    } catch {
      return "array";
    }
  }
  if (typeof value === "object") {
    try {
      return `object ${JSON.stringify(value)}`;
    } catch {
      return "object";
    }
  }
  return typeof value;
}
