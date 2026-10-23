// DKIM (RFC 6376) signature verification over a raw RFC 5322 message.
//
// Why DKIM and not SPF: the Cloudflare Email Workers runtime hands the `email()` handler the
// envelope sender/recipient, the parsed headers, and the raw message bytes, but not the SMTP
// client address -- so SPF cannot be evaluated inside the worker. DKIM signs the message itself,
// so it is verifiable from the raw bytes alone. The envelope sender is kept alongside the DKIM
// result as a complementary signal (see IncomingEmail.authentication.envelopeMismatch).
//
// Fail-closed posture: any parse error, unsupported algorithm, DNS failure, or expired
// signature makes that signature unverifiable, which can only *lower* the trust stamp the
// observation carries -- never silently raise it.

const MAX_SIGNATURES = 5;
const MAX_DNS_RESPONSE_BYTES = 64 * 1024;
const DNS_TIMEOUT_MS = 4000;

export type DkimStatus =
    | "aligned"    // a signature verified and its d= domain matches the From domain
    | "unaligned"  // a signature verified, but d= does not match the From domain
    | "fail"       // signatures were present but none could be verified
    | "none";      // no DKIM-Signature header at all

export type DkimOutcome = {
  status: DkimStatus;
  /**
   * The d= domain the outcome was decided on: the aligned signature's domain for "aligned",
   * the first verified signature's domain for "unaligned", null otherwise.
   */
  domain: string | null;
};

export type DkimDns = {
  /**
   * Resolve the TXT records at a fully-qualified name. Each returned string is one record with
   * its quoted string chunks concatenated. Throwing signals lookup failure (signature fails).
   */
  resolveTxt(name: string): Promise<string[]>;
};

// ---------------------------------------------------------------------------------------------
// Byte-string helpers. DKIM hashes operate on exact message bytes; we work in "latin1" strings
// (one char = one byte) so canonicalization can use string operations while still hashing and
// re-encoding the original bytes bit-for-bit. TextEncoder (UTF-8) would re-encode non-ASCII.

function latin1Decode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    out += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return out;
}
function latin1Encode(text: string): Uint8Array {
  let out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}


function b64decode(value: string): Uint8Array {
  let binary = atob(value.replace(/[ \t\r\n]/g, ""));
  let out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 4096) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
  }
  return btoa(binary);
}

// ---------------------------------------------------------------------------------------------
// RFC 5322 message structure.

type HeaderInstance = {
  /** Header field name as it appears (case preserved). */
  name: string;
  /** Lowercased field name. */
  lower: string;
  /** The full instance text, folds included, without the trailing CRLF. */
  raw: string;
};

type ParsedMessage = {
  instances: HeaderInstance[];
  /** Body bytes as a latin1 string, starting right after the blank separator line. */
  body: string;
};

function parseMessage(raw: Uint8Array): ParsedMessage {
  let text = latin1Decode(raw);
  let separator = text.indexOf("\r\n\r\n");
  let headerBlock = separator < 0 ? text : text.slice(0, separator);
  let body = separator < 0 ? "" : text.slice(separator + 4);

  let instances: HeaderInstance[] = [];
  let current: HeaderInstance | null = null;
  for (let line of headerBlock.split("\r\n")) {
    if (/^[ \t]/.test(line) && current) {
      current.raw += "\r\n" + line;
      continue;
    }
    let colon = line.indexOf(":");
    if (colon < 0) continue;
    current = { name: line.slice(0, colon), lower: line.slice(0, colon).toLowerCase(), raw: line };
    instances.push(current);
  }
  return { instances, body };
}

/** Removes RFC 5322 folding (CRLF followed by WSP), leaving the leading WSP of each fold. */
function unfold(text: string): string {
  return text.replace(/\r\n([ \t])/g, "$1");
}

/** Parses an unfolded DKIM tag-list (signature or key record) into lowercased tag names. */
function parseTags(value: string): Map<string, string> {
  let tags = new Map<string, string>();
  for (let part of value.split(";")) {
    let match = /^[ \t\r\n]*([a-zA-Z][a-zA-Z0-9_]*)[ \t\r\n]*=(.*)$/.exec(part);
    if (match) tags.set(match[1].toLowerCase(), match[2].replace(/[ \t\r\n]+/g, " ").trim());
  }
  return tags;
}

/**
 * Removes the b= tag's value and surrounding whitespace from the raw (still folded) signature
 * header text, as RFC 6376 section 3.7 requires before hashing the DKIM-Signature itself.
 * The tag name and "=" are kept; only the value plus adjacent FWS go. b= value runs may
 * include interior folds and trailing base64 padding ("=="), so the pattern must accept '='
 * anywhere inside the run: over-deleting can only fail a signature, never pass one.
 */
const B_TAG_VALUE =
    /(^|;)([ \t\r\n]*)b([ \t\r\n]*)=([ \t\r\n]*)((?:[A-Za-z0-9+/=]+[ \t\r\n]*)*)/;

function stripBTag(rawHeader: string): string {
  return rawHeader.replace(B_TAG_VALUE,
      (_all, pre: string, leadingFws: string, _tag: string, _eq: string, _value: string) =>
          `${pre}${leadingFws}b=`);
}

