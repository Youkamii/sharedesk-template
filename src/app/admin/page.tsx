import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { COOKIE_NAME, resolveIdentity } from "@/lib/auth";
import { LOCALE_COOKIE, resolveEffectiveLocale } from "@/lib/i18n";
import { resolveSpaceSession, runWithSpace } from "@/lib/space-context";
import { SPACE_HEADER } from "@/lib/space-slug";
import { getSpace } from "@/lib/spaces";
import { getDeskSettingsOrDefault } from "@/lib/users";
import AdminView from "./AdminView";

export default async function AdminPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;

  // 스페이스 관리 화면(/sea/admin)이면 proxy가 심은 헤더로 스페이스를 안다(#12).
  const claimed = (await headers()).get(SPACE_HEADER);
  const space = claimed
    ? await runWithSpace(null, () => getSpace(claimed))
    : null;
  if (claimed && !space) notFound();

  const locale = resolveEffectiveLocale(
    await runWithSpace(null, () => getDeskSettingsOrDefault()),
    cookieStore.get(LOCALE_COOKIE)?.value,
  );
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
  if (result.kind === "not-member") redirect("/files");
  // 스페이스에는 관리 화면이 없다(#12). 관리는 멀티데스크 관리 창(/spaces)에서
  // 하고, 스페이스별 사용자 명단·역할은 거기 멤버 패널에서 다룬다. 기존
  // AdminView의 초대·세션 철회·데스크 설정은 기본 데스크가 진실 원천이라
  // 스페이스 문맥에서 열면 저장은 되지만 소비되지 않아(무음 오작동) 관리자를
  // 오도한다 — 아예 스페이스 파일 화면으로 돌려보낸다.
  if (space) redirect(`/${space.slug}/files`);
  // 관리 화면은 관리자만 — 일반 멤버는 자기 데스크 화면으로.
  if (!result.session.isAdmin) redirect("/files");
  return <AdminView locale={locale} />;
}
