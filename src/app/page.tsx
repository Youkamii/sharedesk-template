import Link from "next/link";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, resolveIdentity, resolveSession } from "@/lib/auth";
import { LOCALE_COOKIE, parseLocale, resolveEffectiveLocale, translate,
  docUrl,
  type Locale,
} from "@/lib/i18n";
import { getDeskSettingsOrDefault } from "@/lib/users";
import { getAccessKeys } from "@/lib/session-token";
import KeyForm from "./KeyForm";
import pixel from "./unconfigured.module.css";


const GOOGLE_LOGIN_ENV = [
  "ADMIN_EMAILS",
  "SESSION_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
  "DRIVE_ROOT_FOLDER_ID",
  "DRIVE_STATE_FOLDER_ID",
] as const;

const ERRORS: Record<string, string> = {
  denied: "구글 로그인이 취소되었습니다.",
  state: "로그인 요청이 유효하지 않습니다. 다시 시도해 주세요.",
  token: "구글 인증에 실패했습니다.",
  userinfo: "계정 정보를 가져오지 못했습니다.",
  profile: "이메일이 확인되지 않은 계정입니다.",
  unconfigured: "구글 로그인이 아직 설정되지 않았습니다.",
  invalid: "로그인 요청이 유효하지 않습니다.",
  invite_required: "처음 이용하려면 Google 로그인 뒤 관리자가 만든 초대 코드를 입력해야 합니다.",
  invite_invalid: "초대 코드가 올바르지 않거나 새 코드로 교체됐습니다.",
  invite_inactive: "현재 비활성화된 초대입니다. 관리자에게 문의해 주세요.",
  invite_used: "이미 사용 완료된 초대 코드입니다.",
  invite_expired: "사용 기간이 끝난 초대 코드입니다.",
  blocked: "차단된 사용자입니다. 관리자에게 문의해 주세요.",
};

