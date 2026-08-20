import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { EN_COMMON } from "../src/lib/i18n-en-common";
import { HI } from "../src/lib/i18n-hi";
import { JA } from "../src/lib/i18n-ja";
import { ZH } from "../src/lib/i18n-zh";

test("로그인 화면에서 현재 데스크 참여와 독립 데스크 만들기를 구분한다", async () => {
  const source = await readFile(
    new URL("../src/app/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /href="\/api\/auth\/google"/);
  assert.match(
    source,
    /호스트의 Google Drive 저장 공간[\s\S]*?여러 사람이 함께[\s\S]*?내 Google 계정으로[\s\S]*?초대 코드를 입력/,
  );
  assert.match(source, /Google로 계속하기/);
  assert.match(source, /resolveIdentity/);
  assert.match(source, /identity\?\.status === "pending"[\s\S]*?redirect\("\/join"\)/);
  assert.match(source, /호스트 설치 안내/);
  assert.match(source, /내 Google Drive 용량[\s\S]*?여러 사람과 함께/);
  assert.match(source, /참여자라면 GitHub,[\s\S]*?Vercel, OAuth 설정 없이/);
  assert.match(
    source,
    // 문서 링크는 화면 언어에 맞는 언어판으로 간다 (docUrl 헬퍼).
    /docUrl\("INSTALL", locale\)/,
  );
});

test("Google 로그인한 신규 사용자는 기간제 1회용 또는 기간 내 무제한 코드로 가입한다", async () => {
  const [pageSource, formSource, apiSource, filesSource, adminSource] = await Promise.all([
    readFile(new URL("../src/app/join/page.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/join/JoinCodeForm.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/api/invitations/code/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/app/files/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/admin/page.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(pageSource, /resolveIdentity/);
  assert.match(pageSource, /me\.status === "approved"[\s\S]*?redirect\("\/files"\)/);
  assert.match(pageSource, /기간제 초대 코드/);
  assert.match(pageSource, /1회용은 한 명이[\s\S]*가입하면 끝납니다/);
  assert.match(pageSource, /기간 내 무제한은 만료되거나 관리자가 끌 때까지[\s\S]*여러 명/);
  assert.match(
    formSource,
    /<form[\s\S]*?action="\/api\/invitations\/code"[\s\S]*?method="post"/,
  );
  assert.match(formSource, /maxLength=\{96\}/);
  assert.match(formSource, /name="code"/);
  assert.match(formSource, /autoComplete="off"/);
  assert.match(formSource, /placeholder="XXXX-XXXX-XXXX-XXXX-…"/);
  assert.match(
    apiSource,
    /const invitation = parseInvitationCode\(await readCode\(req\)\)/,
  );
  assert.match(apiSource, /if \(!invitation\) return redirect\(req, "\/join", "invite_invalid"\)/);
  assert.match(
    apiSource,
    /if \(!redeemed\.ok\) return redirect\(req, "\/join", redeemed\.reason\)/,
  );
  assert.match(apiSource, /redeemInvitationForUser\([\s\S]*?claims\.sub[\s\S]*?invitation/);
  assert.doesNotMatch(apiSource, /invitation\.(?:email|name|note)/);
  assert.match(filesSource, /identity\?\.status === "pending"[\s\S]*?"\/join"/);
  assert.match(adminSource, /identity\?\.status === "pending"[\s\S]*?"\/join"/);
});

test("OAuth를 아직 설정하지 않은 새 배포는 실패하는 로그인 링크를 감춘다", async () => {
  const source = await readFile(
    new URL("../src/app/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /process\.env\.STORAGE_DRIVER === "drive"[\s\S]*?GOOGLE_LOGIN_ENV\.every/,
  );
  for (const name of [
    "ADMIN_EMAILS",
    "SESSION_SECRET",
    "CRON_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "DRIVE_ROOT_FOLDER_ID",
    "DRIVE_STATE_FOLDER_ID",
  ]) {
    assert.ok(source.includes(`"${name}"`), `필수 설정 누락: ${name}`);
  }
  assert.match(source, /googleLoginEnabled \? \([\s\S]*?href="\/api\/auth\/google"/);
  assert.match(source, /이 ShareDesk는 아직 설치가 끝나지 않았습니다/);
  assert.match(source, /설치 안내 열기/);
  assert.match(source, /OAuth 없는 로컬 모드입니다/);
  // 로그인 수단이 하나도 없으면 로그인 카드 대신 설치 안내 화면으로 빠진다.
  assert.match(
    source,
    /if \(!googleLoginEnabled && !keyLoginEnabled\) \{[\s\S]*?설치 안내 열기/,
  );
});

test("미설정 첫 화면은 픽셀 창과 브라우저 언어(Accept-Language)로 안내한다", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../src/app/page.tsx", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/unconfigured.module.css", import.meta.url),
      "utf8",
    ),
  ]);

  // 데스크 설정이 아직 없으므로 언어는 브라우저 Accept-Language에서 고른다.
  assert.match(source, /await headers\(\)/);
  assert.match(source, /get\("accept-language"\)/);
  assert.match(source, /matchAcceptLanguage/);
  assert.match(source, /parseLocale\(tag\.split\("-"\)\[0\]\)/);
  assert.match(source, /return "en";/); // 매칭 실패 시 영어 폴백

  // 픽셀 창(도트 프레임·Galmuri)으로 그린다.
  assert.match(source, /unconfigured\.module\.css/);
  for (const className of ["screen", "window", "titlebar", "installLink", "footnote"]) {
    assert.ok(source.includes(`pixel.${className}`), `픽셀 클래스 미사용: ${className}`);
  }
  assert.match(source, /설치가 끝나면 이 주소가 로그인 화면이 됩니다\./);
  assert.match(css, /var\(--font-pixel\)/); // Galmuri11 (globals.css)
  assert.match(css, /#10172b/); // Dusk Room OS — night
  assert.match(css, /#f4e7c5/); // window
  assert.match(css, /inset 2px 2px 0 #fff8e7/); // 2px 빛/어둠 픽셀 프레임

  // 다섯 언어 모두에서 표시된다: ko는 원문, 나머지 4개 언어는 사전 키.
  for (const key of [
    "이 ShareDesk는 아직 설치가 끝나지 않았습니다. 데스크 소유자는 Google OAuth와 Drive 연결을 마쳐 주세요.",
    "설치 안내 열기",
    "설치 준비 중",
    "설치가 끝나면 이 주소가 로그인 화면이 됩니다.",
  ]) {
    for (const [name, dictionary] of Object.entries({ EN_COMMON, JA, HI, ZH })) {
      assert.ok(key in dictionary, `${name} 사전에 없는 키 — ${key}`);
    }
  }
});
