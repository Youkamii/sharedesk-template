import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, SessionInfo, resolveSession } from "@/lib/auth";
import { canEdit, canUpload } from "@/lib/roles";
import {
  establishSpaceContext,
  resolveSpaceSession,
} from "@/lib/space-context";
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
//
// 멀티 데스크(#12): 먼저 요청 헤더에서 스페이스 문맥을 세운다. 이 뒤의 모든
// 저장소 접근이 그 스페이스에 갇히고, 세션 역할도 그 스페이스 기준이 된다.
export async function requireSession(options?: SessionOptions): Promise<
  { session: SessionInfo } | { response: NextResponse }
> {
  const established = await establishSpaceContext();
  if (established === null) {
    // 헤더에 스페이스가 있는데 등록부에 없다. 존재를 덜 드러내려 404.
    return {
      response: NextResponse.json(
        { error: "스페이스를 찾을 수 없습니다" },
        { status: 404 },
      ),
    };
  }

  const result = await resolveSpaceSession(options);
  if (result.kind === "ok") return { session: result.session };
  if (result.kind === "not-member") {
    // 인증은 됐지만 이 스페이스의 멤버가 아니다. 스페이스 존재를 덜 드러내려
    // 미인증과 같은 401로 응답한다.
    return {
      response: NextResponse.json(
        { error: "이 스페이스에 접근할 수 없습니다" },
        { status: 403 },
      ),
    };
  }
  return {
    response: NextResponse.json(
      { error: "인증이 필요합니다" },
      { status: 401 },
    ),
  };
}

function forbiddenResponse(): { response: NextResponse } {
  return {
    response: NextResponse.json(
      { error: "이 작업을 할 권한이 없습니다" },
      { status: 403 },
    ),
  };
}

// 새 항목을 만드는 쓰기(업로드·새 폴더·바탕 배치 저장)의 가드.
// admin·editor·uploader만 통과한다.
export async function requireUploadRights(options?: SessionOptions): Promise<
  { session: SessionInfo } | { response: NextResponse }
> {
  const result = await requireSession(options);
  if ("response" in result) return result;
  if (!canUpload(result.session.role)) return forbiddenResponse();
  return result;
}

// 기존 항목을 바꾸는 쓰기(편집·이름 변경·이동·삭제·휴지통 조작)의 가드.
// admin·editor만 통과한다.
export async function requireEditRights(options?: SessionOptions): Promise<
  { session: SessionInfo } | { response: NextResponse }
> {
  const result = await requireSession(options);
  if ("response" in result) return result;
  if (!canEdit(result.session.role)) return forbiddenResponse();
  return result;
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