// 미설정 데스크는 아직 데스크 언어 설정이 없으므로, 브라우저의
// Accept-Language 헤더에서 지원 언어(en/ko/ja/hi/zh)를 고른다. 매칭 실패 시 en.
function matchAcceptLanguage(header: string | null): Locale {
  const ranges = (header ?? "")
    .split(",")
    .map((part) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params
        .map((param) => param.trim())
        .find((param) => param.startsWith("q="));
      const weight = q ? Number.parseFloat(q.slice(2)) : 1;
      return {
        tag: tag.trim().toLowerCase(),
        weight: Number.isFinite(weight) ? weight : 0,
      };
    })
    .filter((range) => range.tag && range.weight > 0)
    .sort((a, b) => b.weight - a.weight);
  for (const { tag } of ranges) {
    const locale = parseLocale(tag.split("-")[0]);
    if (locale) return locale;
  }
  return "en";
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  const session = await resolveSession(token);
  if (session) redirect("/files");
  const identity = await resolveIdentity(token);
  if (identity?.status === "pending") redirect("/join");
  if (identity?.status === "blocked") redirect("/pending");

  const keyLoginEnabled = getAccessKeys().length > 0;
  const googleLoginEnabled =
    process.env.STORAGE_DRIVER === "drive" &&
    GOOGLE_LOGIN_ENV.every((name) => Boolean(process.env[name]?.trim()));

  // 미설정 첫 화면 — 로그인 수단이 하나도 없으면 설치 안내 픽셀 창만 보여 준다.
  if (!googleLoginEnabled && !keyLoginEnabled) {
    const acceptLanguage = (await headers()).get("accept-language");
    const locale = matchAcceptLanguage(acceptLanguage);
    const t = (text: string) => translate(locale, text);
    // 콜백이 에러와 함께 돌아온 경우(?error=)도 삼키지 않고 보여 준다.
    const { error: errorKey } = await searchParams;
    const unconfiguredError = errorKey ? (ERRORS[errorKey] ?? null) : null;
    return (
      <main className={pixel.screen}>
        <section className={pixel.window} aria-labelledby="unconfigured-title">
          <header className={pixel.titlebar}>
            <span className={pixel.brandMark} aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
            </span>
            <strong id="unconfigured-title">ShareDesk</strong>
            <span className={pixel.stateTag}>{t("설치 준비 중")}</span>
          </header>
          <div className={pixel.body}>
            <p className={pixel.message}>
              {t(
                "이 ShareDesk는 아직 설치가 끝나지 않았습니다. 데스크 소유자는 Google OAuth와 Drive 연결을 마쳐 주세요.",
              )}
            </p>
            <a
              href={docUrl("INSTALL", locale)}
              target="_blank"
              rel="noreferrer"
              className={pixel.installLink}
            >
              {t("설치 안내 열기")}
            </a>
            <p className={pixel.footnote}>
              {t("설치가 끝나면 이 주소가 로그인 화면이 됩니다.")}
            </p>
            {unconfiguredError && (
              <p className={pixel.footnote} role="alert">
                {t(unconfiguredError)}
              </p>
            )}
          </div>
        </section>
      </main>
    );
  }

  const locale = resolveEffectiveLocale(
    await getDeskSettingsOrDefault(),
    cookieStore.get(LOCALE_COOKIE)?.value,
  );
  const createDeskUrl = docUrl("INSTALL", locale);
  const t = (text: string, vars?: Record<string, string | number>) =>
    translate(locale, text, vars);

  const { error } = await searchParams;

  return (
    <main className="relative flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-black/10 p-8 shadow-sm dark:border-white/15">
        <h1 className="text-2xl font-semibold tracking-tight">ShareDesk</h1>
        {googleLoginEnabled ? (
          <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
            {t(
              "호스트의 Google Drive 저장 공간을 여러 사람이 함께 쓰는 ShareDesk입니다. 초대받았다면 별도 설치 없이 내 Google 계정으로 로그인하고, 처음 한 번만 호스트가 준 초대 코드를 입력하세요.",
            )}
          </p>
        ) : (
          <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
            {t("OAuth 없는 로컬 모드입니다. 아래 손님용 키로 시작하세요.")}
          </p>
        )}

        {error && (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
            {t(ERRORS[error] ?? "로그인에 실패했습니다.")}
          </p>
        )}

        {googleLoginEnabled ? (
          <Link
            href="/api/auth/google"
            prefetch={false}
            className="mt-6 flex items-center justify-center gap-2 rounded-lg bg-foreground py-2.5 font-medium text-background"
          >
            {t("Google로 계속하기")}
          </Link>
        ) : null}

        {keyLoginEnabled && (
          <>
            {googleLoginEnabled && (
              <div className="my-6 flex items-center gap-3 text-xs text-zinc-400">
                <span className="h-px flex-1 bg-black/10 dark:bg-white/15" />
                {t("또는 손님용 키")}
                <span className="h-px flex-1 bg-black/10 dark:bg-white/15" />
              </div>
            )}
            <div className={googleLoginEnabled ? "" : "mt-6"}>
              <KeyForm locale={locale} />
            </div>
          </>
        )}

        <section className="mt-6 border-t border-black/10 pt-6 dark:border-white/15">
          <p className="text-sm font-medium">
            {t("내 Drive로 새 공유 공간을 열고 싶나요?")}
          </p>
          <p className="mt-1 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
            {t(
              "내 Google Drive 용량을 여러 사람과 함께 쓸 새 공유 공간을 열 때만 설치하세요. 누군가에게 초대받은 참여자라면 GitHub, Vercel, OAuth 설정 없이 위의 Google 로그인만 하면 됩니다.",
            )}
          </p>
          <a
            href={createDeskUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-4 flex items-center justify-center rounded-lg border border-black/15 py-2.5 font-medium transition-colors hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          >
            {t("호스트 설치 안내")}
          </a>
        </section>
      </div>
    </main>
  );
}
