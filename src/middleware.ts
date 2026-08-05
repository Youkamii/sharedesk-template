import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  const token = req.cookies.get(COOKIE_NAME)?.value;
  if (await verifySessionToken(token)) {
    return NextResponse.next();
  }
  if (req.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }
  return NextResponse.redirect(new URL("/", req.url));
}

export const config = {
  matcher: ["/files/:path*", "/api/drive/:path*"],
};
