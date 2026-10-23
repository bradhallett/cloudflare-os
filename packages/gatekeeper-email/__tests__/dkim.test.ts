import { afterEach, describe, expect, it, vi } from "vitest";
import { dohDns, parseTxtAnswers, verifyDkim } from "../src/dkim.js";
import type { DkimDns } from "../src/dkim.js";

// ---------------------------------------------------------------------------------------------
// Helpers. Tests encode/decode latin1 directly (TextEncoder is UTF-8 and would corrupt bytes)
// and build DKIM signatures from canonical forms written out LITERALLY here, independently of
// the canonicalization under test: src/dkim.ts must reduce each messy raw message to exactly
// these canonical strings for the signature to verify.

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function toBytes(text: string): Uint8Array<ArrayBuffer> {
  let out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function fromBytes(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return out;
}

async function sha256(text: string): Promise<string> {
  return toBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", toBytes(text))));
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

const FAILING_DNS: DkimDns = {
  async resolveTxt(): Promise<string[]> {
    throw new Error("DNS timeout");
  },
};

// ---------------------------------------------------------------------------------------------
// RFC 6376 Appendix A: a complete signed message whose key (Appendix C) and signature are
// published by the RFC itself, so this is an external oracle for the verifier. The figure's
// continuation indent is six spaces, and its displayed "game.  Are" is signed with a single
// space (the RFC prose style adds the second).

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

// ---------------------------------------------------------------------------------------------
// Generated fixtures (rsa-sha256 and ed25519-sha256, relaxed/relaxed). The canonical forms
// below are spelled out by hand; the raw message is deliberately messy (folds, tabs, padding
// whitespace, trailing blank lines) so verification exercises canonicalization for real.

type FixtureOptions = {
  algorithm?: "rsa-sha256" | "ed25519-sha256",
  domain?: string,
  selector?: string,
  from?: string,
  subject?: string,
  headerNames?: string[],
  extraTags?: string,
  bodyLimit?: number,
  appendToBody?: string,
};

type Fixture = { message: Uint8Array, keyRecord: string, keyName: string, bodyHash: string };

/** The canonical (relaxed) form of the messy raw body assembled by signedFixture. */
const CANONICAL_BODY = "Hi.\r\n\r\nAre you hungry yet?\r\n";
async function signedFixture(options: FixtureOptions = {}): Promise<Fixture> {
  let {
    algorithm = "rsa-sha256",
    domain = "example.org",
    selector = "tsubi",
    from = "joe@example.org",
    subject = "Dinner?",
    headerNames = ["from", "to", "subject", "date"],
    extraTags = "",
    bodyLimit = null,
    appendToBody = "",
  } = options;

  let keyPair = algorithm === "rsa-sha256"
      ? await crypto.subtle.generateKey(
          { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]),
            hash: "SHA-256" },
          true, ["sign", "verify"])
      : await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  let exported = algorithm === "rsa-sha256"
      ? new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey))
      : new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  let keyType = algorithm === "rsa-sha256" ? "rsa" : "ed25519";
  let keyRecord = `v=DKIM1; k=${keyType}; p=${toBase64(exported)}`;
  let keyName = `${selector}._domainkey.${domain}`;

  // The exact canonical forms the verifier must produce from the raw message below.
  let canonicalBody = bodyLimit != null ? CANONICAL_BODY.slice(0, bodyLimit) : CANONICAL_BODY;
  let bh = await sha256(canonicalBody);
  let local = from.slice(0, from.indexOf("@"));
  let displayName = local.charAt(0).toUpperCase() + local.slice(1);
  let canonicalHeaders: Record<string, string> = {
    "from": `from:${displayName} <${from}>`,
    "to": "to:Suzie <suzie@example.net>",
    "subject": `subject:${subject}`,
    "date": "date:Fri, 11 Jul 2003 21:00:37 -0700",
  };
  let signedText = headerNames.map(name => `${canonicalHeaders[name] ?? ""}\r\n`).join("");
  let tagsBeforeSignature =
      `v=1; a=${algorithm}; c=relaxed/relaxed; d=${domain}; s=${selector};` +
      (bodyLimit != null ? ` l=${bodyLimit};` : "") +
      (extraTags ? ` ${extraTags};` : "") +
      ` h=${headerNames.join(":")}; bh=${bh};`;
  let canonicalSignature = `dkim-signature:${tagsBeforeSignature} b=`;
  let signatureInput = signedText + canonicalSignature;
  let signature = toBase64(new Uint8Array(algorithm === "rsa-sha256"
      ? await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, toBytes(signatureInput))
      : await crypto.subtle.sign("Ed25519", keyPair.privateKey, toBytes(signatureInput))));

  // No tag value contains "; ", so splitting the tag string on "; " only cuts between tags.
  let tags = tagsBeforeSignature.split("; ");
  let raw = "";
  raw += "DKIM-Signature: " + tags.slice(0, 3).join("; ") + ";\r\n";
  raw += " " + tags.slice(3).join("; ") + "\r\n";
  raw += " b=" + signature + "\r\n";
  raw += `From:   ${displayName}   <${from}>\r\n`;
  raw += "To:\tSuzie\t<suzie@example.net>\r\n";
  raw += `Subject:   ${subject}  \r\n`;
  raw += "date: Fri, 11 Jul 2003 21:00:37 -0700\r\n";
  raw += "\r\n";
  raw += "Hi.  \r\n\r\nAre \t you hungry yet?  \r\n\r\n\r\n";
  raw += appendToBody;

  return { message: toBytes(raw), keyRecord, keyName, bodyHash: bh };
}

