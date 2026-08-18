import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, resolveIdentity, resolveSession } from "@/lib/auth";
import { LOCALE_COOKIE, resolveEffectiveLocale, translate } from "@/lib/i18n";
import { getDeskSettingsOrDefault } from "@/lib/users";
import { getAccessKeys } from "@/lib/session-token";
import KeyForm from "./KeyForm";

const CREATE_DESK_URL =
  "https://github.com/Youkamii/sharedesk-template/blob/main/docs/INSTALL.md";

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

  const locale = resolveEffectiveLocale(
    await getDeskSettingsOrDefault(),
    cookieStore.get(LOCALE_COOKIE)?.value,
  );
  const t = (text: string, vars?: Record<string, string | number>) =>
    translate(locale, text, vars);

  const { error } = await searchParams;
  const keyLoginEnabled = getAccessKeys().length > 0;
  const googleLoginEnabled =
    process.env.STORAGE_DRIVER === "drive" &&
    GOOGLE_LOGIN_ENV.every((name) => Boolean(process.env[name]?.trim()));

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
        ) : keyLoginEnabled ? (
          <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
            {t("OAuth 없는 로컬 모드입니다. 아래 손님용 키로 시작하세요.")}
          </p>
        ) : (
          <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
            {t(
              "이 ShareDesk는 아직 설치가 끝나지 않았습니다. 데스크 소유자는 Google OAuth와 Drive 연결을 마쳐 주세요.",
            )}
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
        ) : !keyLoginEnabled ? (
          <a
            href={CREATE_DESK_URL}
            target="_blank"
            rel="noreferrer"
            className="mt-6 flex items-center justify-center rounded-lg bg-foreground py-2.5 font-medium text-background"
          >
            {t("설치 안내 열기")}
          </a>
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
            href={CREATE_DESK_URL}
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