function relaxedHeader(instance: { raw: string }): string {
  let colon = instance.raw.indexOf(":");
  let name = instance.raw.slice(0, colon).toLowerCase();
  let value = unfold(instance.raw.slice(colon + 1))
      .replace(/[ \t]+/g, " ")
      .replace(/^[ \t]+|[ \t]+$/g, "");
  return `${name}:${value}`;
}

/**
 * Canonicalizes the body per RFC 6376 section 3.4: simple keeps bytes as-is; relaxed collapses
 * WSP runs and strips line-trailing WSP. Both drop trailing empty lines and ensure a final CRLF
 * on a non-empty body. `limit` implements the l= tag (bytes of canonical body to hash).
 */
function canonicalizeBody(body: string, mode: "simple" | "relaxed", limit: number | null): string {
  let canonical = mode === "relaxed"
      ? body.split("\r\n").map(line => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/g, "")).join("\r\n")
      : body;
  canonical = canonical.replace(/(?:\r\n)*$/, "");
  if (canonical.length > 0) canonical += "\r\n";
  if (limit != null && limit < canonical.length) canonical = canonical.slice(0, limit);
  return canonical;
}

/** Extracts the lowercase domain of the first From: header instance, or null if absent. */
function fromDomainOf(instances: HeaderInstance[]): string | null {
  let from = instances.find(instance => instance.lower === "from");
  if (!from) return null;
  let value = unfold(from.raw.slice(from.raw.indexOf(":") + 1));
  let angled = /<([^>]*)>/.exec(value);
  let address = angled ? angled[1] : value.trim().split(/\s+/).pop() ?? "";
  let at = address.lastIndexOf("@");
  if (at < 0) return null;
  return address.slice(at + 1).replace(/[.,;:>\]]+$/, "").toLowerCase();
}

// ---------------------------------------------------------------------------------------------
// Key records (RFC 6376 section 3.6.1).

type KeyMaterial = { algorithm: string, key: CryptoKey };

