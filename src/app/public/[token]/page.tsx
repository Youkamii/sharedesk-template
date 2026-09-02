import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { COOKIE_NAME, resolveSession } from "@/lib/auth";
import { LOCALE_COOKIE, resolveEffectiveLocale } from "@/lib/i18n";
import {
  getPublicFolder,
  publicFolderAccess,
  resolvePublicFolderTarget,
} from "@/lib/public-folders";
import { runWithSpace } from "@/lib/space-context";
import { getDeskSettingsOrDefault } from "@/lib/users";
import PublicFolderView from "./PublicFolderView";

// 공개 폴더 화면(#10). proxy matcher 밖이라 무서명으로 열리고, 접근 판정은
// 여기(페이지)와 공개 API 양쪽이 한다. 공개 폴더는 기본 데스크 전용 —
// 모든 판정·조회를 기본 문맥으로 고정한다.
export default async function PublicFolderPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(COOKIE_NAME)?.value;

  const resolved = await runWithSpace(null, async () => {
    const folder = await getPublicFolder(token);
    if (!folder) return null;
    // 페이지는 폴링이 아니라 1회 렌더라, 나가기 버튼 판정을 겸해 세션을
    // 항상 해석한다. "데스크 사용자"(손님 포함)면 나가기가 보인다 —
    // 제한 공개(minRole)의 명단 멤버 판정과는 별개 술어다.
    const session = await resolveSession(sessionToken);
    if (publicFolderAccess(folder, session) !== "open") return null;
    // 대상 폴더 실체 확인(경로 재사용·대소문자 변형 방어) — 공개 API와
    // 같은 공통 판정.
    if (!(await resolvePublicFolderTarget(folder))) return null;
    const settings = await getDeskSettingsOrDefault();
    return {
      folder,
      isDeskUser: session !== null,
      // 관리자는 이 화면에서 아이콘을 끌어 방문자가 보는 배치를 바꾼다.
      isAdmin: session?.isAdmin === true,
      settings,
    };
  });
  if (!resolved) notFound();

  const locale = resolveEffectiveLocale(
    resolved.settings,
    cookieStore.get(LOCALE_COOKIE)?.value,
  );
  return (
    <PublicFolderView
      token={token}
      name={resolved.folder.name}
      isDeskUser={resolved.isDeskUser}
      isAdmin={resolved.isAdmin}
      locale={locale}
    />
  );
}