describe("verifyDkim", () => {
  it("verifies the RFC 6376 Appendix A example (simple/simple) as aligned", async () => {
    let dns = dnsWith({ "brisbane._domainkey.example.com": [RFC_DKIM_KEY] });
    await expect(verifyDkim(rfcMessage(), dns)).resolves.toEqual(
        { status: "aligned", domain: "example.com" });
    expect(dns.names).toEqual(["brisbane._domainkey.example.com"]);
  });

  it("rejects a tampered subject on the RFC message", async () => {
    let dns = dnsWith({ "brisbane._domainkey.example.com": [RFC_DKIM_KEY] });
    let tampered = toBytes(
        fromBytes(rfcMessage()).replace("Is dinner ready?", "Is dinner ready!"));
    await expect(verifyDkim(tampered, dns)).resolves.toEqual({ status: "fail", domain: null });
  });

  it("rejects a tampered body on the RFC message", async () => {
    let dns = dnsWith({ "brisbane._domainkey.example.com": [RFC_DKIM_KEY] });
    let tampered = toBytes(
        fromBytes(rfcMessage()).replace("hungry", "starving"));
    await expect(verifyDkim(tampered, dns)).resolves.toEqual({ status: "fail", domain: null });
  });

  it("reports none for a message without any DKIM-Signature", async () => {
    let unsigned = toBytes(
        "From: joe@example.org\r\nTo: suzie@example.net\r\nSubject: Hi\r\n\r\nHello.\r\n");
    let dns = dnsWith({});
    await expect(verifyDkim(unsigned, dns)).resolves.toEqual({ status: "none", domain: null });
    expect(dns.names).toEqual([]);  // no DNS lookups without signatures
  });

  it("verifies a generated relaxed/relaxed rsa-sha256 signature", async () => {
    let fixture = await signedFixture();
    let dns = dnsWith({ [fixture.keyName]: [fixture.keyRecord] });
    await expect(verifyDkim(fixture.message, dns)).resolves.toEqual(
        { status: "aligned", domain: "example.org" });
  });

  it("verifies a generated relaxed/relaxed ed25519-sha256 signature", async () => {
    let fixture = await signedFixture({ algorithm: "ed25519-sha256" });
    let dns = dnsWith({ [fixture.keyName]: [fixture.keyRecord] });
    await expect(verifyDkim(fixture.message, dns)).resolves.toEqual(
        { status: "aligned", domain: "example.org" });
  });

  it("reports unaligned for a valid signature from a different domain than From", async () => {
    // The attacker's own key legitimately signs a From claiming the victim's domain.
    let fixture = await signedFixture({ domain: "attacker.test", from: "ceo@victim.test" });
    let dns = dnsWith({ [fixture.keyName]: [fixture.keyRecord] });
    await expect(verifyDkim(fixture.message, dns)).resolves.toEqual(
        { status: "unaligned", domain: "attacker.test" });
  });

  it("treats a subdomain of the signing domain as aligned", async () => {
    let fixture = await signedFixture({ domain: "example.org", from: "joe@mail.example.org" });
    let dns = dnsWith({ [fixture.keyName]: [fixture.keyRecord] });
    await expect(verifyDkim(fixture.message, dns)).resolves.toEqual(
        { status: "aligned", domain: "example.org" });
  });

  it("fails when the DNS lookup throws", async () => {
    let fixture = await signedFixture();
    await expect(verifyDkim(fixture.message, FAILING_DNS)).resolves.toEqual(
        { status: "fail", domain: null });
  });

  it("fails when the selector record is missing", async () => {
    let fixture = await signedFixture();
    await expect(verifyDkim(fixture.message, dnsWith({}))).resolves.toEqual(
        { status: "fail", domain: null });
  });

  it("fails when the key record is revoked (empty p=)", async () => {
    let fixture = await signedFixture();
    let dns = dnsWith({ [fixture.keyName]: ["v=DKIM1; k=rsa; p="] });
    await expect(verifyDkim(fixture.message, dns)).resolves.toEqual(
        { status: "fail", domain: null });
  });

  it("fails when the key record restricts hashes to sha1", async () => {
    let fixture = await signedFixture();
    let record = fixture.keyRecord.replace("v=DKIM1;", "v=DKIM1; h=sha1;");
    let dns = dnsWith({ [fixture.keyName]: [record] });
    await expect(verifyDkim(fixture.message, dns)).resolves.toEqual(
        { status: "fail", domain: null });
  });

  it("fails when the signature does not cover From", async () => {
    let fixture = await signedFixture({ headerNames: ["to", "subject", "date"] });
    let dns = dnsWith({ [fixture.keyName]: [fixture.keyRecord] });
    await expect(verifyDkim(fixture.message, dns)).resolves.toEqual(
        { status: "fail", domain: null });
  });

  it("fails an expired signature (x= in the past)", async () => {
    let fixture = await signedFixture({ extraTags: "x=1000000000" });
    let dns = dnsWith({ [fixture.keyName]: [fixture.keyRecord] });
    await expect(verifyDkim(fixture.message, dns, 2000000000000)).resolves.toEqual(
        { status: "fail", domain: null });
  });

  it("accepts an unexpired signature (x= in the future)", async () => {
    let fixture = await signedFixture({ extraTags: "x=4000000000" });
    let dns = dnsWith({ [fixture.keyName]: [fixture.keyRecord] });
    await expect(verifyDkim(fixture.message, dns, 2000000000000)).resolves.toEqual(
        { status: "aligned", domain: "example.org" });
  });

  it("fails a signature whose l= covers only part of the canonical body", async () => {
    // l= signs a body prefix, so content appended after the signed prefix used to verify too;
    // the appended attack below must fail the signature instead of aligning it.
    let limit = "Hi.\r\n".length;
    let fixture = await signedFixture({ bodyLimit: limit, appendToBody: "APPENDED ATTACK\r\n" });
    let dns = dnsWith({ [fixture.keyName]: [fixture.keyRecord] });
    expect(CANONICAL_BODY.length).toBeGreaterThan(limit);
    await expect(verifyDkim(fixture.message, dns)).resolves.toEqual(
        { status: "fail", domain: null });
  });

  it("fails a signature whose l= exceeds the canonical body length", async () => {
    let fixture = await signedFixture({ bodyLimit: CANONICAL_BODY.length + 10 });
    let dns = dnsWith({ [fixture.keyName]: [fixture.keyRecord] });
    await expect(verifyDkim(fixture.message, dns)).resolves.toEqual(
        { status: "fail", domain: null });
  });

  it("accepts an l= that covers the canonical body exactly", async () => {
    let fixture = await signedFixture({ bodyLimit: CANONICAL_BODY.length });
    let dns = dnsWith({ [fixture.keyName]: [fixture.keyRecord] });
    await expect(verifyDkim(fixture.message, dns)).resolves.toEqual(
        { status: "aligned", domain: "example.org" });
  });

  it("fails a message with two From headers, even though the signed one is intact", async () => {
    // The signature covers the lower (original) From instance, but header-order readers like
    // PostalMime may display the first one; the ambiguity fails the signature outright.
    let fixture = await signedFixture();
    let withDuplicate = fromBytes(fixture.message).replace(
        "From:   Joe   <joe@example.org>",
        "From: mallory@evil.test\r\nFrom:   Joe   <joe@example.org>");
    let dns = dnsWith({ [fixture.keyName]: [fixture.keyRecord] });
    await expect(verifyDkim(toBytes(withDuplicate), dns)).resolves.toEqual(
        { status: "fail", domain: null });
  });

  it("reads a message without any From header as a verification failure", async () => {
    let fixture = await signedFixture();
    let withoutFrom = fromBytes(fixture.message).replace(
        "From:   Joe   <joe@example.org>\r\n", "");
    let dns = dnsWith({ [fixture.keyName]: [fixture.keyRecord] });
    await expect(verifyDkim(toBytes(withoutFrom), dns)).resolves.toEqual(
        { status: "fail", domain: null });
  });

  it("fails only the signature with a malformed b=, letting a later signature verify", async () => {
    // The first signature passes every check up to b= (resolvable selector, matching bh) but
    // its b= is not base64; without per-signature containment the decode throw failed the
    // whole message instead of falling through to the valid signature below it.
    let fixture = await signedFixture();
    let withMalformed = fromBytes(fixture.message).replace(
        "DKIM-Signature: ",
        "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.org; s=tsubi;" +
        ` h=from; bh=${fixture.bodyHash}; b=!!!!\r\nDKIM-Signature: `);
    let dns = dnsWith({ [fixture.keyName]: [fixture.keyRecord] });
    await expect(verifyDkim(toBytes(withMalformed), dns)).resolves.toEqual(
        { status: "aligned", domain: "example.org" });
  });

  it("picks the valid signature among several, and skips unrelated TXT records", async () => {
    let fixture = await signedFixture();
    let raw = new TextDecoder("latin1").decode(fixture.message);
    // The decoy signature hashes the real body (so it survives the bh check and forces a DNS
    // miss on its selector) but carries a bogus b= that no key can ever verify.
    let withDecoy = raw.replace(
        "DKIM-Signature: ",
        "DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.org; s=missing;" +
        ` h=from; bh=${fixture.bodyHash}; b=AAAA\r\nDKIM-Signature: `);
    let dns = dnsWith({
      [fixture.keyName]: ["v=spf1 include:_spf.example.org ~all", fixture.keyRecord],
    });
    await expect(verifyDkim(toBytes(withDecoy), dns)).resolves.toEqual(
        { status: "aligned", domain: "example.org" });
    expect(dns.names).toEqual(["missing._domainkey.example.org", fixture.keyName]);
  });
});

