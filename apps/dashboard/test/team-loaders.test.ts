import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

const source = readFileSync(fileURLToPath(new URL("../src/pages/TeamPage.tsx", import.meta.url)), "utf8");

const refreshTeamBody = source.slice(
  source.indexOf("const refreshTeam"),
  source.indexOf("const refreshKeys"),
);
const refreshKeysBody = source.slice(
  source.indexOf("const refreshKeys"),
  source.indexOf("useEffect(() => {"),
);
const mountEffectBody = source.slice(source.indexOf("useEffect(() => {"), source.indexOf("const createUser"));

describe("REGRESSION: TeamPage loaders use independent sequencers", () => {
  // The members and keys loaders run back-to-back in ONE mount effect. When
  // both incremented a shared seq ref, refreshTeam's result was discarded
  // (its id was stale the moment refreshKeys incremented the counter), so the
  // Members tab rendered the skeleton forever even though GET /api/users was
  // 200. These checks pin the wiring so the two loaders can never share a
  // counter again (same spirit as the helm security assertions).
  test("each loader declares its own useRef sequencer", () => {
    assert.match(source, /const teamSeq = useRef\(0\)/, "members loader sequencer");
    assert.match(source, /const keysSeq = useRef\(0\)/, "keys loader sequencer");
    assert.doesNotMatch(source, /const seq = useRef\(0\)/, "no shared sequencer may exist");
  });

  test("refreshTeam guards on teamSeq only", () => {
    assert.match(refreshTeamBody, /const id = \+\+teamSeq\.current/, "increments its own counter");
    assert.match(refreshTeamBody, /if \(id !== teamSeq\.current\) return;/, "guards on its own counter");
    assert.doesNotMatch(refreshTeamBody, /keysSeq/, "must not touch the keys counter");
    assert.doesNotMatch(refreshTeamBody, /\bseq\b/, "must not reference a shared seq");
  });

  test("refreshKeys guards on keysSeq only", () => {
    assert.match(refreshKeysBody, /const id = \+\+keysSeq\.current/, "increments its own counter");
    assert.match(refreshKeysBody, /if \(id !== keysSeq\.current\) return;/, "guards on its own counter");
    assert.doesNotMatch(refreshKeysBody, /teamSeq/, "must not touch the members counter");
    assert.doesNotMatch(refreshKeysBody, /\bseq\b/, "must not reference a shared seq");
  });

  test("mount effect invalidates BOTH loaders on unmount", () => {
    assert.match(mountEffectBody, /void refreshTeam\(\)/, "members loader still started on mount");
    assert.match(mountEffectBody, /void refreshKeys\(\)/, "keys loader still started on mount");
    assert.match(mountEffectBody, /teamSeq\.current \+= 1/, "members in-flight result invalidated");
    assert.match(mountEffectBody, /keysSeq\.current \+= 1/, "keys in-flight result invalidated");
  });
});
