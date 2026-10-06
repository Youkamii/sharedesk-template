import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, resolveIdentity } from "@/lib/auth";
import { LOCALE_COOKIE, resolveEffectiveLocale, translate } from "@/lib/i18n";
import { getDeskSettingsOrDefault } from "@/lib/users";
import { isWidgetCookieStore } from "@/lib/widget-mode";
import auth from "../auth.module.css";
import LogoutButton from "../LogoutButton";
import WidgetFrame from "../widget/WidgetFrame";
import JoinCodeForm from "./JoinCodeForm";

const ERRORS: Record<string, string> = {
  invite_invalid: "초대 코드가 올바르지 않거나 새 코드로 교체됐습니다.",
  invite_inactive: "현재 비활성화된 초대입니다. 관리자에게 문의해 주세요.",
  invite_used: "이미 사용 완료된 초대 코드입니다.",
  invite_expired: "사용 기간이 끝난 초대 코드입니다.",
  invite_rate_limited: "입력 횟수가 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
  session: "로그인 정보를 확인하지 못했습니다. 다시 로그인해 주세요.",
};

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; code?: string }>;
}) {
  const cookieStore = await cookies();
  const me = await resolveIdentity(cookieStore.get(COOKIE_NAME)?.value);
  if (!me) redirect("/");
  // 이미 승인된 사람은 로그인과 같은 목적지 — 데스크 선택(#14).
  if (me.status === "approved") redirect("/spaces");
  if (me.status === "blocked") redirect("/pending");

  const locale = resolveEffectiveLocale(
    await getDeskSettingsOrDefault(),
    cookieStore.get(LOCALE_COOKIE)?.value,
  );
  const t = (text: string, vars?: Record<string, string | number>) =>
    translate(locale, text, vars);

  // code는 초대 QR(#15 A-5)이 실어 온다 — 폼에 미리 채워 주기만 하고,
  // 검증은 종전대로 제출 라우트가 한다.
  const { error, code } = await searchParams;

  if (isWidgetCookieStore(cookieStore)) {
    return (
      <WidgetFrame>
        <div className={auth.authCard}>
          <h1>{t("데스크 가입")}</h1>
          <p>{t("관리자에게 받은 초대 코드를 입력하세요. 처음 한 번만 필요합니다.")}</p>
          <div>
            <strong>{me.name}</strong>
            <small>{me.email}</small>
          </div>
          {error && (
            <p className={auth.authError} role="alert">
              {t(ERRORS[error] ?? "초대 코드를 확인하지 못했습니다.")}
            </p>
          )}
          <div className={auth.authForm}>
            <JoinCodeForm locale={locale} />
          </div>
          <div className={auth.authFoot}>
            <small>{t("다른 Google 계정을 쓰려면 먼저 로그아웃하세요.")}</small>
            <LogoutButton locale={locale} className="" />
          </div>
        </div>
      </WidgetFrame>
    );
  }

  // 웹 가입 화면 — 위젯과 같은 도트 카드를 밤 배경 가운데에 크게 놓는다(#6).
  return (
    <main className={auth.screen}>
      <div className={`${auth.authCard} ${auth.page}`}>
        <h1>{t("데스크 가입")}</h1>
        <p>
          {t(
            "관리자에게 받은 기간제 초대 코드를 입력하세요. 1회용은 한 명이 가입하면 끝납니다. 기간 내 무제한은 만료되거나 관리자가 끌 때까지 여러 명이 함께 씁니다.",
          )}
        </p>

        <div>
          <strong>{me.name}</strong>
          <small>{me.email}</small>
        </div>

        {error && (
          <p className={auth.authError} role="alert">
            {t(ERRORS[error] ?? "초대 코드를 확인하지 못했습니다.")}
          </p>
        )}

        <div className={auth.authForm}>
          <JoinCodeForm locale={locale} initialCode={code} />
        </div>

        <div className={auth.authFoot}>
          <small>{t("다른 Google 계정을 쓰려면 먼저 로그아웃하세요.")}</small>
          <LogoutButton locale={locale} className="" />
        </div>
      </div>
    </main>
  );
}
