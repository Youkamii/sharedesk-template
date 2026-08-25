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
import { resolveUserRole } from "@/lib/roles";
import { findUserById } from "@/lib/users";

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
 * 정체와 세션 유효성(서명·승인·철회·sessionVersion)은 **기본 데스크가 단일
 * 진실 원천**이다 — 가입과 세션 발급·철회가 기본 데스크에서 일어나므로,
 * 스페이스 명단의 세션 필드로 검증하면 기본에서 철회한 토큰이 스페이스에서
 * 계속 살거나(보안 갭), 멀쩡한 새 토큰이 옛 스페이스 레코드와 어긋나 거부된다
 * (기능 갭). 스페이스 명단에서는 **멤버십과 역할만** 읽는다.
 *
 * - 기본 데스크(스페이스 문맥 없음): 기존 resolveSession 그대로.
 * - 스페이스 문맥: 기본에서 정체 확인 → 관리자는 통과, 일반 사용자는 그
 *   스페이스 명단에 approved로 있어야 하고 역할은 그 명단의 것을 쓴다.
 */
export async function resolveSpaceSession(
  options?: { fresh?: boolean },
): Promise<SpaceSessionResult> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  const slug = currentSpaceSlug();

  // 정체·세션 유효성은 언제나 기본 데스크에서 판정한다.
  const base = await runWithSpace(null, () => resolveSession(token, options));
  if (!base) return { kind: "unauthenticated" };
  if (!slug) return { kind: "ok", session: base };

  // ADMIN_EMAILS 관리자는 어느 스페이스에도 들어간다.
  if (base.isAdmin) return { kind: "ok", session: base };

  // 손님(접속 키)은 기본 데스크 전용이다 — 스페이스 명단에 존재할 수 없다.
  if (base.isGuest) return { kind: "not-member" };

  // 일반 사용자: 이 스페이스 명단에 approved로 있어야 한다. 역할은 이 명단의
  // 것 — 같은 사람이 스페이스마다 다른 역할을 가질 수 있다.
  const member = await findUserById(base.userId, { fresh: options?.fresh });
  if (!member || member.status !== "approved") return { kind: "not-member" };
  return {
    kind: "ok",
    session: { ...base, role: resolveUserRole(member.role) },
  };
}
