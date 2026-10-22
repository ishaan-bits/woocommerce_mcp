import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const clientSource = readFileSync(fileURLToPath(new URL("../src/api/client.ts", import.meta.url)), "utf8");
const teamSource = readFileSync(fileURLToPath(new URL("../src/pages/TeamPage.tsx", import.meta.url)), "utf8");
const formSource = readFileSync(fileURLToPath(new URL("../src/components/MemberForm.tsx", import.meta.url)), "utf8");

const userRecordBlock = clientSource.slice(
  clientSource.indexOf("export interface UserRecord"),
  clientSource.indexOf("export interface UsersResponse"),
);

describe("REGRESSION: UserRecord mirrors the live /api/users response", () => {
  // The gateway's GET /api/users answers with camelCase (allowedUpstreams,
  // allowedTools, displayName — verified live), while /api/me stays
  // snake_case. The old interface declared snake_case for UserRecord, so the
  // members table read undefined.allowed_upstreams and crashed as soon as the
  // loaders worked (the shared-sequencer bug had been hiding this). These
  // checks pin the response shape and its consumers.
  test("interface declares the camelCase fields the server sends", () => {
    assert.match(userRecordBlock, /allowedUpstreams: string\[\]/, "camelCase allowedUpstreams");
    assert.match(userRecordBlock, /allowedTools: string\[\]/, "camelCase allowedTools");
    assert.doesNotMatch(userRecordBlock, /allowed_upstreams/, "snake_case would never exist at runtime");
    assert.doesNotMatch(userRecordBlock, /allowed_tools/, "snake_case would never exist at runtime");
  });

  test("members table reads the camelCase fields", () => {
    assert.match(teamSource, /user\.allowedUpstreams\.length/, "upstream cell");
    assert.match(teamSource, /user\.allowedTools\.length/, "grant-count cell");
    assert.doesNotMatch(teamSource, /user\.allowed_upstreams/, "snake_case read would crash");
    assert.doesNotMatch(teamSource, /user\.allowed_tools/, "snake_case read would crash");
  });

  test("edit form initialises from the camelCase fields", () => {
    assert.match(formSource, /user\.allowedUpstreams/, "spread must not be undefined");
    assert.match(formSource, /user\.allowedTools/, "spread must not be undefined");
    assert.doesNotMatch(formSource, /user\.allowed_upstreams/, "snake_case read would throw on Edit");
  });
});
