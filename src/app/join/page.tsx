import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, resolveIdentity } from "@/lib/auth";
import LogoutButton from "../LogoutButton";
import JoinCodeForm from "./JoinCodeForm";

const ERRORS: Record<string, string> = {
  invite_invalid: "초대 코드가 올바르지 않거나 새 코드로 교체됐습니다.",
  invite_inactive: "현재 비활성화된 초대입니다. 관리자에게 문의해 주세요.",
  invite_used: "이미 사용 완료된 초대 코드입니다.",
  invite_expired: "사용 기간이 끝난 초대 코드입니다.",
  invite_email_mismatch: "초대받은 이메일의 Google 계정으로 다시 로그인해 주세요.",
  invite_rate_limited: "입력 횟수가 너무 많습니다. 잠시 뒤 다시 시도해 주세요.",
  session: "로그인 정보를 확인하지 못했습니다. 다시 로그인해 주세요.",
};

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const me = await resolveIdentity((await cookies()).get(COOKIE_NAME)?.value);
  if (!me) redirect("/");
  if (me.status === "approved") redirect("/files");
  if (me.status === "blocked") redirect("/pending");

  const { error } = await searchParams;

  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-black/10 p-8 shadow-sm dark:border-white/15">
        <h1 className="text-xl font-semibold tracking-tight">데스크 가입</h1>
        <p className="mt-2 text-sm leading-6 text-zinc-500 dark:text-zinc-400">
          관리자에게 받은 기간제 초대 코드를 입력하세요. 코드는
          아래 Google 계정에서 한 번만 쓸 수 있습니다.
        </p>

        <div className="mt-4 rounded-lg bg-black/5 px-3 py-2 dark:bg-white/5">
          <p className="text-sm font-medium">{me.name}</p>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{me.email}</p>
        </div>

        {error && (
          <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">
            {ERRORS[error] ?? "초대 코드를 확인하지 못했습니다."}
          </p>
        )}

        <JoinCodeForm />

        <div className="mt-5 border-t border-black/10 pt-5 text-center dark:border-white/15">
          <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
            다른 Google 계정을 쓰려면 먼저 로그아웃하세요.
          </p>
          <LogoutButton />
        </div>
      </div>
    </main>
  );
}
