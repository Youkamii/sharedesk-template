import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, openSigned } from "@/lib/session-token";
import { SPACE_HEADER } from "@/lib/space-slug";
import { isPublicApiPath, matchSpaceRoute } from "@/lib/space-routing";

// 두 가지 일을 한다.
// 1) 멀티 데스크 라우팅: /sea/files 를 내부 /files 로 rewrite하면서 스페이스
//    슬러그를 SPACE_HEADER에 싣는다. 서버는 그 헤더로 스페이스를 안다.
//    스페이스로 가는 통로는 이 경로 프리픽스 하나뿐이다 — 클라이언트가 직접
//    보낸 SPACE_HEADER는 어떤 경로에서도 지워진다(#12 2번).
// 2) 서명 거름망: 서명 없는·만료된 토큰만 걸러낸다. 공개 API(isPublicApiPath)
//    는 면제다. "승인된 사용자인가"와 "이 스페이스의 멤버인가"는 저장소
//    조회가 필요해 여기서 못 하고, 각 라우트·페이지의 러너(runWithSession
//    계열)·멤버십 검사가 최종 판정한다.

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

  // /<slug>/(files|admin|api)... 형태면 스페이스 라우팅으로 본다.
  const spaceRoute = matchSpaceRoute(pathname);

  if (spaceRoute) {
    if (!signed) {
      // API 호출에는 화면 리다이렉트 대신 JSON을 준다 — fetch가 삼킬 수 있게.
      return spaceRoute.rewritePath.startsWith("/api/")
        ? NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 })
        : NextResponse.redirect(new URL("/", req.url));
    }
    // /sea/files/x → /files/x 로 rewrite하고 슬러그를 헤더에 싣는다.
    const url = req.nextUrl.clone();
    url.pathname = spaceRoute.rewritePath;
    const requestHeaders = stripForgedSpaceHeader(req.headers);
    requestHeaders.set(SPACE_HEADER, spaceRoute.slug);
    return NextResponse.rewrite(url, { request: { headers: requestHeaders } });
  }

  // 기본 데스크 API: 스페이스 헤더는 프리픽스 경로에서만 proxy가 심는다 —
  // 클라이언트가 직접 보낸 값은 재주입 없이 항상 지운다. 예전에는 형태만
  // 검증해 되살렸지만, 프리픽스 통로가 생긴 뒤로는 통로를 하나로 좁히는 쪽이
  // 규약이 명확하다(#12 2번). 남겨 둬도 러너의 멤버십 검사가 막지만, 아예 안
  // 들어오게 한다.
  if (pathname.startsWith("/api/")) {
    const requestHeaders = stripForgedSpaceHeader(req.headers);
    // 공개 API는 세션이 없어도 열린다 — 최종 판정은 각 라우트가 한다.
    if (!isPublicApiPath(pathname) && !signed) {
      return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
    }
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
    "/spaces",
    // API 전체를 잡는다(#12 2번). 위조 스페이스 헤더 제거가 전 라우트에
    // 적용되고, 공개 API(isPublicApiPath)만 서명 사전 검사를 면제받는다.
    "/api/:path*",
    // 스페이스 경로. api 프리픽스는 헤더를 실을 수 없는 호출
    // (iframe·anchor·window.open)까지 스페이스로 보내는 통로다.
    "/:slug/files/:path*",
    "/:slug/admin/:path*",
    "/:slug/api/:path*",
  ],
};
