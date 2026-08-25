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
