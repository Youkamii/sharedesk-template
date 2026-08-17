"use client";

import { useRouter } from "next/navigation";
import { LOCALE_COOKIE, type Locale } from "@/lib/i18n";

// 언어 전환은 쿠키에 저장하고 서버 컴포넌트를 새로 그려 모든 화면에 적용한다.
export default function LanguageToggle({
  locale,
  className,
}: {
  locale: Locale;
  className?: string;
}) {
  const router = useRouter();
  const next: Locale = locale === "ko" ? "en" : "ko";
  return (
    <button
      type="button"
      className={className}
      aria-label={locale === "ko" ? "Switch to English" : "한국어로 전환"}
      title={locale === "ko" ? "English" : "한국어"}
      onClick={() => {
        document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
        router.refresh();
      }}
    >
      {locale === "ko" ? "EN" : "한"}
    </button>
  );
}
