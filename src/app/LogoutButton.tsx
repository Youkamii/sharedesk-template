"use client";

import { useRouter } from "next/navigation";
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
        await fetch("/api/auth", { method: "DELETE" });
        router.replace("/");
        router.refresh();
      }}
    >
      {t("로그아웃")}
    </button>
  );
}
