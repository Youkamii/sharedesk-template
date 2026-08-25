import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, resolveIdentity } from "@/lib/auth";
import { LOCALE_COOKIE, resolveEffectiveLocale } from "@/lib/i18n";
import { listAccessibleSpaces } from "@/lib/space-access";
import { resolveSpaceSession, runWithSpace } from "@/lib/space-context";
import { getDeskSettingsOrDefault } from "@/lib/users";
import SpacesView from "./SpacesView";

// 데스크 목록(#12). 로그인 직후 갈 곳이 둘 이상인 사람이 처음 보는 화면이고,
// 데스크 안의 "나가기" 버튼도 여기로 돌아온다.
export default async function SpacesPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;

  const result = await resolveSpaceSession(token, null, { fresh: true });
  if (result.kind !== "ok") {
    const identity = await runWithSpace(null, () => resolveIdentity(token));
    redirect(
      identity?.status === "pending"
        ? "/join"
        : identity?.status === "blocked"
          ? "/pending"
          : "/",
    );
  }
  const session = result.session;
  // 손님(접속 키)은 스페이스가 없다 — 목록이 무의미하니 기본 데스크로.
  if (session.isGuest) redirect("/files");

  const spaces = await listAccessibleSpaces(session, { fresh: true });
  const locale = resolveEffectiveLocale(
    await runWithSpace(null, () => getDeskSettingsOrDefault()),
    cookieStore.get(LOCALE_COOKIE)?.value,
  );
  return (
    <SpacesView
      locale={locale}
      spaces={spaces}
      canManage={session.isAdmin}
      userName={session.name}
    />
  );
}
