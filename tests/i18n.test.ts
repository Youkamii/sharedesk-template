import assert from "node:assert/strict";
import test from "node:test";
import {
  englishDictionary,
  resolveLocale,
  translate,
} from "../src/lib/i18n";
import { EN_ADMIN } from "../src/lib/i18n-en-admin";
import { EN_COMMON } from "../src/lib/i18n-en-common";
import { EN_FILES } from "../src/lib/i18n-en-files";

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([A-Za-z0-9_가-힣]+)\}/g)].map(([, name]) => name).sort();
}

test("locale resolution defaults to Korean and only accepts known locales", () => {
  assert.equal(resolveLocale(undefined), "ko");
  assert.equal(resolveLocale(null), "ko");
  assert.equal(resolveLocale(""), "ko");
  assert.equal(resolveLocale("fr"), "ko");
  assert.equal(resolveLocale("en"), "en");
  assert.equal(resolveLocale("ko"), "ko");
});

test("translate falls back to the Korean source and fills placeholders", () => {
  assert.equal(translate("ko", "저장"), "저장");
  assert.equal(translate("en", "이-키는-사전에-없다"), "이-키는-사전에-없다");
  assert.equal(
    translate("ko", "새 버전 {v}을 사용할 수 있습니다.", { v: "1.2.3" }),
    "새 버전 1.2.3을 사용할 수 있습니다.",
  );
});

test("english dictionary entries are actually English and keep placeholders", () => {
  // 한국어·영어 표기가 같아야 하는 언어 이름 같은 예외만 허용한다.
  const allowedKoreanValues = new Set(["한국어", "한"]);
  for (const [domain, dictionary] of Object.entries({
    EN_COMMON,
    EN_FILES,
    EN_ADMIN,
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

test("domain dictionaries do not silently override each other", () => {
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
