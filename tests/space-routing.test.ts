import assert from "node:assert/strict";
import test from "node:test";
import { isPublicApiPath, matchSpaceRoute } from "../src/lib/space-routing";
import { apiPath, spaceSlugFromPathname } from "../src/lib/client/api-path";

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
  // API 프리픽스(#12 1번): 헤더를 못 싣는 iframe·anchor까지 스페이스로 보낸다.
  assert.deepEqual(matchSpaceRoute("/sea/api/drive/list"), {
    slug: "sea",
    rewritePath: "/api/drive/list",
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
    "/api/drive/list",
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

test("공개 API 판정 — 러너의 공개 라우트 목록과 대칭이다", () => {
  // 세션 없이 열려야 하는 경로들. proxy가 서명 사전 검사를 면제한다.
  for (const path of [
    "/api/auth",
    "/api/auth/google",
    "/api/auth/google/callback",
    "/api/share/abc123",
    "/api/invitations/code",
    "/api/update-policy",
    "/api/cron/share-cleanup",
  ]) {
    assert.equal(isPublicApiPath(path), true, `공개여야 함: ${path}`);
  }
  // 보호 경로는 공개가 아니다 — 접두사가 비슷해도 갈라야 한다.
  for (const path of [
    "/api/drive/list",
    "/api/admin/users",
    "/api/spaces",
    "/api/chat",
    "/api/presence",
    "/api/me/nickname",
    "/api/share", // 소비 경로는 /api/share/<linkId> 뿐이다
    "/api/authx", // 접두사 흉내
    "/api/update-policyx",
  ]) {
    assert.equal(isPublicApiPath(path), false, `보호여야 함: ${path}`);
  }
});

test("apiPath는 화면 경로의 스페이스를 API 경로에 프리픽스로 싣는다", () => {
  assert.equal(spaceSlugFromPathname("/sea/files"), "sea");
  assert.equal(spaceSlugFromPathname("/files"), null);

  const saved = (globalThis as { window?: unknown }).window;
  const setPath = (pathname: string) => {
    (globalThis as { window?: unknown }).window = { location: { pathname } };
  };
  try {
    setPath("/sea/files");
    assert.equal(apiPath("/api/drive/list"), "/sea/api/drive/list");
    setPath("/sea/admin");
    assert.equal(apiPath("/api/admin/users"), "/sea/api/admin/users");
    // 기본 데스크 화면에서는 그대로.
    setPath("/files");
    assert.equal(apiPath("/api/drive/list"), "/api/drive/list");
    // 예약어 첫 세그먼트는 스페이스가 아니다.
    setPath("/join");
    assert.equal(apiPath("/api/invitations/code"), "/api/invitations/code");
  } finally {
    if (saved === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = saved;
    }
  }

  // 서버 렌더(window 없음)에서는 경로를 건드리지 않는다.
  assert.equal(apiPath("/api/drive/list"), "/api/drive/list");
});
