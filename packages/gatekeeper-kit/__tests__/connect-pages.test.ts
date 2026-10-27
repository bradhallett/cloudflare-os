import { describe, expect, it } from "vitest";
import {
  connectHandoffPageHtml,
  errorPageHtml,
  escapeHtml,
  htmlResponse,
  INVALID_LINK_HTML,
} from "../src/connect-pages";

const HANDOFF = { targetOrigin: "https://workshop.example", ticket: "a".repeat(64) };

describe("connect pages", () => {
  it("escapes every character that could break out of markup", () => {
    expect(escapeHtml(`<img src="x" onerror='alert(1)'>&`))
      .toBe("&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;");
  });

  it("escapes vendor-supplied error text into the page", () => {
    const html = errorPageHtml("Acme <b>Gatekeeper</b>", "Ask an admin & retry");

    expect(html).toContain("<h1>Acme &lt;b&gt;Gatekeeper&lt;/b&gt;</h1>");
    expect(html).toContain("Ask an admin &amp; retry");
    expect(html).not.toContain("<b>");
  });

  it("declares a language and viewport on every page it serves", () => {
    for (const html of [
      connectHandoffPageHtml(HANDOFF), INVALID_LINK_HTML, errorPageHtml("Failed", "Retry"),
    ]) {
      expect(html).toContain(`<html lang="en">`);
      expect(html).toContain(`name="viewport"`);
    }
  });

  it("serves uncached HTML that cannot be framed, sniffed, or leak a nonce", async () => {
    const response = htmlResponse("<p>hi</p>", 400);

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Security-Policy")).toBe("frame-ancestors 'none'");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.text()).toBe("<p>hi</p>");
  });
});

describe("connectHandoffPageHtml", () => {
  // Pulls the ticket and target origin the page's script navigates with out of its two literals.
  function scriptLiterals(html: string): [string, string] {
    const ticket = /var ticket = (".*?");\n/.exec(html);
    const target = /var target = (".*?");\n/.exec(html);
    expect(ticket).not.toBeNull();
    expect(target).not.toBeNull();
    // The literals are JSON with `<`, `>` and `&` written as \uXXXX escapes, which JSON accepts.
    return [JSON.parse(ticket![1]), JSON.parse(target![1])];
  }

  it("navigates the popup to the Workshop's handoff page with the ticket in the fragment", () => {
    const html = connectHandoffPageHtml(HANDOFF);
    const [ticket, target] = scriptLiterals(html);

    expect(ticket).toBe(HANDOFF.ticket);
    expect(target).toBe("https://workshop.example");
    // The path is pinned here and in workshop-frontend's route: the kit must not depend on it.
    expect(html).toContain(
      `window.location.replace(target + "/connect/handoff#" + encodeURIComponent(ticket))`);
  });

  it("cannot be broken out of by the ticket or origin it embeds", () => {
    const hostile = { targetOrigin: "https://workshop.example", ticket: `</script><img src=x onerror=alert(1)>&'"` };
    const html = connectHandoffPageHtml(hostile);

    expect(html).not.toContain("</script><img");
    expect(html.split("<script>")).toHaveLength(2);
    expect(html.split("</script>")).toHaveLength(2);
    expect(scriptLiterals(html)[0]).toBe(hostile.ticket);
  });

  it("refuses a targetOrigin that is not exactly an origin", () => {
    // A trailing slash or path would produce a malformed redirect; an unparsable value or an opaque
    // origin would send the ticket somewhere else.
    for (const targetOrigin of [
      "https://workshop.example/", "https://workshop.example/app", "*", "null", "workshop.example",
      "", "javascript:alert(1)",
    ]) {
      expect(() => connectHandoffPageHtml({ ...HANDOFF, targetOrigin }))
        .toThrow("targetOrigin is not an origin");
    }
    expect(() => connectHandoffPageHtml({ ...HANDOFF, targetOrigin: "http://localhost:3000" }))
      .not.toThrow();
  });

  it("keeps the referrer policy that hides the path from cross-origin requests", () => {
    expect(connectHandoffPageHtml(HANDOFF))
      .toContain(`<meta name="referrer" content="strict-origin-when-cross-origin">`);
  });

  it("carries no channel, opener or message transport", () => {
    const html = connectHandoffPageHtml(HANDOFF);

    for (const transport of [
      "BroadcastChannel", "opener", "postMessage", "setTimeout", "setInterval",
    ]) {
      expect(html).not.toContain(transport);
    }
  });
});

