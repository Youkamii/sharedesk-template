import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { LOCALE_COOKIE, resolveEffectiveLocale } from "@/lib/i18n";
import { loadShareLanding } from "@/lib/share-landing-load";
import { getDeskSettingsOrDefault } from "@/lib/users";
import ShareLandingView from "./ShareLandingView";

// 공유·간이 링크 받기 화면(#17 B-3). 링크 주소(/api/share/<linkId>)를
// 브라우저로 열면 라우트가 여기로 보낸다. proxy matcher 밖이라 무서명으로
// 열리고, 판정은 링크 라우트와 같은 입구·같은 범위 가드를 쓴다
// (lib/share-landing-load.ts). 다른 사이트의 틀(iframe) 안에서는 열리지 않는다
// (next.config.ts의 frame-ancestors 'none').
export const dynamic = "force-dynamic";

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
  const loaded = await loadShareLanding(linkId, rawEntryId);
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
