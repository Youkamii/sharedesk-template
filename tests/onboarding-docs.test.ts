import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("README는 독립 데스크 생성과 기존 데스크 참여를 처음부터 구분한다", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");
  const opening = readme.slice(0, readme.indexOf("## 주요 기능"));

  assert.match(opening, /내 ShareDesk 만들기/);
  assert.match(opening, /다른 사람의 ShareDesk에 참여하기/);
  assert.match(opening, /Google 계정으로 로그인한 뒤 호스트가 공유한 기간제 초대 코드/);
  assert.match(opening, /1회용 코드는 한 명이 가입에 성공하면 바로 소진/);
  assert.match(opening, /기간 내 무제한 코드는 만료되거나 호스트가 끌 때까지 여러 명이 함께 씁니다/);
  assert.match(opening, /OAuth나 Vercel 설정은 필요 없습니다/);
  assert.match(readme, /배포 1개가 독립 데스크 1개/);
  assert.match(readme, /https:\/\/github\.com\/Youkamii\/sharedesk-template\/generate/);
  assert.match(readme, /https:\/\/vercel\.com\/new\/clone\?repository-url=/);
  assert.match(readme, /repository-url=https%3A%2F%2Fgithub\.com%2FYoukamii%2Fsharedesk-template/);
  assert.match(readme, /1시간[\s\S]*24시간[\s\S]*7일[\s\S]*30일/);
  assert.match(readme, /이미 소진된 1회용 코드도 거부/);
  assert.match(readme, /Request Path.*`\/api\/invitations\/code`[\s\S]*Method.*`POST`[\s\S]*Cookie `sharedesk_session`[\s\S]*Fixed Window[\s\S]*IP[\s\S]*60초[\s\S]*10회/);
  assert.match(readme, /Rate Limiting은 모든 플랜[\s\S]*포함량과 요금은 플랜·지역/);

  const inviteSection = readme.slice(
    readme.indexOf("## 5. 사람 초대하기"),
    readme.indexOf("## Google Drive로 직접 공유하기"),
  );
  assert.match(inviteSection, /유효 기간[\s\S]*1회용[\s\S]*무제한[\s\S]*이름, 이메일, 비고는 입력하지 않습니다/);
  assert.match(inviteSection, /특정 사람이나 이메일에 미리 묶이지 않습니다/);
  assert.match(inviteSection, /1회용:[\s\S]*한 명이 가입에 성공하면 바로 소진/);
  assert.match(inviteSection, /기간 내 무제한:[\s\S]*유효 기간이 끝나거나 호스트가 코드를 비활성화할 때까지 여러 명/);
  assert.match(inviteSection, /자기 소유의 별도 데스크[\s\S]*독립 배포/);
  assert.doesNotMatch(inviteSection, /받을 사람의 이름|실제로 로그인할 Google 이메일|비고를 남기/);
});

test("운영용 AI 프롬프트는 사용자 소유 배포를 끝까지 만들고 비밀을 노출하지 않는다", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");
  const section = readme.slice(
    readme.indexOf("## 내 ShareDesk 만들기"),
    readme.indexOf("## AI에게 설치 맡기기"),
  );

  for (const phrase of [
    "내 계정에 새 저장소와 새 Vercel 프로젝트",
    "비밀값 없이 Vercel에 1차 배포",
    "npm run setup -- --prepare-env",
    "Production 환경에 넣고 Redeploy",
    "호스트 Google 로그인",
    "폴더 생성",
    "새로고침 뒤 유지",
    "/admin 접근",
    "원본 저장소나 다른 사람의 프로젝트 변경은 허용하지 않는다",
  ]) {
    assert.ok(section.includes(phrase), `AI 프롬프트 누락: ${phrase}`);
  }
  assert.match(section, /GOOGLE_CLIENT_SECRET[\s\S]*채팅[\s\S]*출력하지 마/);
});

test("운영 설치는 고정 주소를 먼저 얻고 자기 저장소에서 setup한다", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");
  const install = readme.slice(readme.indexOf("# 운영 설치"));

  const deployIndex = install.indexOf("## 0. 내 저장소와 운영 주소 만들기");
  const googleIndex = install.indexOf("## 1. Google Cloud 프로젝트 만들기");
  const setupIndex = install.indexOf("## 2. 호스트 Drive 연결");
  assert.ok(deployIndex >= 0 && deployIndex < googleIndex && googleIndex < setupIndex);
  assert.match(install, /git clone https:\/\/github\.com\/<내-GitHub-계정>\/my-sharedesk\.git/);
  assert.doesNotMatch(install, /git clone https:\/\/github\.com\/Youkamii\/sharedesk-template\.git/);
});
