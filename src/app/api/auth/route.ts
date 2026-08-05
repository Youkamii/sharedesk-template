import { NextRequest, NextResponse } from "next/server";
import {
  COOKIE_NAME,
  MAX_AGE_SECONDS,
  createSessionToken,
  matchKey,
} from "@/lib/auth";

// 접속 키가 유일한 인증 요소라 무제한 추측을 막는다. 인스턴스 메모리 기반이라
// 서버리스에서는 인스턴스별로 적용된다 — 완전한 차단이 아니라 속도 제한이 목적.
const MAX_KEY_LENGTH = 256;
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, { count: number; resetAt: number }>();

function tooManyAttempts(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now > entry.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    if (attempts.size > 1000) {
      for (const [k, v] of attempts) if (now > v.resetAt) attempts.delete(k);
    }
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "unknown";
}

export async function POST(req: NextRequest) {
  if (tooManyAttempts(clientIp(req))) {
    return NextResponse.json(
      { ok: false, error: "시도가 너무 많습니다. 잠시 후 다시 시도하세요" },
      { status: 429 },
    );
  }
  const body = await req.json().catch(() => ({}) as { key?: unknown });
  const key =
    typeof body.key === "string" && body.key.length <= MAX_KEY_LENGTH
      ? body.key.trim()
      : "";
  const keyHash = key ? await matchKey(key) : null;
  if (!keyHash) {
    return NextResponse.json(
      { ok: false, error: "키가 올바르지 않습니다" },
      { status: 401 },
    );
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, await createSessionToken(keyHash), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