async function importKeyRecord(record: string, signatureAlgorithm: string): Promise<KeyMaterial | null> {
  let tags = parseTags(record);
  let version = tags.get("v");
  if (version != null && version.split(" ")[0] !== "DKIM1") return null;
  let keyType = tags.get("k") ?? "rsa";
  let hashAlgorithms = tags.get("h");
  if (hashAlgorithms != null && !hashAlgorithms.split(":").includes("sha256")) return null;
  let publicKey = tags.get("p");
  if (publicKey == null || publicKey.replace(/[ \t]/g, "") === "") return null;  // revoked

  let der = b64decode(publicKey);
  if (signatureAlgorithm === "rsa-sha256" && keyType === "rsa") {
    return {
      algorithm: signatureAlgorithm,
      key: await crypto.subtle.importKey(
          "spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
    };
  }
  if (signatureAlgorithm === "ed25519-sha256" && keyType === "ed25519") {
    return {
      algorithm: signatureAlgorithm,
      key: await crypto.subtle.importKey("raw", der, { name: "Ed25519" }, false, ["verify"]),
    };
  }
  return null;
}

async function lookupKey(dns: DkimDns, selector: string, domain: string,
    signatureAlgorithm: string): Promise<CryptoKey | null> {
  let records: string[];
  try {
    records = await dns.resolveTxt(`${selector}._domainkey.${domain}`);
  } catch {
    return null;  // fail-closed: DNS failure means the signature cannot be trusted
  }
  for (let record of records) {
    let material = await importKeyRecord(record, signatureAlgorithm).catch(() => null);
    if (material) return material.key;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Signature verification (RFC 6376 section 6).

/** Verifies one DKIM-Signature instance; returns its d= domain on success, null on any failure. */
async function verifySignature(signature: HeaderInstance, message: ParsedMessage, dns: DkimDns,
    now: number): Promise<string | null> {
  let tags = parseTags(unfold(signature.raw.slice(signature.raw.indexOf(":") + 1)));
  if (tags.get("v") !== "1") return null;

  let algorithm = tags.get("a");
  if (algorithm !== "rsa-sha256" && algorithm !== "ed25519-sha256") return null;

  let selector = tags.get("s");
  let domain = tags.get("d");
  let bodyHash = tags.get("bh");
  let signatureValue = tags.get("b");
  let headerList = tags.get("h");
  if (!selector || !domain || !bodyHash || !signatureValue || !headerList) return null;
  let headerNames = headerList.split(":").map(name => name.trim().toLowerCase()).filter(Boolean);
  if (!headerNames.includes("from")) return null;  // RFC 6376 5.4: From MUST be signed

  let canon = tags.get("c") ?? "simple/simple";
  let [headerMode, bodyMode = "simple"] = canon.split("/");
  if (headerMode !== "simple" && headerMode !== "relaxed") return null;
  if (bodyMode !== "simple" && bodyMode !== "relaxed") return null;

  let identity = tags.get("i");
  if (identity) {
    let identityDomain = identity.slice(identity.lastIndexOf("@") + 1).toLowerCase();
    if (identityDomain !== domain && !identityDomain.endsWith("." + domain)) return null;
  }

  let expires = tags.get("x");
  if (expires != null && (!/^\d+$/.test(expires) || Number(expires) * 1000 < now)) return null;

  let limit = tags.get("l");
  let bodyLimit = limit != null && /^\d+$/.test(limit) ? Number(limit) : null;

  let canonicalBody = canonicalizeBody(message.body, bodyMode, bodyLimit);
  let computedBodyHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", latin1Encode(canonicalBody)));
  if (b64encode(computedBodyHash) !== bodyHash.replace(/[ \t]/g, "")) return null;

  let key = await lookupKey(dns, selector, domain, algorithm);
  if (!key) return null;

  // Assemble the signed header text: the h=-listed instances, selected bottom-up, then this
  // signature header itself with the b= value removed and without a trailing CRLF.
  let signatureIndex = message.instances.indexOf(signature);
  let used = new Set([signatureIndex]);
  let input = "";
  for (let name of headerNames) {
    for (let i = message.instances.length - 1; i >= 0; i--) {
      if (used.has(i) || message.instances[i].lower !== name) continue;
      let instance = message.instances[i];
      input += (headerMode === "simple" ? instance.raw : relaxedHeader(instance)) + "\r\n";
      used.add(i);
      break;
    }
  }
  let stripped = stripBTag(signature.raw);
  input += headerMode === "simple" ? stripped : relaxedHeader({ raw: stripped });

  let verified = algorithm === "rsa-sha256"
      ? await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64decode(signatureValue),
            latin1Encode(input))
      : await crypto.subtle.verify({ name: "Ed25519" }, key, b64decode(signatureValue),
            latin1Encode(input));
  return verified ? domain : null;
}

/**
 * Verifies every DKIM-Signature on the message (capped, in header order) and reports the best
 * outcome relative to the From domain: "aligned" beats "unaligned" beats "fail". Alignment is
 * d= equal to, or a DNS parent of, the From domain. Without the Public Suffix List we cannot
 * compute registrable domains, but suffix alignment is still sound here: publishing a key under
 * d= requires controlling d='s DNS zone, and a zone controlling a parent of the From domain
 * could speak for that domain's mail anyway.
 */
export async function verifyDkim(raw: Uint8Array, dns: DkimDns,
    now: number = Date.now()): Promise<DkimOutcome> {
  let message = parseMessage(raw);
  let signatures = message.instances
      .filter(instance => instance.lower === "dkim-signature")
      .slice(0, MAX_SIGNATURES);
  if (signatures.length === 0) return { status: "none", domain: null };

  let fromDomain = fromDomainOf(message.instances);
  let firstVerified: string | null = null;
  for (let signature of signatures) {
    let domain = await verifySignature(signature, message, dns, now);
    if (domain == null) continue;
    if (fromDomain != null && (domain === fromDomain || fromDomain.endsWith("." + domain))) {
      return { status: "aligned", domain };
    }
    firstVerified ??= domain;
  }
  return firstVerified != null
      ? { status: "unaligned", domain: firstVerified }
      : { status: "fail", domain: null };
}

// ---------------------------------------------------------------------------------------------
// Production DNS: Cloudflare's DNS-over-HTTPS JSON API.

/** Parses a DoH JSON response into TXT record strings (quoted chunks concatenated). */
export function parseTxtAnswers(responseText: string, queryName: string): string[] {
  let json = JSON.parse(responseText) as {
    Status?: number,
    Answer?: Array<{ name?: string, type?: number, data?: string }>,
  };
  if (json.Status !== 0 || !Array.isArray(json.Answer)) return [];
  let wanted = queryName.toLowerCase().replace(/\.+$/, "");
  return json.Answer
      .filter(answer => answer.type === 16 && typeof answer.data === "string"
          && (answer.name ?? "").toLowerCase().replace(/\.+$/, "") === wanted)
      .map(answer => {
        // RFC 1035 TXT records concatenate their quoted character-strings with no separator.
        let chunks = (answer.data as string).match(/"[^"]*"/g);
        return chunks ? chunks.map(chunk => chunk.slice(1, -1)).join("") : (answer.data as string);
      });
}

/**
 * DNS resolver over Cloudflare's public DoH JSON endpoint (`cloudflare-dns.com`), the standard
 * way for a Worker to reach DNS without a dedicated binding.
 */
export function dohDns(url = "https://cloudflare-dns.com/dns-query"): DkimDns {
  return {
    async resolveTxt(name: string): Promise<string[]> {
      let response = await fetch(`${url}?name=${encodeURIComponent(name)}&type=TXT`, {
        headers: { "accept": "application/dns-json" },
        signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`DoH lookup of ${name} failed: HTTP ${response.status}`);
      let text = await response.text();
      if (text.length > MAX_DNS_RESPONSE_BYTES) {
        throw new Error(`DoH answer for ${name} exceeded ${MAX_DNS_RESPONSE_BYTES} bytes`);
      }
      return parseTxtAnswers(text, name);
    },
  };
}
