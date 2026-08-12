import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("로그인 화면에서 현재 데스크 참여와 독립 데스크 만들기를 구분한다", async () => {
  const source = await readFile(
    new URL("../src/app/page.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /href="\/api\/auth\/google"/);
  assert.match(
    source,
    /Google 계정으로 먼저 로그인[\s\S]*?처음 이용하는 분은[\s\S]*?로그인 후[\s\S]*?초대 코드를 입력합니다/,
  );
  assert.match(source, /Google로 계속하기/);
  assert.match(source, /resolveIdentity/);
  assert.match(source, /identity\?\.status === "pending"[\s\S]*?redirect\("\/join"\)/);
  assert.match(source, /내 ShareDesk 만들기/);
  assert.match(source, /내[\s\S]*?별도 배포와 Google Drive를 쓰는 독립된 데스크/);
  assert.match(
    source,
    /https:\/\/github\.com\/Youkamii\/sharedesk-template#내-sharedesk-만들기/,
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
  assert.match(source, /!keyLoginEnabled \? \([\s\S]*?설치 안내 열기/);
});
