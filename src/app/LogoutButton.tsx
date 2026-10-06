"use client";

import { useRouter } from "next/navigation";
import { clearNewBadgeStores } from "@/lib/client/new-badges";
import { translate, type Locale } from "@/lib/i18n";

export default function LogoutButton({
  locale,
  className = "text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
}: {
  locale: Locale;
  className?: string;
}) {
  const router = useRouter();
  const t = (text: string, vars?: Record<string, string | number>) =>
    translate(locale, text, vars);
  return (
    <button
      className={className}
      onClick={async () => {
        // 이 브라우저에 남긴 NEW 배지 기록(#16 C-2 — 키에 이메일이 들어 있다)을 지운다.
        clearNewBadgeStores();
        await fetch("/api/auth", { method: "DELETE" });
        router.replace("/");
        router.refresh();
      }}
    >
      {t("로그아웃")}
    </button>
  );
}
