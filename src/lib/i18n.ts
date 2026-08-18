import { EN_ADMIN } from "@/lib/i18n-en-admin";
import { EN_COMMON } from "@/lib/i18n-en-common";
import { EN_FILES } from "@/lib/i18n-en-files";
import { HI } from "@/lib/i18n-hi";
import { JA } from "@/lib/i18n-ja";
import { ZH } from "@/lib/i18n-zh";

// 한국어 원문이 곧 키다. 번역이 없으면 영어, 영어도 없으면 한국어 원문을
// 보여 주므로 문구 추가 시 번역 누락이 화면 오류가 되지 않는다.
export type Locale = "en" | "ko" | "ja" | "hi" | "zh";

export const LOCALE_COOKIE = "sharedesk_locale";
export const LOCALES: readonly Locale[] = ["en", "ko", "ja", "hi", "zh"];

// 언어 이름은 그 언어 자신의 표기로 보여 준다 (언어 선택 UI 공용).
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  ko: "한국어",
  ja: "日本語",
  hi: "हिन्दी",
  zh: "中文",
};

const EN: Record<string, string> = {
  ...EN_COMMON,
  ...EN_FILES,
  ...EN_ADMIN,
};

const DICTIONARIES: Partial<Record<Locale, Record<string, string>>> = {
  en: EN,
  ja: JA,
  hi: HI,
  zh: ZH,
};


// 날짜·시각 서식용 BCP47 로케일. 화면 언어와 짝을 맞춘다.
export const LOCALE_BCP47: Record<Locale, string> = {
  en: "en-US",
  ko: "ko-KR",
  ja: "ja-JP",
  hi: "hi-IN",
  zh: "zh-CN",
};

export function parseLocale(value: unknown): Locale | null {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value)
    ? (value as Locale)
    : null;
}

export interface DeskLocaleSettings {
  locale: Locale;
  allowMemberLocale: boolean;
}

// 데스크 언어는 관리자가 정하고, 개별 언어 허용을 켠 데스크에서만
// 각자의 쿠키 선택이 데스크 언어를 덮는다.
export function resolveEffectiveLocale(
  settings: DeskLocaleSettings,
  cookieValue: string | undefined | null,
): Locale {
  if (settings.allowMemberLocale) {
    const personal = parseLocale(cookieValue);
    if (personal) return personal;
  }
  return settings.locale;
}

export function translate(
  locale: Locale,
  text: string,
  vars?: Record<string, string | number>,
): string {
  let out = text;
  if (locale !== "ko") {
    out = DICTIONARIES[locale]?.[text] ?? EN[text] ?? text;
  }
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
