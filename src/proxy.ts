import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, openSigned } from "@/lib/session-token";
import { parseSpaceSlug, SPACE_HEADER } from "@/lib/space-slug";
import { matchSpaceRoute } from "@/lib/space-routing";

// 두 가지 일을 한다.
// 1) 멀티 데스크 라우팅: /sea/files 를 내부 /files 로 rewrite하면서 스페이스
//    슬러그를 SPACE_HEADER에 싣는다. 서버는 그 헤더로 스페이스를 안다.
// 2) 서명 거름망: 서명 없는·만료된 토큰만 걸러낸다. "승인된 사용자인가"와
//    "이 스페이스의 멤버인가"는 저장소 조회가 필요해 여기서 못 하고, 각
//    라우트·페이지의 requireSession/멤버십 검사가 최종 판정한다.

function stripForgedSpaceHeader(headers: Headers): Headers {
  const clean = new Headers(headers);
  // 클라이언트가 직접 보낸 SPACE_HEADER는 신뢰하지 않는다. 위조하면 남의
  // 스페이스로 접근하려는 시도다 — 항상 지우고 proxy만 다시 심는다.
  clean.delete(SPACE_HEADER);
  return clean;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const signed = await openSigned(req.cookies.get(COOKIE_NAME)?.value);

  // /<slug>/(files|admin)... 형태면 스페이스 라우팅으로 본다.
  const spaceRoute = matchSpaceRoute(pathname);

  if (spaceRoute) {
    if (!signed) {
      return NextResponse.redirect(new URL("/", req.url));
    }
    // /sea/files/x → /files/x 로 rewrite하고 슬러그를 헤더에 싣는다.
    const url = req.nextUrl.clone();
    url.pathname = spaceRoute.rewritePath;
    const requestHeaders = stripForgedSpaceHeader(req.headers);
    requestHeaders.set(SPACE_HEADER, spaceRoute.slug);
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  // 스페이스 API 호출: /api/... 는 스페이스 세그먼트를 URL에 붙이지 않고,
  // 클라이언트가 헤더로 어느 스페이스를 보는지 알린다. 슬러그는 비밀이 아니라
  // URL에 그대로 드러나므로 여기서는 형태만 검증해 정규화하고, "그 사용자가
  // 그 스페이스의 멤버인가"는 서버의 멤버십 검사가 최종 판정한다. 위조해도
  // 멤버가 아니면 거기서 막힌다.
  if (pathname.startsWith("/api/")) {
    if (!signed) {
      return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
    }
    const claimed = req.headers.get(SPACE_HEADER);
    const requestHeaders = stripForgedSpaceHeader(req.headers);
    const parsed = claimed ? parseSpaceSlug(claimed) : null;
    if (parsed) requestHeaders.set(SPACE_HEADER, parsed);
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // 그 밖의 보호 경로(/files, /admin 직접 접근 등).
  if (!signed) {
    return NextResponse.redirect(new URL("/", req.url));
  }
  return NextResponse.next({
    request: { headers: stripForgedSpaceHeader(req.headers) },
  });
}

export const config = {
  matcher: [
    "/files/:path*",
    "/admin/:path*",
    "/api/drive/:path*",
    "/api/admin/:path*",
    // 스페이스 경로도 잡는다.
    "/:slug/files/:path*",
    "/:slug/admin/:path*",
  ],
};
