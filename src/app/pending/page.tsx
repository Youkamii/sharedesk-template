import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, resolveIdentity } from "@/lib/auth";
import { LOCALE_COOKIE, resolveEffectiveLocale, translate } from "@/lib/i18n";
import { getDeskSettingsOrDefault } from "@/lib/users";
import { isWidgetCookieStore } from "@/lib/widget-mode";
import auth from "../auth.module.css";
import LogoutButton from "../LogoutButton";
import WidgetFrame from "../widget/WidgetFrame";

export default async function PendingPage() {
  const cookieStore = await cookies();
  const me = await resolveIdentity(cookieStore.get(COOKIE_NAME)?.value);
  if (!me) redirect("/");
  // 승인된 사람의 목적지는 로그인과 같은 데스크 선택(#14) — join과 동일.
  if (me.status === "approved") redirect("/spaces");
  if (me.status === "pending") redirect("/join");

  const locale = resolveEffectiveLocale(
    await getDeskSettingsOrDefault(),
    cookieStore.get(LOCALE_COOKIE)?.value,
  );
  const t = (text: string, vars?: Record<string, string | number>) =>
    translate(locale, text, vars);

  if (isWidgetCookieStore(cookieStore)) {
    return (
      <WidgetFrame>
        <div className={auth.authCard}>
          <h1>{t("접근이 막혀 있습니다")}</h1>
          <p>{t("관리자가 이 계정의 접근을 막았습니다.")}</p>
          <div>
            <strong>{me.name}</strong>
            <small>{me.email}</small>
          </div>
          <div className={auth.authFoot}>
            <LogoutButton locale={locale} className="" />
          </div>
        </div>
      </WidgetFrame>
    );
  }

  // 웹 차단 안내 — 위젯과 같은 도트 카드를 밤 배경 가운데에 크게 놓는다(#6).
  return (
    <main className={auth.screen}>
      <div className={`${auth.authCard} ${auth.page}`}>
        <h1>{t("접근이 막혀 있습니다")}</h1>
        <p>{t("관리자가 이 계정의 접근을 막았습니다.")}</p>
        <div>
          <strong>{me.name}</strong>
          <small>{me.email}</small>
        </div>
        <div className={auth.authFoot}>
          <LogoutButton locale={locale} className="" />
        </div>
      </div>
    </main>
  );
}
