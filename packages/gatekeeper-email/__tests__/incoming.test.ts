import { describe, expect, it } from "vitest";
import { buildIncomingEmail, observationForEmail, authenticationLabel } from "../src/incoming.js";
import type { DkimDns } from "../src/dkim.js";
import type { EmailAuthentication, IncomingEmail } from "../src/types";

function toBytes(text: string): Uint8Array {
  let out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** DNS stub serving a fixed TXT table; records every name it was asked for. */
function dnsWith(table: Record<string, string[]>): DkimDns & { names: string[] } {
  let names: string[] = [];
  return {
    names,
    async resolveTxt(name: string): Promise<string[]> {
      names.push(name);
      return table[name.toLowerCase()] ?? [];
    },
  };
}

// The RFC 6376 Appendix A message (also used by dkim.test.ts): DKIM-signed by d=example.com
// over From joe@football.example.com, so verification must report "aligned".
const RFC_DKIM_KEY =
    "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDwIRP/UC3SBsEmGqZ9ZJW3/DkMoGeLnQ" +
    "g1fWn7/zYtIxN2SnFCjxOCKG9v3b4jYfcTNh5ijSsq631uBItLa7od+v/RtdC2UzJ1lWT947qR+Rcac2gbto/NM" +
    "qJ0fzfVjH4OuKhitdY9tf6mcwGjaNBcWToIMmPSPDdQPNUYckcQ2QIDAQAB";

function rfcMessage(): Uint8Array {
  return toBytes([
    "DKIM-Signature: v=1; a=rsa-sha256; s=brisbane; d=example.com;",
    "      c=simple/simple; q=dns/txt; i=joe@football.example.com;",
    "      h=Received : From : To : Subject : Date : Message-ID;",
    "      bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;",
    "      b=AuUoFEfDxTDkHlLXSZEpZj79LICEps6eda7W3deTVFOk4yAUoqOB",
    "      4nujc7YopdG5dWLSdNg6xNAZpOPr+kHxt1IrE+NahM6L/LbvaHut",
    "      KVdkLLkpVaVVQPzeRDI009SO2Il5Lu7rDNH6mZckBdrIx0orEtZV",
    "      4bmp/YzhwvcubU4=;",
    "Received: from client1.football.example.com  [192.0.2.1]",
    "      by submitserver.example.com with SUBMISSION;",
    "      Fri, 11 Jul 2003 21:01:54 -0700 (PDT)",
    "From: Joe SixPack <joe@football.example.com>",
    "To: Suzie Q <suzie@shopping.example.net>",
    "Subject: Is dinner ready?",
    "Date: Fri, 11 Jul 2003 21:00:37 -0700 (PDT)",
    "Message-ID: <20030712040037.46341.5F8J@football.example.com>",
    "",
    "Hi.",
    "",
    "We lost the game. Are you hungry yet?",
    "",
    "Joe.",
    "",
  ].join("\r\n"));
}

function rfcDns(): DkimDns & { names: string[] } {
  return dnsWith({ "brisbane._domainkey.example.com": [RFC_DKIM_KEY] });
}

describe("buildIncomingEmail", () => {
  it("verifies DKIM and records the envelope sender with its mismatch", async () => {
    let email = await buildIncomingEmail(
        rfcMessage(), { from: "bounces@other.example", to: "myinbox@host.example" }, rfcDns());

    expect(email.from).toEqual({ name: "Joe SixPack", address: "joe@football.example.com" });
    expect(email.subject).toBe("Is dinner ready?");
    expect(email.text).toContain("Are you hungry yet?");
    expect(email.to).toEqual([{ name: "Suzie Q", address: "suzie@shopping.example.net" }]);
    expect(email.authentication).toEqual({
      dkim: "aligned",
      dkimDomain: "example.com",
      envelopeFrom: "bounces@other.example",
      envelopeMismatch: true,  // other.example vs football.example.com
    });
  });

  it("reports no mismatch when the envelope shares the From domain", async () => {
    let email = await buildIncomingEmail(
        rfcMessage(), { from: "mailer@football.example.com", to: "myinbox@host.example" }, rfcDns());

    expect(email.authentication).toEqual({
      dkim: "aligned",
      dkimDomain: "example.com",
      envelopeFrom: "mailer@football.example.com",
      envelopeMismatch: false,
    });
  });

  it("leaves an unsigned message unverified without touching DNS", async () => {
    let dns = dnsWith({});
    let unsigned = toBytes(
        "From: stranger@somewhere.test\r\nTo: myinbox@host.example\r\nSubject: Hi\r\n" +
        "Date: Fri, 11 Jul 2003 21:00:37 -0700\r\n\r\nHello there.\r\n");
    let email = await buildIncomingEmail(
        unsigned, { from: "stranger@somewhere.test", to: "myinbox@host.example" }, dns);

    expect(email.authentication).toEqual({
      dkim: "none",
      dkimDomain: null,
      envelopeFrom: "stranger@somewhere.test",
      envelopeMismatch: false,
    });
    expect(dns.names).toEqual([]);
  });

  it("falls back to the envelope sender when the message has no From header", async () => {
    let dns = dnsWith({});
    let noFrom = toBytes("To: myinbox@host.example\r\nSubject: Hi\r\n\r\nBody.\r\n");
    let email = await buildIncomingEmail(
        noFrom, { from: "envelope@somewhere.test", to: "myinbox@host.example" }, dns);

    expect(email.from).toEqual({ name: "", address: "envelope@somewhere.test" });
    expect(email.authentication.dkim).toBe("none");
    expect(email.authentication.envelopeMismatch).toBe(false);  // no From domain to compare
  });
});

function emailWith(auth: EmailAuthentication): IncomingEmail {
  return {
    from: { name: "Joe SixPack", address: "joe@football.example.com" },
    to: [{ name: "", address: "suzie@shopping.example.net" }],
    cc: [],
    subject: "Is dinner ready?",
    date: "2003-07-12T04:00:37.000Z",
    text: "Hi.",
    html: null,
    attachments: [],
    authentication: auth,
  };
}

describe("observationForEmail", () => {
  it("stamps the verified domain into the title and description", () => {
    let observation = observationForEmail(emailWith({
      dkim: "aligned",
      dkimDomain: "example.com",
      envelopeFrom: "mailer@football.example.com",
      envelopeMismatch: false,
    }));
    expect(observation.title)
        .toBe("Email from joe@football.example.com (DKIM verified by example.com): " +
            "Is dinner ready?");
    expect(observation.description).toContain("**Authentication:** DKIM verified by example.com");
    expect(observation.description).toContain("**Envelope sender:** mailer@football.example.com");
    expect(observation.description).not.toContain("spoofing");
  });

  it("warns of possible spoofing on DKIM failure", () => {
    let observation = observationForEmail(emailWith({
      dkim: "fail",
      dkimDomain: null,
      envelopeFrom: "bounces@other.example",
      envelopeMismatch: true,
    }));
    expect(observation.title)
        .toContain("(DKIM verification FAILED - sender may be spoofed)");
    expect(observation.description).toContain("possible spoofing");
  });

  it("marks unsigned senders as unverified", () => {
    let observation = observationForEmail(emailWith({
      dkim: "none",
      dkimDomain: null,
      envelopeFrom: "",
      envelopeMismatch: false,
    }));
    expect(observation.title).toContain("(UNVERIFIED sender - no DKIM signature)");
    expect(observation.description).toContain("**Envelope sender:** not reported");
  });

  it("calls out a verified signature that does not align with From", () => {
    let observation = observationForEmail(emailWith({
      dkim: "unaligned",
      dkimDomain: "attacker.test",
      envelopeFrom: "x@attacker.test",
      envelopeMismatch: true,
    }));
    expect(observation.title)
        .toContain("(DKIM verified by attacker.test - does not align with From)");
  });

  it("uses the bare address for senders without a display name", () => {
    let email = emailWith({
      dkim: "none", dkimDomain: null, envelopeFrom: "", envelopeMismatch: false,
    });
    email.from = { name: "", address: "joe@football.example.com" };
    expect(observationForEmail(email).description)
        .toContain("Received email from joe@football.example.com");
  });

  it("lists To and CC lines only when present", () => {
    let observation = observationForEmail(emailWith({
      dkim: "none", dkimDomain: null, envelopeFrom: "", envelopeMismatch: false,
    }));
    expect(observation.description).toContain("**To:** suzie@shopping.example.net");
    expect(observation.description).not.toContain("**CC:**");

    let withCc = emailWith({
      dkim: "none", dkimDomain: null, envelopeFrom: "", envelopeMismatch: false,
    });
    withCc.cc = [{ name: "", address: "carol@shopping.example.net" }];
    expect(observationForEmail(withCc).description)
        .toContain("**CC:** carol@shopping.example.net");
  });
});

describe("authenticationLabel", () => {
  it("covers every status", () => {
    expect(authenticationLabel({
      dkim: "aligned", dkimDomain: "d.example", envelopeFrom: "", envelopeMismatch: false,
    })).toBe("DKIM verified by d.example");
    expect(authenticationLabel({
      dkim: "unaligned", dkimDomain: "d.example", envelopeFrom: "", envelopeMismatch: false,
    })).toBe("DKIM verified by d.example - does not align with From");
    expect(authenticationLabel({
      dkim: "fail", dkimDomain: null, envelopeFrom: "", envelopeMismatch: false,
    })).toBe("DKIM verification FAILED - sender may be spoofed");
    expect(authenticationLabel({
      dkim: "none", dkimDomain: null, envelopeFrom: "", envelopeMismatch: false,
    })).toBe("UNVERIFIED sender - no DKIM signature");
  });
});
