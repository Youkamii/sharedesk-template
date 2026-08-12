import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("README는 설치 문서로 짧게 안내하고 데스크 생성과 참여를 구분한다", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");
  const opening = readme.slice(0, readme.indexOf("## 주요 기능"));
  const createDeskSection = readme.slice(
    readme.indexOf("## 내 ShareDesk 만들기"),
    readme.indexOf("## 주요 기능"),
  );

  assert.match(opening, /내 ShareDesk 만들기/);
  assert.match(opening, /다른 사람의 ShareDesk에 참여하기/);
  assert.match(opening, /Google 계정으로 로그인한 뒤 호스트가 공유한 기간제 초대 코드/);
  assert.match(opening, /OAuth나 Vercel 설정은 필요 없습니다/);
  assert.match(readme, /\[설치 안내\]\(\.\/docs\/INSTALL\.md\)/);
  assert.match(readme, /https:\/\/github\.com\/Youkamii\/sharedesk-template\/generate/);
  assert.match(readme, /https:\/\/vercel\.com\/new\/clone\?repository-url=/);
  assert.match(readme, /새 토큰이 실제로 필요하고 기존 연결 때문에 발급되지 않는 경우에만/);

  assert.match(createDeskSection, /docs\/INSTALL\.md를 처음부터 끝까지 읽고/);
  assert.match(createDeskSection, /현재 상태를 확인해 끝난 단계는 반복하지 말고/);
  assert.match(createDeskSection, /문서에 표시된 사용자 조작 단계/);
  assert.ok(
    createDeskSection.length < 2_000,
    "README의 설치 진입부는 상세 체크리스트가 아니라 짧은 요청이어야 합니다.",
  );

  for (const duplicatedDetail of [
    "Google Auth Platform → Branding",
    "npm run setup -- --finish",
    "Request Path equals",
    "GOOGLE_REFRESH_TOKEN을 Production",
  ]) {
    assert.doesNotMatch(createDeskSection, new RegExp(duplicatedDetail));
  }
  assert.doesNotMatch(readme, /^# 운영 설치$/m);
  assert.doesNotMatch(
    readme,
    /Youkamii\/sharedesk-template 원본 저장소|제작자의 Vercel 프로젝트|원본 저장소나 다른 사람의 프로젝트 변경은 허용하지 않는다/,
  );
});

