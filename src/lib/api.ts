import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, SessionInfo, resolveSession } from "@/lib/auth";
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

type SessionOptions = { fresh?: boolean };

export async function getSession(
  options?: SessionOptions,
): Promise<SessionInfo | null> {
  return resolveSession(
    (await cookies()).get(COOKIE_NAME)?.value,
    options,
  );
}

// 최종 판정. proxy가 이미 서명을 걸렀지만, 승인 취소·차단 반영은 여기서만 일어난다.
// matcher 오타나 파일 규약 변경으로 proxy가 통째로 빠져도 이 검사가 남는다.
export async function requireSession(options?: SessionOptions): Promise<
  { session: SessionInfo } | { response: NextResponse }
> {
  const session = await getSession(options);
  if (!session) {
    return {
      response: NextResponse.json(
        { error: "인증이 필요합니다" },
        { status: 401 },
      ),
    };
  }
  return { session };
}

export async function requireAdmin(options?: SessionOptions): Promise<
  { session: SessionInfo } | { response: NextResponse }
> {
  const result = await requireSession(options);
  if ("response" in result) return result;
  if (!result.session.isAdmin) {
    return {
      response: NextResponse.json(
        { error: "관리자만 사용할 수 있습니다" },
        { status: 403 },
      ),
    };
  }
  return result;
}
