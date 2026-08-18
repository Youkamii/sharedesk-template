import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, resolveIdentity } from "@/lib/auth";
import { LOCALE_COOKIE, resolveEffectiveLocale, translate } from "@/lib/i18n";
import { getDeskSettings } from "@/lib/users";
import LogoutButton from "../LogoutButton";

export default async function PendingPage() {
  const cookieStore = await cookies();
  const me = await resolveIdentity(cookieStore.get(COOKIE_NAME)?.value);
  if (!me) redirect("/");
  if (me.status === "approved") redirect("/files");
  if (me.status === "pending") redirect("/join");

  const locale = resolveEffectiveLocale(
    await getDeskSettings(),
    cookieStore.get(LOCALE_COOKIE)?.value,
  );
  const t = (text: string, vars?: Record<string, string | number>) =>
    translate(locale, text, vars);

  return (
    <main className="relative flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-2xl border border-black/10 p-8 text-center shadow-sm dark:border-white/15">
        <h1 className="text-xl font-semibold tracking-tight">
          {t("접근이 막혀 있습니다")}
        </h1>
        <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
          {t("관리자가 이 계정의 접근을 막았습니다.")}
        </p>
        <p className="mt-4 text-sm font-medium">{me.name}</p>
        <p className="text-xs text-zinc-400">{me.email}</p>
        <div className="mt-6">
          <LogoutButton locale={locale} />
        </div>
      </div>
    </main>
  );
}
