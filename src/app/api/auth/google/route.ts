import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash } from "node:crypto";
import { resolvePublicOrigin } from "@/lib/public-origin";

// 구글 로그인 시작 — 동의 화면으로 보낸다.
// state와 PKCE 검증값은 짧은 수명의 httpOnly 쿠키에 담아 콜백에서 대조한다.

export const STATE_COOKIE = "sharedesk_oauth";
export const LOGIN_OAUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];

export function loginRedirectUri(req: NextRequest): string {
  return `${resolvePublicOrigin(req.nextUrl.origin)}/api/auth/google/callback`;
}

export async function GET(req: NextRequest) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "구글 로그인이 설정되지 않았습니다 — npm run setup을 실행하세요" },
      { status: 503 },
    );
  }
  const state = randomBytes(16).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: loginRedirectUri(req),
      response_type: "code",
      scope: LOGIN_OAUTH_SCOPES.join(" "),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
    });

  const res = NextResponse.redirect(authUrl);
  res.cookies.set(STATE_COOKIE, `${state}.${verifier}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return res;
}
