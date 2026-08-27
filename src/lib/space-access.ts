import { runWithSpace, toSpaceContext } from "@/lib/space-context";
import { listSpaces } from "@/lib/spaces";
import { findUserById } from "@/lib/users";

// "이 사람이 들어갈 수 있는 스페이스"의 단일 판정 (#12).
// 스페이스 목록 API·로그인 목적지·/spaces 화면·나가기 버튼이 전부 이 판정을
// 공유한다 — 각자 다시 구현하면 목록과 리다이렉트가 어긋난다.

export interface AccessibleSpace {
  slug: string;
  name: string;
}

export interface SpaceAccessor {
  userId: string;
  isAdmin: boolean;
  isGuest: boolean;
}

/**
 * 들어갈 수 있는 스페이스 목록. 관리자는 전부, 손님(접속 키)은 없음, 일반
 * 사용자는 그 스페이스 명단에 approved로 있는 곳만. 등록부·명단 조회의 문맥은
 * 안에서 명시하므로 어느 문맥에서 불러도 같은 답이 나온다.
 */
export async function listAccessibleSpaces(
  accessor: SpaceAccessor,
  options?: { fresh?: boolean },
): Promise<AccessibleSpace[]> {
  const spaces = await runWithSpace(null, () => listSpaces());
  const accessible: AccessibleSpace[] = [];
  for (const space of spaces) {
    if (accessor.isAdmin) {
      accessible.push({ slug: space.slug, name: space.name });
      continue;
    }
    if (accessor.isGuest) continue;
    const member = await runWithSpace(toSpaceContext(space), () =>
      findUserById(accessor.userId, { fresh: options?.fresh }),
    );
    if (member && member.status === "approved") {
      accessible.push({ slug: space.slug, name: space.name });
    }
  }
  return accessible;
}

/**
 * 로그인·초대 수락·재방문의 목적지 (#14). 스페이스 수와 무관하게 항상
 * 데스크 선택 화면이다 — 스페이스가 없어도 main 카드가 서고, 스페이스
 * 관리도 그 화면이 맡는다. 손님(스페이스 없음)은 호출자가 /files로 보낸다.
 */
export const LANDING_PATH = "/spaces";
