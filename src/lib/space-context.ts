import { headers } from "next/headers";
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
