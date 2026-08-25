import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import { COOKIE_NAME, type SessionInfo } from "@/lib/auth";
import { canEdit, canUpload } from "@/lib/roles";
import {
  resolveSpaceSession,
  runWithSpace,
  toSpaceContext,
} from "@/lib/space-context";
import { SPACE_HEADER } from "@/lib/space-slug";
import { getSpace, type Space } from "@/lib/spaces";
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

// 멀티 데스크(#12)의 요청 러너. 라우트 핸들러는 본문 전체를 이 러너들에 넘긴다:
//
//   export async function GET(req: NextRequest) {
//     return runWithSession(null, async ({ session }) => { ... });
//   }
//
// 러너가 요청 헤더에서 스페이스를 해석하고 그 스페이스 기준으로 세션을 판정한
// 뒤, 본문을 runWithSpace로 감싸 돌린다 — 본문 안의 모든 저장소 접근이 그
// 스페이스에 갇히고, run()이 끝나면 문맥이 복원되므로 요청 사이에 새지 않는다.
// (전에 쓰던 enterWith는 되돌림 지점이 없어 Next의 요청 처리에서 문맥이 다음
// 요청에 남거나 await 뒤에 사라질 수 있었다.)
//
// 인증이 없는 공개 라우트(auth·share·invitations/code·update-policy)는 러너
// 대신 runWithSpace(null, ...)로 본문을 감싸 기본 데스크 문맥을 명시한다.
//
// 세션 판정은 proxy가 이미 서명을 걸렀어도 최종적으로 여기서 한다 — 승인
// 취소·차단 반영은 명단 조회가 필요하고, matcher 오타나 파일 규약 변경으로
// proxy가 통째로 빠져도 이 검사가 남는다.

type SessionOptions = { fresh?: boolean } | null;

type GuardedContext = { session: SessionInfo; space: Space | null };

/**
 * 요청 헤더의 스페이스 슬러그를 등록부와 대조한다.
 *
 * - 헤더가 없으면 기본 데스크.
 * - 헤더가 있는데 등록부에 없으면 404 응답 — 조용히 기본 데스크로 흘리면
 *   A 스페이스에 올린 줄 알았던 파일이 기본 데스크에 쌓인다.
 */
async function resolveRequestSpace(): Promise<
  { space: Space | null } | { response: NextResponse }
> {
  const raw = (await headers()).get(SPACE_HEADER);
  if (!raw) return { space: null };
  // 등록부(spaces.json)는 설치 루트에만 있다 — 조회는 기본 문맥에서.
  const space = await runWithSpace(null, () => getSpace(raw));
  if (!space) {
    // 존재를 덜 드러내려 404.
    return {
      response: NextResponse.json(
        { error: "스페이스를 찾을 수 없습니다" },
        { status: 404 },
      ),
    };
  }
  return { space };
}

async function runGuarded(
  options: SessionOptions,
  gate: ((session: SessionInfo) => NextResponse | null) | null,
  body: (ctx: GuardedContext) => Response | Promise<Response>,
): Promise<Response> {
  const resolved = await resolveRequestSpace();
  if ("response" in resolved) return resolved.response;

  const token = (await cookies()).get(COOKIE_NAME)?.value;
  const result = await resolveSpaceSession(
    token,
    resolved.space,
    options ?? undefined,
  );
  if (result.kind === "unauthenticated") {
    return NextResponse.json({ error: "인증이 필요합니다" }, { status: 401 });
  }
  if (result.kind === "not-member") {
    // 인증은 됐지만 이 스페이스의 멤버가 아니다.
    return NextResponse.json(
      { error: "이 스페이스에 접근할 수 없습니다" },
      { status: 403 },
    );
  }
  if (gate) {
    const rejected = gate(result.session);
    if (rejected) return rejected;
  }
  return runWithSpace(toSpaceContext(resolved.space), () =>
    body({ session: result.session, space: resolved.space }),
  );
}

function forbiddenResponse(): NextResponse {
  return NextResponse.json(
    { error: "이 작업을 할 권한이 없습니다" },
    { status: 403 },
  );
}

/** 로그인한 사용자(이 스페이스의 멤버)의 요청 본문을 스페이스 문맥에서 돌린다. */
export async function runWithSession(
  options: SessionOptions,
  body: (ctx: GuardedContext) => Response | Promise<Response>,
): Promise<Response> {
  return runGuarded(options, null, body);
}

// 새 항목을 만드는 쓰기(업로드·새 폴더·바탕 배치 저장)의 가드.
// admin·editor·uploader만 통과한다.
export async function runWithUploadRights(
  options: SessionOptions,
  body: (ctx: GuardedContext) => Response | Promise<Response>,
): Promise<Response> {
  return runGuarded(
    options,
    (session) => (canUpload(session.role) ? null : forbiddenResponse()),
    body,
  );
}

// 기존 항목을 바꾸는 쓰기(편집·이름 변경·이동·삭제·휴지통 조작)의 가드.
// admin·editor만 통과한다.
export async function runWithEditRights(
  options: SessionOptions,
  body: (ctx: GuardedContext) => Response | Promise<Response>,
): Promise<Response> {
  return runGuarded(
    options,
    (session) => (canEdit(session.role) ? null : forbiddenResponse()),
    body,
  );
}

export async function runWithAdmin(
  options: SessionOptions,
  body: (ctx: GuardedContext) => Response | Promise<Response>,
): Promise<Response> {
  return runGuarded(
    options,
    (session) =>
      session.isAdmin
        ? null
        : NextResponse.json(
            { error: "관리자만 사용할 수 있습니다" },
            { status: 403 },
          ),
    body,
  );
}
