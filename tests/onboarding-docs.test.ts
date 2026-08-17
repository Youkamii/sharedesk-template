import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("README는 제품 소개만 짧게 남기고 상세 사용법을 문서로 나눈다", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");

  assert.match(
    readme,
    /한 사람의 Google Drive 저장 공간을 여러 사람이 각자의 Google 계정으로 함께 쓰는 공유 파일 공간/,
  );
  assert.match(readme, /호스트만 처음에 한 번 설치/);
  assert.match(readme, /참여자는 어떤 설치도 하지 않습니다/);
  assert.match(readme, /\[AI에게 구축 맡기기\]\(\.\/docs\/AI_INSTALL\.md\)/);
  assert.match(readme, /\[상세 구축 안내\]\(\.\/docs\/INSTALL\.md\)/);
  assert.match(readme, /\[로컬 개인 사용\]\(\.\/docs\/LOCAL\.md\)/);
  assert.match(readme, /\[업데이트 안내\]\(\.\/docs\/UPDATE\.md\)/);
  assert.ok(
    readme.length < 4_500,
    "README는 상세 사용 설명서가 아니라 사람이 빠르게 읽는 제품 소개여야 합니다.",
  );

  for (const movedDetail of [
    "npm run",
    "GOOGLE_CLIENT_ID",
    "Deploy with Vercel",
    "Google Auth Platform",
    "문제 해결",
    "환경 변수",
  ]) {
    assert.doesNotMatch(readme, new RegExp(movedDetail));
  }
});

test("README와 디자인 문서는 현재 휴지통 배치와 화면 이미지를 설명한다", async () => {
  const screenshotNames = [
    "sharedesk-desktop.png",
    "sharedesk-wallpaper-dusk.png",
    "sharedesk-wallpaper-night.png",
    "sharedesk-wallpaper-dawn.png",
    "sharedesk-wallpaper-tide.png",
  ];
  const [readme, design, ...screenshots] = await Promise.all([
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("DESIGN.md", root), "utf8"),
    ...screenshotNames.map((name) =>
      readFile(new URL(`docs/${name}`, root)),
    ),
  ]);

  assert.match(
    readme,
    /!\[ShareDesk 공유 바탕화면\]\(\.\/docs\/sharedesk-desktop\.png\)/,
  );
  assert.match(design, /화면 오른쪽 아래에 고정하고 작업표시줄에는 넣지 않는다/);
  assert.match(design, /작업표시줄에는 휴지통 버튼을 두지 않는다/);
  for (const [index, wallpaper] of ["dusk", "night", "dawn", "tide"].entries()) {
    assert.match(
      readme,
      new RegExp(`!\\[[^\\]]+\\]\\(\\.\\/docs\\/sharedesk-wallpaper-${wallpaper}\\.png\\)`),
    );
    assert.ok(screenshots[index + 1], `${wallpaper} 화면 이미지가 있어야 합니다.`);
  }

  for (const screenshot of screenshots) {
    assert.deepEqual(
      [...screenshot.subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );
    assert.equal(screenshot.readUInt32BE(16), 1_280);
    assert.equal(screenshot.readUInt32BE(20), 720);
  }
});

