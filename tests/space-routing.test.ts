import assert from "node:assert/strict";
import test from "node:test";
import { matchSpaceRoute } from "../src/lib/space-routing";

test("스페이스 경로를 슬러그와 rewrite 대상으로 가른다", () => {
  assert.deepEqual(matchSpaceRoute("/sea/files"), {
    slug: "sea",
    rewritePath: "/files",
  });
  assert.deepEqual(matchSpaceRoute("/sea/files/sub/deep"), {
    slug: "sea",
    rewritePath: "/files/sub/deep",
  });
  assert.deepEqual(matchSpaceRoute("/team/admin"), {
    slug: "team",
    rewritePath: "/admin",
  });
  // 대문자 슬러그는 소문자로 접힌다 — /A/files 도 같은 스페이스.
  assert.deepEqual(matchSpaceRoute("/A/files"), {
    slug: "a",
    rewritePath: "/files",
  });
});

test("스페이스가 아닌 경로는 null", () => {
  for (const path of [
    // 기본 데스크 경로 — 예약어라 슬러그로 안 잡힌다.
    "/files",
    "/admin",
    "/files/sub",
    // 스페이스 하위 경로가 아닌 것
    "/sea",
    "/sea/chat",
    "/sea/settings",
    // 예약어를 슬러그로 쓴 경우
    "/api/files",
    "/join/files",
    // 형태가 어긋난 슬러그
    "/-bad/files",
    "/a b/files",
    "/",
    "",
  ]) {
    assert.equal(matchSpaceRoute(path), null, `null이어야 함: ${path}`);
  }
});
