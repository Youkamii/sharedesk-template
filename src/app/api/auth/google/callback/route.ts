import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { COOKIE_NAME, MAX_AGE_SECONDS, createUserSession } from "@/lib/auth";
import { upsertOnLogin } from "@/lib/users";
import { STATE_COOKIE, loginRedirectUri } from "../route";

function fail(req: NextRequest, reason: string) {
  const url = new URL("/", req.url);
  url.searchParams.set("error", reason);
  const res = NextResponse.redirect(url);
  res.cookies.set(STATE_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

function sameString(a: string, b: string): boolean {
  return (
    a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
  );
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get("error")) return fail(req, "denied");

  const code = params.get("code");
  const state = params.get("state") ?? "";
  const saved = req.cookies.get(STATE_COOKIE)?.value ?? "";
  const dot = saved.indexOf(".");
  if (!code || dot < 0) return fail(req, "invalid");
  const savedState = saved.slice(0, dot);
  const verifier = saved.slice(dot + 1);
  if (!sameString(state, savedState)) return fail(req, "state");

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail(req, "unconfigured");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: loginRedirectUri(req),
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });
  if (!tokenRes.ok) return fail(req, "token");
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) return fail(req, "token");

  const infoRes = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    { headers: { Authorization: `Bearer ${token.access_token}` } },
  );
  if (!infoRes.ok) return fail(req, "userinfo");
  const info = (await infoRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
  };
  // 미인증 이메일을 그대로 받으면 남의 주소를 사칭한 계정이 관리자 이메일과
  // 일치해버릴 수 있다.
  if (!info.sub || !info.email || info.email_verified === false) {
    return fail(req, "profile");
  }

  const user = await upsertOnLogin({
    id: info.sub,
    email: info.email,
    name: info.name ?? "",
  });

  const dest = user.status === "approved" ? "/files" : "/pending";
  const res = NextResponse.redirect(new URL(dest, req.url));
  res.cookies.set(STATE_COOKIE, "", { path: "/", maxAge: 0 });
  // 승인 대기 상태에도 세션은 발급한다 — 대기 화면이 본인을 알아보려면 필요하고,
  // 접근 권한은 resolveSession이 승인 여부로 따로 판정한다.
  res.cookies.set(COOKIE_NAME, await createUserSession(user.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return res;
}
