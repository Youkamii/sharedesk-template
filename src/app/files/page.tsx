import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { COOKIE_NAME, resolveIdentity } from "@/lib/auth";
import { LOCALE_COOKIE, resolveEffectiveLocale } from "@/lib/i18n";
import { resolveSpaceSession, runWithSpace } from "@/lib/space-context";
import { SPACE_HEADER } from "@/lib/space-slug";
import { getSpace } from "@/lib/spaces";
import { findUserById, getDeskSettingsOrDefault } from "@/lib/users";
import { isOwnerRegistryConfigured } from "@/lib/owner-registry";
import FilesView from "./FilesView";

export default async function FilesPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;

  // 스페이스 화면(/sea/files)이면 proxy가 심은 헤더로 어느 스페이스인지 안다(#12).
  const claimed = (await headers()).get(SPACE_HEADER);
  const space = claimed
    ? await runWithSpace(null, () => getSpace(claimed))
    : null;
  if (claimed && !space) notFound();

  // 로케일·데스크 설정은 기본 데스크의 것을 쓴다 — 스페이스에는 아직 설정
  // 화면이 없고, 화면 언어가 스페이스마다 널뛰면 오히려 혼란스럽다.
  const deskSettings = await runWithSpace(null, () =>
    getDeskSettingsOrDefault(),
  );
  const locale = resolveEffectiveLocale(
    deskSettings,
    cookieStore.get(LOCALE_COOKIE)?.value,
  );

  // 세션·멤버십 판정은 API 러너와 같은 함수로 한다. 역할은 스페이스 명단의 것.
  const result = await resolveSpaceSession(token, space, { fresh: true });
  if (result.kind === "unauthenticated") {
    const identity = await runWithSpace(null, () => resolveIdentity(token));
    redirect(
      identity?.status === "pending"
        ? "/join"
        : identity?.status === "blocked"
          ? "/pending"
          : "/",
    );
  }
  // 초대받지 않은 스페이스는 주소를 알아도 거부한다(#12 요구사항) —
  // 로그인은 되어 있으므로 자기(기본) 데스크로 돌려보낸다.
  if (result.kind === "not-member") redirect("/files");
  const session = result.session;
  // 닉네임(#13): 진실 원천은 기본 데스크 명단 — 스페이스 화면에서도 같다.
  const baseUser = session.isGuest
    ? null
    : await runWithSpace(null, () => findUserById(session.userId));
  return (
    <FilesView
      isSpace={space !== null}
      initialNickname={baseUser?.nickname ?? null}
      userName={session.name}
      userEmail={session.email}
      isAdmin={session.isAdmin}
      isGuest={session.isGuest}
      role={session.role}
      canSendFeedback={!session.isGuest && isOwnerRegistryConfigured()}
      locale={locale}
      allowMemberLocale={deskSettings.allowMemberLocale}
      autoUpdate={deskSettings.autoUpdate}
    />
  );
}
