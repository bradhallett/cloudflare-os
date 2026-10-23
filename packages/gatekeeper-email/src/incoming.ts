import PostalMime from "postal-mime";
import type { Email } from "postal-mime";
import { dohDns, verifyDkim } from "./dkim.js";
import type { DkimDns } from "./dkim.js";
import type {
  EmailAddress as EmailAddressType,
  EmailAttachment,
  EmailAuthentication,
  IncomingEmail,
} from "./types";

function domainOf(address: string): string | null {
  let at = address.lastIndexOf("@");
  return at < 0 ? null : address.slice(at + 1).trim().toLowerCase();
}

/**
 * Parses a raw RFC 5322 message into an {@link IncomingEmail}, authenticating the sender along
 * the way: DKIM is verified against the raw bytes, and the envelope sender reported by the
 * receiving server is preserved so a mismatch with the (spoofable) From header stays visible.
 * The From/subject of a message whose DKIM did not verify must be treated as untrusted text.
 */
export async function buildIncomingEmail(
    raw: Uint8Array,
    envelope: { from: string, to: string },
    dns: DkimDns = dohDns()): Promise<IncomingEmail> {
  let parsed: Email = await PostalMime.parse(raw);

  let from: EmailAddressType = parsed.from
      ? { name: parsed.from.name || "", address: parsed.from.address || "" }
      : { name: "", address: envelope.from };
  let to: EmailAddressType[] = (parsed.to || []).map(addr => ({
    name: addr.name || "",
    address: addr.address || "",
  }));
  let cc: EmailAddressType[] = (parsed.cc || []).map(addr => ({
    name: addr.name || "",
    address: addr.address || "",
  }));
  let attachments: EmailAttachment[] = (parsed.attachments || []).map(att => ({
    filename: att.filename || null,
    mimeType: att.mimeType,
    disposition: att.disposition || null,
    content: att.content as ArrayBuffer,
  }));

  let dkim = await verifyDkim(raw, dns);
  let fromDomain = domainOf(from.address);
  let envelopeDomain = domainOf(envelope.from);
  let authentication: EmailAuthentication = {
    dkim: dkim.status,
    dkimDomain: dkim.domain,
    envelopeFrom: envelope.from,
    envelopeMismatch: fromDomain != null && envelopeDomain != null && fromDomain !== envelopeDomain,
  };

  return {
    from,
    to,
    cc,
    subject: parsed.subject || "",
    date: parsed.date || new Date().toISOString(),
    text: parsed.text || null,
    html: parsed.html || null,
    attachments,
    authentication,
  };
}

/** One-line trust statement for an authentication result, embedded in observation titles. */
export function authenticationLabel(auth: EmailAuthentication): string {
  switch (auth.dkim) {
    case "aligned":
      return `DKIM verified by ${auth.dkimDomain}`;
    case "unaligned":
      return `DKIM verified by ${auth.dkimDomain} - does not align with From`;
    case "fail":
      return "DKIM verification FAILED - sender may be spoofed";
    case "none":
      return "UNVERIFIED sender - no DKIM signature";
  }
}

function envelopeSenderLine(auth: EmailAuthentication): string {
  if (!auth.envelopeFrom) return "**Envelope sender:** not reported";
  let note = auth.envelopeMismatch
      ? " (domain differs from the From header - possible spoofing)"
      : "";
  return `**Envelope sender:** ${auth.envelopeFrom}${note}`;
}

/**
 * Builds the observation the EmailAddress DO authorizes for each delivered message. The
 * authentication verdict prefixes the subject in the title, so a spoofed From can never enter
 * the observation stream looking like an authenticated fact.
 */
export function observationForEmail(email: IncomingEmail): { title: string, description: string } {
  let sender = email.from.name
      ? `${email.from.name} <${email.from.address}>`
      : email.from.address;
  let label = authenticationLabel(email.authentication);
  return {
    title: `Email from ${email.from.address} (${label}): ${email.subject}`,
    description:
        `Received email from ${sender}\n\n`
        + `**Subject:** ${email.subject}\n`
        + `**Date:** ${email.date}\n`
        + `**Authentication:** ${label}\n`
        + `${envelopeSenderLine(email.authentication)}\n`
        + (email.to.length > 0
            ? `**To:** ${email.to.map(a => a.address).join(", ")}\n`
            : "")
        + (email.cc.length > 0
            ? `**CC:** ${email.cc.map(a => a.address).join(", ")}\n`
            : ""),
  };
}
