import assert from "node:assert/strict";
import test from "node:test";
import {
  englishDictionary,
  LOCALE_LABELS,
  LOCALES,
  parseLocale,
  resolveEffectiveLocale,
  translate,
} from "../src/lib/i18n";
import { EN_ADMIN } from "../src/lib/i18n-en-admin";
import { EN_COMMON } from "../src/lib/i18n-en-common";
import { EN_FILES } from "../src/lib/i18n-en-files";
import { HI } from "../src/lib/i18n-hi";
import { JA } from "../src/lib/i18n-ja";
import { ZH } from "../src/lib/i18n-zh";

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z0-9_가-힣]+)\}/g)].map(([, name]) => name).sort();
}

test("locale parsing accepts exactly the five supported locales", () => {
  assert.deepEqual([...LOCALES], ["en", "ko", "ja", "hi", "zh"]);
  for (const locale of LOCALES) {
    assert.equal(parseLocale(locale), locale);
    assert.equal(typeof LOCALE_LABELS[locale], "string");
  }
  assert.equal(parseLocale(undefined), null);
  assert.equal(parseLocale(""), null);
  assert.equal(parseLocale("fr"), null);
  assert.equal(parseLocale(42), null);
});

test("effective locale follows the desk unless member choice is allowed", () => {
  const desk = { locale: "en" as const, allowMemberLocale: false };
  assert.equal(resolveEffectiveLocale(desk, "ko"), "en");
  assert.equal(resolveEffectiveLocale(desk, undefined), "en");
  const open = { locale: "en" as const, allowMemberLocale: true };
  assert.equal(resolveEffectiveLocale(open, "ja"), "ja");
  assert.equal(resolveEffectiveLocale(open, "nope"), "en");
  assert.equal(resolveEffectiveLocale(open, undefined), "en");
});

test("translate falls back per locale (own dictionary → English → Korean source)", () => {
  assert.equal(translate("ko", "저장"), "저장");
  assert.equal(translate("en", "이-키는-사전에-없다"), "이-키는-사전에-없다");
  // ja/hi/zh 사전에 없는 키는 영어로 폴백한다.
  const englishOnlyKey = Object.keys(englishDictionary()).find(
    (key) => !(key in JA),
  );
  if (englishOnlyKey) {
    assert.equal(
      translate("ja", englishOnlyKey),
      englishDictionary()[englishOnlyKey],
    );
  }
  assert.equal(
    translate("ko", "새 버전 {v}을 사용할 수 있습니다.", { v: "1.2.3" }),
    "새 버전 1.2.3을 사용할 수 있습니다.",
  );
});

test("dictionary entries are translated and keep placeholders", () => {
  // 한국어·번역이 같아야 하는 언어 이름 같은 예외만 허용한다.
  const allowedKoreanValues = new Set(["한국어", "한"]);
  for (const [domain, dictionary] of Object.entries({
    EN_COMMON,
    EN_FILES,
    EN_ADMIN,
    JA,
    HI,
    ZH,
  })) {
    for (const [source, translated] of Object.entries(dictionary)) {
      assert.ok(
        translated.trim().length > 0,
        `${domain}: 빈 번역 — ${source}`,
      );
      if (!allowedKoreanValues.has(translated)) {
        // {인원}처럼 한국어 이름을 쓰는 자리표시자는 본문이 아니므로 제외한다.
        const withoutPlaceholders = translated.replace(
          /\{[A-Za-z0-9_가-힣]+\}/g,
          "",
        );
        assert.doesNotMatch(
          withoutPlaceholders,
          /[가-힣]/,
          `${domain}: 번역에 한국어가 남음 — ${source} -> ${translated}`,
        );
      }
      assert.deepEqual(
        placeholders(translated),
        placeholders(source),
        `${domain}: 자리표시자 불일치 — ${source}`,
      );
    }
  }
});

test("english domain dictionaries do not silently override each other", () => {
  const merged = new Map<string, { domain: string; value: string }>();
  for (const [domain, dictionary] of Object.entries({
    EN_COMMON,
    EN_FILES,
    EN_ADMIN,
  })) {
    for (const [source, translated] of Object.entries(dictionary)) {
      const existing = merged.get(source);
      if (existing) {
        assert.equal(
          existing.value,
          translated,
          `같은 원문에 서로 다른 번역: "${source}" — ${existing.domain} vs ${domain}`,
        );
      }
      merged.set(source, { domain, value: translated });
    }
  }
  assert.equal(Object.keys(englishDictionary()).length, merged.size);
});

test("ja/hi/zh dictionaries only translate keys that exist in English", () => {
  // 영어 사전이 키의 기준 목록이다 — 다른 언어에 고아 키가 생기면 오타다.
  const english = englishDictionary();
  for (const [name, dictionary] of Object.entries({ JA, HI, ZH })) {
    for (const source of Object.keys(dictionary)) {
      assert.ok(source in english, `${name}: 영어 사전에 없는 키 — ${source}`);
    }
  }
});
