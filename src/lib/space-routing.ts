import { parseSpaceSlug } from "@/lib/space-slug";

// proxy의 경로 판정만 떼어 낸 순수 함수. NextRequest 없이 테스트한다.
// /<slug>/files, /<slug>/admin, /<slug>/api 만 스페이스 라우팅으로 본다.
// api를 포함하는 이유(#12 1번): iframe·anchor·window.open처럼 헤더를 실을 수
// 없는 호출이 있어, 클라이언트는 스페이스 API를 경로 프리픽스로 부른다 —
// /sea/api/drive/list → proxy가 /api/drive/list 로 rewrite하며 헤더를 심는다.
const SPACE_SUBPATHS = new Set(["files", "admin", "api"]);

export interface SpaceRoute {
  slug: string;
  // rewrite 대상. /sea/files/x → /files/x
  rewritePath: string;
}

/**
 * 경로가 스페이스 라우팅이면 슬러그와 rewrite 대상을 준다. 아니면 null.
 * 슬러그 형태가 어긋나거나 예약어면(parseSpaceSlug가 거른다) 스페이스로 보지
 * 않는다 — /files 자체는 기본 데스크의 경로다.
 */
export function matchSpaceRoute(pathname: string): SpaceRoute | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const slug = parseSpaceSlug(segments[0]);
  if (!slug) return null;
  if (!SPACE_SUBPATHS.has(segments[1])) return null;
  return {
    slug,
    rewritePath: "/" + segments.slice(1).join("/"),
  };
}

// proxy의 서명 사전 검사를 면제받는 공개 API. 서버 러너 쪽의 공개 라우트
// 목록과 정확히 대칭이다(runWithSpace(null)로 기본 문맥을 고정하는 라우트들):
// - /api/auth*            로그인·로그아웃·구글 콜백 — 세션이 생기기 전이다
// - /api/share/<linkId>   외부 공유 링크 — 링크만 알면 연다
// - /api/public-folder/<token>/* 공개 폴더(#10) — 외부인이 무로그인으로
//   목록·다운로드·업로드한다 (멤버용 /api/public-folders 목록은 세션 필요
//   라우트라 여기 없다)
// - /api/invitations/code 가입 절차 — 승인 전 사용자가 부른다
// - /api/update-policy    자동 업데이트 워크플로가 키 없이 읽는다
// - /api/cron/*           예약 실행 — 세션 대신 CRON_SECRET으로 판정한다
// 최종 판정은 언제나 각 라우트가 한다 — 이 목록은 어디까지나 사전 거름망의
// 면제 목록이지 허가 목록이 아니다.
const PUBLIC_API_PREFIXES = [
  "/api/auth",
  "/api/share/",
  "/api/public-folder/",
  "/api/cron/",
];
const PUBLIC_API_EXACT = new Set(["/api/invitations/code", "/api/update-policy"]);

export function isPublicApiPath(pathname: string): boolean {
  if (PUBLIC_API_EXACT.has(pathname)) return true;
  return PUBLIC_API_PREFIXES.some(
    (prefix) =>
      pathname === prefix ||
      pathname.startsWith(prefix.endsWith("/") ? prefix : prefix + "/"),
  );
}
