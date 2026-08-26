import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { COOKIE_NAME, resolveSession } from "@/lib/auth";
import {
  getPublicFolder,
  publicFolderAccess,
  resolvePublicFolderTarget,
  type PublicFolder,
} from "@/lib/public-folders";
import type { Entry } from "@/lib/storage/types";

// 공개 폴더 API 3종(목록·다운로드·업로드)의 공통 판정. 호출자는 본문을
// runWithSpace(null, ...)로 감싼다 — 공개 폴더는 기본 데스크 전용이다.

/** 미존재·닫힘·범위 밖을 전부 같은 404로 접는다(존재 비노출 관례). */
export function missing(): NextResponse {
  return NextResponse.json(
    { error: "공개 폴더가 없거나 닫혀 있습니다" },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * 토큰 → 등록부 → 접근 판정 → 대상 폴더 실체 확인.
 * null이면 호출자는 missing()으로 응답한다.
 *
 * - 세션 해석은 제한 공개(minRole 설정)일 때만 한다 — 완전 공개 폴더의
 *   익명 폴링마다 명단을 조회할 이유가 없다.
 * - 대상 폴더 실체 확인은 resolvePublicFolderTarget이 한다(경로 재사용
 *   탈취·대소문자 변형 방어를 한 곳에 모은 공통 판정).
 */
export async function resolveOpenPublicFolder(
  token: string,
): Promise<{ folder: PublicFolder; target: Entry } | null> {
  const folder = await getPublicFolder(token);
  if (!folder) return null;
  let session = null;
  if (folder.minRole !== null) {
    session = await resolveSession((await cookies()).get(COOKIE_NAME)?.value);
  }
  if (publicFolderAccess(folder, session) !== "open") return null;
  const target = await resolvePublicFolderTarget(folder);
  return target ? { folder, target } : null;
}
