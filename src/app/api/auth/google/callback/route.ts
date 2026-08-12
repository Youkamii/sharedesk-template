import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { COOKIE_NAME, MAX_AGE_SECONDS, createUserSession } from "@/lib/auth";
import { loginWithGoogle } from "@/lib/users";
import { STATE_COOKIE, loginRedirectUri } from "../route";

const OAUTH_TIMEOUT_MS = 10_000;

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

  let tokenRes: Response;
  try {
    tokenRes = await fetch("https://oauth2.googleapis.com/token", {
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
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
  } catch {
    return fail(req, "token");
  }
  if (!tokenRes.ok) return fail(req, "token");
  let accessToken: string;
  try {
    const token = (await tokenRes.json()) as { access_token?: unknown } | null;
    if (!token || typeof token.access_token !== "string" || !token.access_token) {
      return fail(req, "token");
    }
    accessToken = token.access_token;
  } catch {
    return fail(req, "token");
  }

  let infoRes: Response;
  try {
    infoRes = await fetch(
      "https://openidconnect.googleapis.com/v1/userinfo",
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      },
    );
  } catch {
    return fail(req, "userinfo");
  }
  if (!infoRes.ok) return fail(req, "userinfo");
  let info: {
    sub?: unknown;
    email?: unknown;
    email_verified?: unknown;
    name?: unknown;
  };
  try {
    const value = (await infoRes.json()) as typeof info | null;
    if (!value || typeof value !== "object") return fail(req, "userinfo");
    info = value;
  } catch {
    return fail(req, "userinfo");
  }
  // 미인증 이메일을 그대로 받으면 남의 주소를 사칭한 계정이 관리자 이메일과
  // 일치해버릴 수 있다. 필드가 없는 응답도 통과시키지 않는다.
  if (
    typeof info.sub !== "string" ||
    !info.sub ||
    typeof info.email !== "string" ||
    !info.email ||
    info.email_verified !== true
  ) {
    return fail(req, "profile");
  }

  let login: Awaited<ReturnType<typeof loginWithGoogle>>;
  let sessionSigningFailed = false;
  try {
    login = await loginWithGoogle(
      {
        id: info.sub,
        email: info.email,
        name: typeof info.name === "string" ? info.name : "",
      },
      {
        userAgent: req.headers.get("user-agent"),
        issueSessionToken: async (userId, sessionVersion, sessionId) => {
          try {
            return await createUserSession(userId, sessionVersion, sessionId);
          } catch (error) {
            sessionSigningFailed = true;
            throw error;
          }
        },
      },
    );
  } catch {
    return fail(req, sessionSigningFailed ? "session" : "login");
  }
  if (!login.ok) return fail(req, login.reason);
  if (!login.sessionToken) return fail(req, "session");

  if (login.user.status === "blocked") return fail(req, "blocked");
  const destination = login.user.status === "approved" ? "/files" : "/join";

  const res = NextResponse.redirect(new URL(destination, req.url));
  res.cookies.set(STATE_COOKIE, "", { path: "/", maxAge: 0 });
  res.cookies.set(COOKIE_NAME, login.sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return res;
}