test("설치 문서는 OAuth부터 운영 확인까지 필요한 계약을 한곳에 둔다", async () => {
  const install = await readFile(new URL("docs/INSTALL.md", root), "utf8");

  const oauthSection = install.slice(
    install.indexOf("### 2-5. Web application OAuth 클라이언트"),
    install.indexOf("## 3. 로컬 환경 파일 준비"),
  );
  assert.deepEqual(oauthSection.match(/^https?:\/\/.*callback$/gm), [
    "http://127.0.0.1:53682/callback",
    "http://localhost:3000/api/auth/google/callback",
    "https://my-sharedesk.vercel.app/api/auth/google/callback",
  ]);
  assert.match(oauthSection, /Authorized JavaScript origins`: 비워 둠/);

  const prepareIndex = install.indexOf("npm run setup -- --prepare-env");
  const setupOffset = install.slice(prepareIndex).search(/^npm run setup\r?$/m);
  const setupIndex = setupOffset < 0 ? -1 : prepareIndex + setupOffset;
  const finishIndex = install.indexOf("npm run setup -- --finish", setupIndex);
  assert.ok(
    prepareIndex >= 0 && prepareIndex < setupIndex && setupIndex < finishIndex,
    "setup 명령은 prepare-env, setup, finish 순서여야 합니다.",
  );

  const productionSection = install.slice(
    install.indexOf("## 6. Vercel Production 환경 변수와 재배포"),
    install.indexOf("## 7. 초대 코드 요청 제한"),
  );
  const productionTable = productionSection.slice(
    productionSection.indexOf("| 이름 | 값 |"),
    productionSection.indexOf("\n\n", productionSection.indexOf("| 이름 | 값 |")),
  );
  const environmentNames = [...productionTable.matchAll(/\| `([A-Z_]+)` \|/g)].map(
    ([, name]) => name,
  );
  assert.deepEqual(environmentNames, [
    "ADMIN_EMAILS",
    "SESSION_SECRET",
    "STORAGE_DRIVER",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "DRIVE_ROOT_FOLDER_ID",
    "DRIVE_STATE_FOLDER_ID",
    "PUBLIC_BASE_URL",
  ]);
  assert.match(productionSection, /LOCAL_STORAGE_ROOT.*운영 환경에 넣지 않습니다/);
  assert.match(productionSection, /SHAREDESK_SHARE_TEST_EMAIL.*운영 환경에 넣지 않습니다/);
  assert.match(install, /이 단계에서는 Client ID와 Client secret을 `.env\.local`에 입력합니다/);
  assert.match(install, /운영 배포에는 6단계에서 Vercel Production 환경 변수로 옮깁니다/);

  const firewallSection = install.slice(
    install.indexOf("## 7. 초대 코드 요청 제한"),
    install.indexOf("## 8. 운영 확인"),
  );
  assert.match(firewallSection, /Request Path` equals `\/api\/invitations\/code`/);
  assert.match(firewallSection, /Method` equals `POST`/);
  assert.match(firewallSection, /Cookie `sharedesk_session` exists/);
  assert.match(firewallSection, /Fixed Window/);
  assert.match(firewallSection, /기준: `IP`/);
  assert.match(firewallSection, /`60초`에 `10회`/);

  const verificationSection = install.slice(
    install.indexOf("## 8. 운영 확인"),
    install.indexOf("## 문제 해결"),
  );
  assert.match(verificationSection, /호스트 Google 계정으로 로그인/);
  assert.match(verificationSection, /`\/files`에서 테스트 폴더를 만들고 새로고침 뒤에도 남는지/);
  assert.match(verificationSection, /`\/admin`이 열리는지/);
  assert.match(verificationSection, /1회용[\s\S]*기간 내 무제한/);

  assert.match(install, /이미 끝난 단계는 반복하지 않습니다/);
  assert.match(install, /기존 OAuth 클라이언트, Audience 상태, refresh token, Drive ID를 추측으로 바꾸거나 폐기하지 않습니다/);
  assert.match(install, /현재 저장소가 이미 로컬에 열려 있다면 다시 clone하지 말고/);
  assert.match(install, /기존 `.env\.local`에 유효한 `GOOGLE_REFRESH_TOKEN`[\s\S]*setup을 다시 실행할 필요가 없습니다/);
  assert.match(install, /새 토큰이 실제로 필요하고 기존 연결 때문에 발급되지 않는 경우에만/);
  assert.doesNotMatch(
    install,
    /Youkamii\/sharedesk-template 원본 저장소|제작자의 Vercel 프로젝트|원본 저장소나 다른 사람의 프로젝트 변경은 허용하지 않는다/,
  );
});

test("README의 초대 안내는 코드 방식과 별도 데스크 설치를 구분한다", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");
  const inviteSection = readme.slice(
    readme.indexOf("## 사람 초대하기"),
    readme.indexOf("## Google Drive로 직접 공유하기"),
  );

  assert.match(inviteSection, /유효 기간[\s\S]*1회용[\s\S]*기간 내 무제한/);
  assert.match(inviteSection, /이름, 이메일, 비고는 입력하지 않습니다/);
  assert.match(inviteSection, /특정 사람이나 이메일에 미리 묶이지 않습니다/);
  assert.match(inviteSection, /1회용:[\s\S]*한 명이 가입에 성공하면 바로 소진/);
  assert.match(inviteSection, /기간 내 무제한:[\s\S]*여러 명이 같은 코드로 가입/);
  assert.match(inviteSection, /자기 소유의 별도 데스크[\s\S]*운영 설치 안내/);
  assert.doesNotMatch(inviteSection, /받을 사람의 이름|실제로 로그인할 Google 이메일|비고를 남기/);
});

test("환경 변수 예시는 현재 초대 코드 용어를 사용한다", async () => {
  const example = await readFile(new URL(".env.example", root), "utf8");
  assert.match(example, /\/admin의 초대 코드를 사용하세요/);
  assert.doesNotMatch(example, /\/admin의 초대 링크를 사용하세요/);
});
