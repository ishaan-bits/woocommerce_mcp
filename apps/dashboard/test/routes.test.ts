import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  documentTitleFor,
  isRouteId,
  parseRoute,
  routeHash,
  routesForRole,
  ROUTES,
  ROUTE_IDS,
  type RouteId,
} from "../src/lib/routes.ts";

describe("route parsing", () => {
  test("every declared route id round-trips through parseRoute/routeHash", () => {
    for (const id of ROUTE_IDS) {
      assert.equal(parseRoute(routeHash(id)), id, `hash for ${id}`);
      assert.equal(parseRoute(`#${id}`), id, `bare hash for ${id}`);
    }
  });

  test("legacy and new routes both work", () => {
    assert.equal(parseRoute("#/overview"), "overview");
    assert.equal(parseRoute("#/tools"), "tools");
    assert.equal(parseRoute("#/upstreams"), "upstreams");
    assert.equal(parseRoute("#/audit"), "audit");
    assert.equal(parseRoute("#/chat"), "chat");
    assert.equal(parseRoute("#/team"), "team");
    assert.equal(parseRoute("#/settings"), "settings");
  });

  test("unknown or empty hashes fall back to overview", () => {
    assert.equal(parseRoute(""), "overview");
    assert.equal(parseRoute("#"), "overview");
    assert.equal(parseRoute("#/"), "overview");
    assert.equal(parseRoute("#/nope"), "overview");
    assert.equal(parseRoute("#/Team"), "overview", "matching is case-sensitive by design");
    assert.equal(parseRoute("#/overview/extra"), "overview");
  });

  test("query strings and fragments are tolerated but not matched", () => {
    assert.equal(parseRoute("#/team?tab=keys"), "team");
    assert.equal(parseRoute("#/audit#fragment"), "audit");
  });

  test("isRouteId narrows only known ids", () => {
    assert.ok(isRouteId("team"));
    assert.ok(isRouteId("settings"));
    assert.ok(!isRouteId("nope"));
  });

  test("documentTitleFor covers every route and falls back", () => {
    for (const id of ROUTE_IDS) {
      const title = documentTitleFor(id);
      assert.ok(title.endsWith("· Urumi MCP Gateway"), `title for ${id}: ${title}`);
    }
    assert.equal(documentTitleFor("overview" as RouteId), "Overview · Urumi MCP Gateway");
    assert.ok(documentTitleFor("team").startsWith("Team & API keys"));
  });

  test("admin-only nav entries are Governance; readers get Platform+Help only", () => {
    const adminIds = routesForRole("admin").map((route) => route.id);
    const readerIds = routesForRole("reader").map((route) => route.id);
    assert.deepEqual(adminIds, ROUTE_IDS);
    assert.ok(!readerIds.includes("audit"));
    assert.ok(!readerIds.includes("team"));
    assert.ok(readerIds.includes("overview"));
    assert.ok(readerIds.includes("settings"));
    // Grouping used by the sidebar.
    const audit = ROUTES.find((route) => route.id === "audit");
    assert.equal(audit?.group, "Governance");
    assert.equal(audit?.adminOnly, true);
  });
});
