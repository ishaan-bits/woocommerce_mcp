import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cookieSecureRequested,
  readCookie,
  SESSION_COOKIE_NAME,
  sessionClearCookie,
  sessionSetCookie,
} from "../src/auth/sessions.ts";

describe("session cookie helpers (D33)", () => {
  test("cookieSecureRequested: auto follows the request scheme; true/false force it", () => {
    assert.equal(cookieSecureRequested("auto", true), true);
    assert.equal(cookieSecureRequested("auto", false), false);
    assert.equal(cookieSecureRequested("true", false), true);
    assert.equal(cookieSecureRequested("true", true), true);
    assert.equal(cookieSecureRequested("false", true), false);
    assert.equal(cookieSecureRequested("false", false), false);
  });

  test("sessionSetCookie: attributes are exact and Secure only when requested", () => {
    assert.equal(
      sessionSetCookie("tok_abc", 43_200, false),
      "urumi_session=tok_abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200",
    );
    assert.equal(
      sessionSetCookie("tok_abc", 43_200, true),
      "urumi_session=tok_abc; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200; Secure",
    );
  });

  test("sessionClearCookie mirrors the same Secure policy with Max-Age=0", () => {
    assert.equal(
      sessionClearCookie(false),
      "urumi_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    assert.equal(
      sessionClearCookie(true),
      "urumi_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure",
    );
  });

  test("readCookie: parses the named cookie and fails closed on junk", () => {
    assert.equal(readCookie(undefined, SESSION_COOKIE_NAME), null);
    assert.equal(readCookie("", SESSION_COOKIE_NAME), null);
    assert.equal(readCookie("other=1", SESSION_COOKIE_NAME), null);
    assert.equal(readCookie("urumi_session=", SESSION_COOKIE_NAME), null);
    assert.equal(readCookie("urumi_session", SESSION_COOKIE_NAME), null);
    assert.equal(readCookie("other=1; urumi_session=abc123; next=2", SESSION_COOKIE_NAME), "abc123");
    assert.equal(readCookie("urumi_session = abc123 ", SESSION_COOKIE_NAME), "abc123");
    assert.equal(readCookie("urumi_session=abc=def", SESSION_COOKIE_NAME), "abc=def");
  });
});
