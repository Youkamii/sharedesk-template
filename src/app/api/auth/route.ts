import { NextResponse } from "next/server";
import {
  COOKIE_NAME,
  MAX_AGE_SECONDS,
  createSessionToken,
  findKeyIndex,
} from "@/lib/auth";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}) as { key?: unknown });
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const idx = key ? await findKeyIndex(key) : -1;
  if (idx < 0) {
    return NextResponse.json(
      { ok: false, error: "키가 올바르지 않습니다" },
      { status: 401 },
    );
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE_NAME, await createSessionToken(idx), {
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
