import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, resolveSession } from "@/lib/auth";
import { getAccessKeys } from "@/lib/session-token";
import KeyForm from "./KeyForm";

const ERRORS: Record<string, string> = {
  denied: "구글 로그인이 취소되었습니다.",
  state: "로그인 요청이 유효하지 않습니다. 다시 시도해 주세요.",
  token: "구글 인증에 실패했습니다.",
  userinfo: "계정 정보를 가져오지 못했습니다.",
  profile: "이메일이 확인되지 않은 계정입니다.",
  unconfigured: "구글 로그인이 아직 설정되지 않았습니다.",
  invalid: "로그인 요청이 유효하지 않습니다.",
  invite_required: "처음 이용하려면 관리자가 만든 초대 링크가 필요합니다.",
  invite_invalid: "초대 링크가 올바르지 않거나 새 링크로 교체됐습니다.",
  invite_inactive: "현재 비활성화된 초대입니다. 관리자에게 문의해 주세요.",
  invite_used: "이미 사용 완료된 초대입니다.",
  invite_email_mismatch: "초대받은 이메일의 Google 계정으로 로그인해 주세요.",
  blocked: "차단된 사용자입니다. 관리자에게 문의해 주세요.",
};

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const session = await resolveSession((await cookies()).get(COOKIE_NAME)?.value);
  if (session) redirect("/files");

  const { error } = await searchParams;
  const keyLoginEnabled = getAccessKeys().length > 0;

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-black/10 p-8 shadow-sm dark:border-white/15">
        <h1 className="text-2xl font-semibold tracking-tight">ShareDesk</h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          기존 사용자는 Google 계정으로 로그인하고, 처음 이용하는 사람은 관리자가
          만든 초대 링크로 시작합니다.
        </p>

        {error && (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
            {ERRORS[error] ?? "로그인에 실패했습니다."}
          </p>
        )}

        <Link
          href="/api/auth/google"
          prefetch={false}
          className="mt-6 flex items-center justify-center gap-2 rounded-lg bg-foreground py-2.5 font-medium text-background"
        >
          구글 계정으로 로그인
        </Link>

        {keyLoginEnabled && (
          <>
            <div className="my-6 flex items-center gap-3 text-xs text-zinc-400">
              <span className="h-px flex-1 bg-black/10 dark:bg-white/15" />
              또는 손님용 키
              <span className="h-px flex-1 bg-black/10 dark:bg-white/15" />
            </div>
            <KeyForm />
          </>
        )}
      </div>
    </main>
  );
}
