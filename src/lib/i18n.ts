import { EN_ADMIN } from "@/lib/i18n-en-admin";
import { EN_COMMON } from "@/lib/i18n-en-common";
import { EN_FILES } from "@/lib/i18n-en-files";

// 한국어 원문이 곧 키다. 번역이 없으면 한국어를 그대로 보여 주므로
// 문구 추가 시 번역 누락이 화면 오류가 되지 않는다.
export type Locale = "ko" | "en";

export const LOCALE_COOKIE = "sharedesk_locale";
export const LOCALES: readonly Locale[] = ["ko", "en"];

const EN: Record<string, string> = {
  ...EN_COMMON,
  ...EN_FILES,
  ...EN_ADMIN,
};

export function resolveLocale(value: string | undefined | null): Locale {
  return value === "en" ? "en" : "ko";
}

export function translate(
  locale: Locale,
  text: string,
  vars?: Record<string, string | number>,
): string {
  let out = locale === "en" ? (EN[text] ?? text) : text;
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      out = out.replaceAll(`{${key}}`, String(value));
    }
  }
  return out;
}

// 검사·도구용으로 병합 사전을 읽기 전용으로 노출한다.
export function englishDictionary(): Readonly<Record<string, string>> {
  return EN;
}
