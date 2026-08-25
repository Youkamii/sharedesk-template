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
  // 관리 화면은 관리자만 — 스페이스 멤버라도 관리자 아니면 그 데스크 화면으로.
  if (result.kind === "not-member") redirect("/files");
  if (!result.session.isAdmin) {
    redirect(space ? `/${space.slug}/files` : "/files");
  }
  return <AdminView locale={locale} />;
}