describe("parseTxtAnswers", () => {
  const QUERY = "tsubi._domainkey.example.org";

  function dohAnswer(answers: Array<{ name: string, type: number, data: string }>): string {
    return JSON.stringify({ Status: 0, Answer: answers });
  }

  it("concatenates quoted chunks of a long TXT record", () => {
    let text = dohAnswer([
      { name: QUERY + ".", type: 16, data: "\"v=DKIM1; k=rsa; p=MIGfMA0G\" \"CSqGSIb3DQEBA\"" },
    ]);
    expect(parseTxtAnswers(text, QUERY)).toEqual(["v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBA"]);
  });

  it("ignores non-TXT answers (CNAME chains) and mismatched names", () => {
    let text = dohAnswer([
      { name: QUERY, type: 5, data: "\"tsubi._domainkey.example.org.cdn.example.net\"" },
      { name: "other._domainkey.example.org", type: 16, data: "\"v=DKIM1; p=AAA\"" },
      { name: QUERY + ".", type: 16, data: "\"v=DKIM1; p=BBB\"" },
    ]);
    expect(parseTxtAnswers(text, QUERY)).toEqual(["v=DKIM1; p=BBB"]);
  });

  it("returns no records for a non-NOERROR status", () => {
    expect(parseTxtAnswers(JSON.stringify({ Status: 3 }), QUERY)).toEqual([]);
  });
});

describe("dohDns", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queries the DoH JSON endpoint and returns parsed TXT answers", async () => {
    let urls: string[] = [];
    let accepts: string[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      accepts.push(new Headers(init?.headers).get("accept") ?? "");
      return new Response(
          JSON.stringify({ Status: 0, Answer: [{ name: "a.example", type: 16, data: "\"x\"" }] }),
          { headers: { "content-type": "application/dns-json" } });
    });

    await expect(dohDns("https://dns.example/dns-query").resolveTxt("a.example"))
        .resolves.toEqual(["x"]);
    expect(urls).toEqual(["https://dns.example/dns-query?name=a.example&type=TXT"]);
    expect(accepts).toEqual(["application/dns-json"]);
  });

  it("throws on a non-2xx DoH response", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 500 }));

    await expect(dohDns().resolveTxt("a.example")).rejects.toThrow("HTTP 500");
  });
});