test("설치 문서는 OAuth부터 운영 확인까지 필요한 계약을 한곳에 둔다", async () => {
  const [install, aiGuide] = await Promise.all([
    readFile(new URL("docs/INSTALL.md", root), "utf8"),
    readFile(new URL("docs/AI_INSTALL.md", root), "utf8"),
  ]);

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

  const setupIndex = install.search(/^npm run setup\r?$/m);
  const prepareIndex = install.indexOf("npm run setup -- --prepare-env", setupIndex);
  const finishIndex = install.indexOf("npm run setup -- --finish", setupIndex);
  assert.ok(
    setupIndex >= 0 && setupIndex < prepareIndex && prepareIndex < finishIndex,
    "bare setup이 먼저 나오고 prepare-env 호환 안내와 finish가 뒤를 따라야 합니다.",
  );

  const productionSection = install.slice(
    install.indexOf("## 6. Vercel Production 환경 변수와 재배포"),
    install.indexOf("## 7. 운영 확인"),
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
    "SHAREDESK_GITHUB_TOKEN",
  ]);
  assert.match(productionSection, /LOCAL_STORAGE_ROOT.*운영 환경에 넣지 않습니다/);
  assert.match(productionSection, /SHAREDESK_SHARE_TEST_EMAIL.*운영 환경에 넣지 않습니다/);
  assert.match(oauthSection, /Client ID와 Client secret을 안전하게 기록해 두세요/);
  assert.doesNotMatch(oauthSection, /`.env\.local`에.*입력/);

  const envInputInstruction = "`.env.local`에 다음 두 값을 직접 입력합니다.";
  const cloneIndex = install.indexOf("git clone https://github.com/<내-GitHub-계정>/my-sharedesk.git");
  const envInputIndex = install.indexOf(envInputInstruction);
  assert.ok(
    cloneIndex >= 0 && cloneIndex < envInputIndex,
    ".env.local 입력 안내는 저장소를 clone한 뒤에 나와야 합니다.",
  );
  assert.equal(
    install.split(envInputInstruction).length - 1,
    1,
    ".env.local 직접 입력 안내는 한 곳에만 있어야 합니다.",
  );

  const firewallSection = install.slice(
    install.indexOf("## 8. 작동 확인 뒤 운영 보호"),
    install.indexOf("## 문제 해결"),
  );
  assert.match(firewallSection, /Request Path` equals `\/api\/invitations\/code`/);
  assert.match(firewallSection, /Method` equals `POST`/);
  assert.match(firewallSection, /Cookie `sharedesk_session` exists/);
  assert.match(firewallSection, /Fixed Window/);
  assert.match(firewallSection, /기준: `IP`/);
  assert.match(firewallSection, /`60초`에 `10회`/);

  const verificationSection = install.slice(
    install.indexOf("## 7. 운영 확인"),
    install.indexOf("## 8. 작동 확인 뒤 운영 보호"),
  );
  assert.match(verificationSection, /호스트 Google 계정으로 로그인/);
  assert.match(verificationSection, /`\/files`에서 테스트 폴더를 만들고 새로고침 뒤에도 남는지/);
  assert.match(
    verificationSection,
    /화면 오른쪽 아래의 휴지통 아이콘을 눌러 휴지통 창을 열고, 폴더를 복원/,
  );
  assert.match(verificationSection, /열린 창과 겹칠 때 창 뒤로 가려지는지/);
  assert.match(verificationSection, /`\/admin`이 열리는지/);
  assert.match(verificationSection, /1회용[\s\S]*기간 내 무제한/);
  assert.match(verificationSection, /초대 코드를 하나 만들고[\s\S]*한 사람/);
  assert.match(verificationSection, /두 계정에서 같은 파일/);

  const roleGate = install.slice(0, install.indexOf("## 설치 완료 기준"));
  assert.match(roleGate, /## 먼저, 내 역할은 무엇인가요/);
  assert.match(roleGate, /참여자[\s\S]*?이 문서를 따라 설치하지 마세요/);
  assert.match(roleGate, /GitHub 계정, Vercel 프로젝트, Google OAuth 클라이언트는 필요 없습니다/);
  assert.match(roleGate, /## 호스트용 빠른 길/);

  assert.match(aiGuide, /이미 끝난 단계는 반복하지/);
  assert.match(
    aiGuide,
    /기존 OAuth 클라이언트[\s\S]*Audience[\s\S]*refresh token[\s\S]*Drive ID[\s\S]*추측으로[\s\S]*폐기하지/,
  );
  assert.match(install, /현재 저장소가 이미 로컬에 열려 있다면 다시 clone하지 말고/);
  assert.match(install, /기존 `.env\.local`에 유효한 `GOOGLE_REFRESH_TOKEN`[\s\S]*setup을 다시 실행할 필요가 없습니다/);
  assert.match(install, /새 토큰이 실제로 필요하고 기존 연결 때문에 발급되지 않는 경우에만/);
  assert.doesNotMatch(
    install,
    /Youkamii\/sharedesk-template 원본 저장소|제작자의 Vercel 프로젝트|원본 저장소나 다른 사람의 프로젝트 변경은 허용하지 않는다/,
  );
});

test("설치 문서의 초대 안내는 코드 방식과 별도 데스크 설치를 구분한다", async () => {
  const install = await readFile(new URL("docs/INSTALL.md", root), "utf8");
  const inviteSection = install.slice(
    install.indexOf("## 사람 초대와 관리"),
    install.indexOf("## Google Drive로 직접 공유하기"),
  );

  assert.match(inviteSection, /유효 기간[\s\S]*1회용[\s\S]*기간 내 무제한/);
  assert.match(inviteSection, /특정 이메일에 미리 묶이지 않습니다/);
  assert.match(inviteSection, /1회용:[\s\S]*한 사람이 가입에 성공하면 바로 소진/);
  assert.match(inviteSection, /기간 내 무제한:[\s\S]*여러 사람이 함께 쓸 수 있습니다/);
  assert.doesNotMatch(inviteSection, /받을 사람의 이름|실제로 로그인할 Google 이메일/);
});

test("AI 구축 문서와 로컬 개인 사용 문서는 서로 다른 독자를 안내한다", async () => {
  const [readme, install, aiGuide, localGuide] = await Promise.all([
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("docs/INSTALL.md", root), "utf8"),
    readFile(new URL("docs/AI_INSTALL.md", root), "utf8"),
    readFile(new URL("docs/LOCAL.md", root), "utf8"),
  ]);

  assert.match(install, /\[AI에게 구축 맡기기\]\(\.\/AI_INSTALL\.md\)/);
  assert.match(aiGuide, /그대로 복사/);
  assert.match(aiGuide, /docs\/INSTALL\.md/);
  assert.match(aiGuide, /현재 상태/);
  assert.match(aiGuide, /한 번에 한 단계/);
  assert.match(aiGuide, /비밀값|Client secret|refresh token/);
  assert.match(aiGuide, /두 계정[\s\S]*같은 파일/);
  assert.match(localGuide, /STORAGE_DRIVER=local/);
  assert.match(localGuide, /LOCAL_STORAGE_ROOT=\.devstorage/);
  assert.match(localGuide, /npm run dev/);
  assert.match(localGuide, /Google 로그인[\s\S]*확인할 수 없습니다/);
  assert.match(localGuide, /## 개발자 참고/);
  assert.doesNotMatch(readme, /npm run/);
});

test("환경 변수 예시는 현재 초대 코드 용어를 사용한다", async () => {
  const example = await readFile(new URL(".env.example", root), "utf8");
  assert.match(example, /\/admin의 초대 코드를 사용하세요/);
  assert.doesNotMatch(example, /\/admin의 초대 링크를 사용하세요/);
});

test("업데이트 문서는 새 설치와 기존 설치의 실제 갱신 흐름을 구분한다", async () => {
  const [readme, install, aiGuide, localGuide, updateGuide, example] =
    await Promise.all([
      readFile(new URL("README.md", root), "utf8"),
      readFile(new URL("docs/INSTALL.md", root), "utf8"),
      readFile(new URL("docs/AI_INSTALL.md", root), "utf8"),
      readFile(new URL("docs/LOCAL.md", root), "utf8"),
      readFile(new URL("docs/UPDATE.md", root), "utf8"),
      readFile(new URL(".env.example", root), "utf8"),
    ]);

  assert.match(readme, /\[업데이트 안내\]\(\.\/docs\/UPDATE\.md\)/);
  assert.match(install, /관리자 화면의 `업데이트` 버튼/);
  assert.match(aiGuide, /ShareDesk 업데이트 안내/);
  assert.match(localGuide, /업데이트 안내/);
  assert.match(updateGuide, /GitHub Actions[\s\S]*`Run workflow`/);
  assert.match(updateGuide, /새 버전을 자동으로 적용하지 않습니다/);
  assert.match(updateGuide, /새 버전이 있을 때만[\s\S]*`업데이트`에 별/);
  assert.match(updateGuide, /내부 화면의 `업데이트 하기`/);
  assert.match(updateGuide, /검사나 빌드가 실패하면 `main`에 커밋하지 않으므로/);
  assert.match(updateGuide, /releases\/latest\/download\/sharedesk-bootstrap\.mjs/);
  assert.match(updateGuide, /\$env:TEMP/);
  assert.match(updateGuide, /\.env\.local[\s\S]*\.vercel[\s\S]*\.git/);
  assert.match(updateGuide, /공식 0\.1\.0과 다르면[\s\S]*충돌 경로/);
  assert.match(updateGuide, /npm test[\s\S]*npm run lint[\s\S]*tsc[\s\S]*npm run build/);
  assert.match(updateGuide, /AI에게 기존 설치 업데이트 맡기기/);
  assert.match(example, /SHAREDESK_GITHUB_REPOSITORY=/);
});
