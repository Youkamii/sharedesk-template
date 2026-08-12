import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("README는 독립 데스크 생성과 기존 데스크 참여를 처음부터 구분한다", async () => {
  const readme = await readFile(new URL("README.md", root), "utf8");
  const opening = readme.slice(0, readme.indexOf("## 주요 기능"));

  assert.match(opening, /내 ShareDesk 만들기/);
  assert.match(opening, /다른 사람의 ShareDesk 참여하기/);
  assert.match(opening, /OAuth나 Vercel 설정은 필요 없습니다/);
  assert.match(readme, /배포 1개가 독립 데스크 1개/);
  assert.match(readme, /https:\/\/github\.com\/Youkamii\/sharedesk-template\/generate/);
  assert.match(readme, /https:\/\/vercel\.com\/new\/clone\?repository-url=/);
  assert.match(readme, /repository-url=https%3A%2F%2Fgithub\.com%2FYoukamii%2Fsharedesk-template/);
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
