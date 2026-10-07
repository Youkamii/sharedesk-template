import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { sortEntries } from "@/lib/client/mobile-listing";
import { LOCALE_COOKIE, resolveEffectiveLocale } from "@/lib/i18n";
import { describeShareLanding, type ShareLandingModel } from "@/lib/share-landing";
import { resolveShareLink } from "@/lib/share-links";
import { runWithSpace } from "@/lib/space-context";
import { getAdapter } from "@/lib/storage";
import { getDeskSettingsOrDefault } from "@/lib/users";
import ShareLandingView from "./ShareLandingView";

// 공유·간이 링크 받기 화면(#17 B-3). 링크 주소(/api/share/<linkId>)를
// 브라우저로 열면 라우트가 여기로 보낸다. proxy matcher 밖이라 무서명으로
// 열리고, 판정은 링크 라우트와 같은 입구(resolveShareLink)·같은 범위 가드
// (isWithin)를 쓴다. 링크 소비는 기본 데스크 전용 — 문맥을 고정한다.
export const dynamic = "force-dynamic";

// 링크를 읽은 시각(renderedAt)을 함께 돌려준다 — 남은 시간의 첫 화면은 이
// 서버 시각으로 그리고, 브라우저가 같은 값으로 이어받아(hydration 일치) 1초마다
// 자기 시계로 갱신한다.
async function loadModel(
  linkId: string,
  rawEntryId: string | null,
): Promise<{ model: ShareLandingModel; renderedAt: number } | null> {
  const model = await runWithSpace(null, async () => {
    const link = await resolveShareLink(linkId).catch(() => null);
    if (!link) return null;
    try {
      const adapter = getAdapter();
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
        return describeShareLanding(link, shownEntryId, entry, children);
      }
      // 파일 링크는 항목 지정이 없다(라우트도 entryId를 보지 않는다). 표시
      // 이름은 내려받기와 같이 링크에 적힌 이름이다.
      const entry = await adapter.getEntry(link.fileId);
      return describeShareLanding(link, null, { ...entry, name: link.name }, null);
    } catch {
      return null;
    }
  });
  return model ? { model, renderedAt: Date.now() } : null;
}

export default async function ShareLandingPage({
  params,
  searchParams,
}: {
  params: Promise<{ linkId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const [{ linkId }, query, cookieStore] = await Promise.all([
    params,
    searchParams,
    cookies(),
  ]);
  const rawEntryId = typeof query.entryId === "string" ? query.entryId : null;
  const loaded = await loadModel(linkId, rawEntryId);
  if (!loaded) notFound();

  const locale = resolveEffectiveLocale(
    await getDeskSettingsOrDefault(),
    cookieStore.get(LOCALE_COOKIE)?.value,
  );
  return (
    <ShareLandingView
      model={loaded.model}
      locale={locale}
      renderedAt={loaded.renderedAt}
    />
  );
}
