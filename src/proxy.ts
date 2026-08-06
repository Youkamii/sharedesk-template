import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, openSigned } from "@/lib/session-token";

// edge에서 도는 1차 거름망 — 서명 없는/만료된 토큰만 걸러낸다.
// "승인된 사용자인가"는 저장소 조회가 필요해 여기서 판정할 수 없고,
// 각 라우트·페이지의 requireSession이 최종 판정을 맡는다.
export async function proxy(req: NextRequest) {
  if (await openSigned(req.cookies.get(COOKIE_NAME)?.value)) {
    return NextResponse.next();
  }
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/", req.url));
}

export const config = {
  matcher: ["/files/:path*", "/admin/:path*", "/api/drive/:path*", "/api/admin/:path*"],
};
