import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, verifySessionToken } from "@/lib/auth";
import { StorageError, StorageErrorCode } from "@/lib/storage/types";

const STATUS: Record<StorageErrorCode, number> = {
  NOT_FOUND: 404,
  BAD_ID: 400,
  BAD_NAME: 400,
  CONFLICT: 409,
  UPSTREAM: 502,
};

export function errorResponse(e: unknown) {
  if (e instanceof StorageError) {
    return NextResponse.json(
      { error: e.message, code: e.code },
      { status: STATUS[e.code] },
    );
  }
  console.error("[api]", e);
  return NextResponse.json({ error: "서버 오류가 발생했습니다" }, { status: 500 });
}

// 심층 방어: proxy가 이미 걸러주지만, matcher 오타나 파일 규약 변경 한 번이면
// 방어선이 통째로 사라진다. 각 핸들러가 자기 힘으로도 세션을 확인한다.
export async function requireSession(): Promise<NextResponse | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  if (await verifySessionToken(token)) return null;
  return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
}
