import { cookies, headers } from "next/headers";
import {
  COOKIE_NAME,
  resolveSession,
  type SessionInfo,
} from "@/lib/auth";
import { SPACE_HEADER } from "@/lib/space-slug";
import {
  currentSpaceFolderId,
  currentSpaceSlug,
  DEFAULT_SPACE_CONTEXT,
  enterSpace,
  runWithSpace,
} from "@/lib/space-store";
import { getSpace, type Space } from "@/lib/spaces";

// 요청이 어느 스페이스를 보고 있는지 세우는 쪽. proxy가 /sea/files 를 내부
// 경로로 rewrite하면서 SPACE_HEADER에 슬러그를 싣고, 서버는 여기서 그 값을
// 읽어 등록부와 대조한 뒤 문맥을 얹는다. 어댑터의 루트 해석이 문맥을 우선
// 읽으므로 getAdapter()를 부르는 모든 코드가 손대지 않고 스페이스별로 갈라진다.

export { currentSpaceFolderId, currentSpaceSlug, runWithSpace };

/**
 * 요청 헤더에서 스페이스를 해석해 현재 비동기 흐름에 문맥을 얹는다.
 * 라우트·페이지의 첫 지점(requireSession 계열)에서 부른다.
 *
 * - 헤더가 없으면 기본 스페이스 — 성공.
 * - 헤더가 있는데 등록부에 없으면 null. 호출자는 404로 응답해야 한다 —
 *   조용히 기본 스페이스로 흘리면 A 스페이스에 올린 줄 알았던 파일이
 *   기본 데스크에 쌓인다.
 */
export async function establishSpaceContext(): Promise<
  { space: Space | null } | null
> {
  const requestHeaders = await headers();
  const raw = requestHeaders.get(SPACE_HEADER);
  // 등록부 조회는 기본 문맥에서 해야 한다 — spaces.json은 설치 루트에만 있다.
  enterSpace(DEFAULT_SPACE_CONTEXT);
  if (!raw) return { space: null };
  const space = await getSpace(raw);
  if (!space) return null;
  enterSpace({ slug: space.slug, folderId: space.folderId });
  return { space };
}

export type SpaceSessionResult =
  | { kind: "ok"; session: SessionInfo }
  // 인증됐지만 이 스페이스의 멤버가 아니다.
  | { kind: "not-member" }
  // 토큰이 없거나 유효하지 않다.
  | { kind: "unauthenticated" };

/**
 * 현재 스페이스 문맥에서 세션을 판정한다. establishSpaceContext가 문맥을 얹은
 * 뒤에 부른다.
 *
 * - 기본 데스크(스페이스 문맥 없음): 기존 resolveSession 그대로.
 * - 스페이스 문맥:
 *   1) 그 스페이스 users.json에 사용자가 있으면(초대받은 멤버) 그 스페이스의
 *      역할로 세션을 만든다.
 *   2) 없으면 기본 데스크에서 정체를 확인한다 — ADMIN_EMAILS 관리자는 어느
 *      스페이스에도 들어갈 수 있으므로 통과시키고, 그 밖에는 비멤버로 막는다.
 *
 * claims에 email이 없어 스페이스에서 사용자를 못 찾으면 관리자 여부를 알 수
 * 없다. 그래서 기본 데스크에서 한 번 더 조회한다.
 */
export async function resolveSpaceSession(
  options?: { fresh?: boolean },
): Promise<SpaceSessionResult> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  const slug = currentSpaceSlug();

  // 현재 문맥(스페이스면 그 스페이스, 아니면 기본)에서 먼저 시도.
  const scoped = await resolveSession(token, options);
  if (scoped) return { kind: "ok", session: scoped };

  // 기본 데스크면 여기서 끝 — 그냥 미인증이거나 승인 안 됨.
  if (!slug) return { kind: "unauthenticated" };

  // 스페이스에서 못 찾았다. 기본 데스크에서 정체를 확인해 관리자면 통과.
  const base = await runWithSpace(null, () => resolveSession(token, options));
  if (base?.isAdmin) return { kind: "ok", session: base };
  if (base) return { kind: "not-member" };
  return { kind: "unauthenticated" };
}
