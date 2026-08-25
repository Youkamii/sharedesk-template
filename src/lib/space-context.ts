import {
  resolveSession,
  type SessionInfo,
} from "@/lib/auth";
import {
  runWithSpace,
  type SpaceContext,
} from "@/lib/space-store";
import { type Space } from "@/lib/spaces";
import { resolveUserRole } from "@/lib/roles";
import { findUserById } from "@/lib/users";

// 스페이스 멤버십 판정. 요청 헤더를 읽어 문맥을 세우는 쪽은 api.ts의 러너
// (runWithSession 계열)다 — 러너가 스페이스를 해석해 이 판정을 부른 뒤, 요청
// 핸들러 본문 전체를 runWithSpace로 감싼다. 여기는 next/headers를 모르는
// 순수 판정 계층이라 테스트가 실제 함수를 그대로 돌릴 수 있다.
//
// 어댑터가 읽는 currentSpaceFolderId/currentSpaceSlug는 space-store에서 직접
// import한다 — 여기서 재수출하지 않는다(재설계 후 재수출 소비자가 사라졌다).

export { runWithSpace };

/** 등록부의 스페이스를 저장고 문맥으로 바꾼다. null이면 기본 데스크. */
export function toSpaceContext(
  space: Pick<Space, "slug" | "folderId"> | null,
): SpaceContext | null {
  return space ? { slug: space.slug, folderId: space.folderId } : null;
}

export type SpaceSessionResult =
  | { kind: "ok"; session: SessionInfo }
  // 인증됐지만 이 스페이스의 멤버가 아니다.
  | { kind: "not-member" }
  // 토큰이 없거나 유효하지 않다.
  | { kind: "unauthenticated" };

/**
 * 주어진 스페이스 기준으로 세션을 판정한다. 주변(ALS) 문맥을 일절 읽지 않고
 * 필요한 저장소 접근마다 문맥을 명시한다 — 호출 시점의 문맥이 무엇이든 같은
 * 답이 나온다.
 *
 * 정체와 세션 유효성(서명·승인·철회·sessionVersion)은 **기본 데스크가 단일
 * 진실 원천**이다 — 가입과 세션 발급·철회가 기본 데스크에서 일어나므로,
 * 스페이스 명단의 세션 필드로 검증하면 기본에서 철회한 토큰이 스페이스에서
 * 계속 살거나(보안 갭), 멀쩡한 새 토큰이 옛 스페이스 레코드와 어긋나 거부된다
 * (기능 갭). 스페이스 명단에서는 **멤버십과 역할만** 읽는다.
 *
 * - 기본 데스크(space가 null): 기존 resolveSession 그대로.
 * - 스페이스: 기본에서 정체 확인 → 관리자는 통과, 일반 사용자는 그 스페이스
 *   명단에 approved로 있어야 하고 역할은 그 명단의 것을 쓴다.
 */
export async function resolveSpaceSession(
  token: string | undefined,
  space: Pick<Space, "slug" | "folderId"> | null,
  options?: { fresh?: boolean },
): Promise<SpaceSessionResult> {
  // 정체·세션 유효성은 언제나 기본 데스크에서 판정한다.
  const base = await runWithSpace(null, () => resolveSession(token, options));
  if (!base) return { kind: "unauthenticated" };
  if (!space) return { kind: "ok", session: base };

  // ADMIN_EMAILS 관리자는 어느 스페이스에도 들어간다.
  if (base.isAdmin) return { kind: "ok", session: base };

  // 손님(접속 키)은 기본 데스크 전용이다 — 스페이스 명단에 존재할 수 없다.
  if (base.isGuest) return { kind: "not-member" };

  // 일반 사용자: 이 스페이스 명단에 approved로 있어야 한다. 역할은 이 명단의
  // 것 — 같은 사람이 스페이스마다 다른 역할을 가질 수 있다.
  const member = await runWithSpace(toSpaceContext(space), () =>
    findUserById(base.userId, { fresh: options?.fresh }),
  );
  if (!member || member.status !== "approved") return { kind: "not-member" };
  return {
    kind: "ok",
    session: { ...base, role: resolveUserRole(member.role) },
  };
}
