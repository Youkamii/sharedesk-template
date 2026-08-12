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
    /처음 이용하는 사람은[\s\S]*?관리자가[\s\S]*?초대 링크로 시작합니다/,
  );
  assert.match(source, /내 ShareDesk 만들기/);
  assert.match(source, /내[\s\S]*?별도 배포와 Google Drive를 쓰는 독립된 데스크/);
  assert.match(
    source,
    /https:\/\/github\.com\/Youkamii\/sharedesk-template#내-sharedesk-만들기/,
  );
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
