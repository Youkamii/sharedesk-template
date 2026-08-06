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
          구글 계정으로 로그인하면 관리자 승인 후 공유 드라이브가 열립니다.
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
