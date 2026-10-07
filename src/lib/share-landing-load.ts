// 공유·간이 링크 받기 화면(#17 B-3)이 그릴 값을 서버에서 모은다. 링크 라우트와
// 같은 입구(resolveShareLink)·같은 범위 가드(isWithin)를 쓰고, 링크 소비는 기본
// 데스크 전용이라 문맥을 고정한다. 화면(page.tsx)과 테스트가 함께 부른다.

import { sortEntries } from "@/lib/client/mobile-listing";
import { describeShareLanding, type ShareLandingModel } from "@/lib/share-landing";
import { resolveShareLink } from "@/lib/share-links";
import { runWithSpace } from "@/lib/space-context";
import { getAdapter } from "@/lib/storage";
import { findUserById } from "@/lib/users";

// 보낸 사람으로 보여 줄 이름 — 링크를 만든 멤버의 데스크 별명뿐이다. 링크 장부의
// createdBy는 구글 실명(없으면 이메일)이라 외부에 내보내지 않는다. 별명이 없거나
// 명단에 없는 사람(접속 키 손님 등)이면 null — 화면은 보낸 사람 줄을 감춘다.
async function senderNickname(createdByUserId: string): Promise<string | null> {
  if (!createdByUserId) return null;
  const user = await findUserById(createdByUserId).catch(() => null);
  return user?.nickname ?? null;
}

// 링크를 읽은 시각(renderedAt)을 함께 돌려준다 — 남은 시간의 첫 화면은 이 서버
// 시각으로 그리고, 브라우저는 이 값과 자기 시계의 차이를 보정해 1초마다 잰다.
export async function loadShareLanding(
  linkId: string,
  rawEntryId: string | null,
): Promise<{ model: ShareLandingModel; renderedAt: number } | null> {
  const model = await runWithSpace(null, async () => {
    const link = await resolveShareLink(linkId).catch(() => null);
    if (!link) return null;
    try {
      const adapter = getAdapter();
      const sender = await senderNickname(link.createdByUserId);
      if (link.kind === "folder") {
        const targetId = rawEntryId ?? link.fileId;
        if (!(await adapter.isWithin(targetId, link.fileId))) return null;
        const entry = await adapter.getEntry(targetId);
        // 순서는 데스크·모바일 목록과 같은 규칙(폴더 먼저, 이름순).
        const children = entry.isFolder
          ? sortEntries(
              (await adapter.list(entry.id)).map(
                ({ id, name, isFolder, size, mimeType }) => ({
                  id,
                  name,
                  isFolder,
                  size,
                  mimeType,
                }),
              ),
            )
          : null;
        // 링크 루트를 볼 때는 entryId를 싣지 않는다(루트 id 비노출).
        const shownEntryId =
          rawEntryId !== null && rawEntryId !== link.fileId ? rawEntryId : null;
        return describeShareLanding(link, sender, shownEntryId, entry, children);
      }
      // 파일 링크는 항목 지정이 없다(라우트도 entryId를 보지 않는다). 표시
      // 이름은 내려받기와 같이 링크에 적힌 이름이다.
      const entry = await adapter.getEntry(link.fileId);
      return describeShareLanding(
        link,
        sender,
        null,
        { ...entry, name: link.name },
        null,
      );
    } catch {
      return null;
    }
  });
  return model ? { model, renderedAt: Date.now() } : null;
}
