import { matchSpaceRoute } from "@/lib/space-routing";

// 클라이언트의 스페이스 API 경로 헬퍼 (#12 1번).
//
// 주소창이 /sea/files 인 화면의 모든 API 호출은 그 스페이스를 봐야 한다.
// 헤더 방식은 iframe·anchor.href·window.open처럼 헤더를 실을 수 없는 호출을
// 못 덮으므로, URL 자체에 스페이스를 싣는다: /api/x → /sea/api/x.
// proxy가 /sea/api/x 를 /api/x 로 rewrite하면서 스페이스 헤더를 심고, 서버
// 러너(runWithSession 계열)가 그 헤더로 문맥을 세운다.
//
// 현재 스페이스는 주소창 경로에서 파생한다 — proxy의 경로 판정과 같은 순수
// 함수(matchSpaceRoute)를 쓰므로 서버가 이 화면을 어느 스페이스로 rewrite했는지와
// 정확히 일치한다. 전역 상태·prop 배선이 없어 어느 컴포넌트에서든 안전하다.

/** 화면 경로에서 현재 스페이스 슬러그를 얻는다. 기본 데스크면 null. */
export function spaceSlugFromPathname(pathname: string): string | null {
  return matchSpaceRoute(pathname)?.slug ?? null;
}

/**
 * API 경로에 현재 스페이스 프리픽스를 붙인다. 기본 데스크(또는 서버 렌더
 * 중)면 그대로 돌려준다. 반드시 "/api/..." 리터럴을 쓰는 자리에서 부른다 —
 * 이미 프리픽스가 붙은 경로를 다시 넣으면 프리픽스가 중복된다.
 */
export function apiPath(path: string): string {
  if (typeof window === "undefined") return path;
  const slug = spaceSlugFromPathname(window.location.pathname);
  return slug ? `/${slug}${path}` : path;
}
