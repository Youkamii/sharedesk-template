import assert from "node:assert/strict";
import test from "node:test";
import {
  deskTransferEntryUrls,
  parseDeskTransferLink,
} from "../src/lib/desk-transfer";

const LINK_ID = "a".repeat(48);
const VALID = `https://friend-desk.vercel.app/api/share/${LINK_ID}`;

test("다른 데스크의 공개 링크는 가져올 주소로 변환된다", () => {
  const source = parseDeskTransferLink(VALID);
  assert.ok(source);
  assert.equal(source.origin, "https://friend-desk.vercel.app");
  assert.equal(source.linkId, LINK_ID);
  assert.equal(source.fileUrl, VALID);
  assert.equal(source.manifestUrl, `${VALID}?format=json`);
});

test("붙여넣기 앞뒤 공백은 흡수한다", () => {
  assert.ok(parseDeskTransferLink(`  ${VALID}\n`));
});

// 로컬 차단이 정상 도메인까지 잡으면 기능 자체가 죽는다.
test("평범한 공개 도메인은 그대로 통과한다", () => {
  for (const host of [
    "friend-desk.vercel.app",
    "desk.example.co.kr",
    "sharedesk.io",
    // 뒤에 점이 붙은 FQDN 표기도 같은 도메인이다
    "friend-desk.vercel.app.",
    // 이름 안에 local이 들어가도 접미사가 아니면 공개 도메인이다
    "localhost.example.com",
    "my-local.dev",
  ]) {
    assert.ok(
      parseDeskTransferLink(`https://${host}/api/share/${LINK_ID}`),
      `막히면 안 됨: ${host}`,
    );
  }
});

// 서버가 남이 준 주소로 접속하는 기능이므로, 내부망·로컬 자원을 가리키는
// 입력은 형태 단계에서 전부 막혀야 한다.
test("내부망과 로컬 자원을 가리키는 주소는 거부한다", () => {
  const blocked = [
    // 스킴이 다른 경우
    `http://friend-desk.vercel.app/api/share/${LINK_ID}`,
    `file:///etc/passwd`,
    `data:text/plain,hello`,
    `ftp://friend-desk.vercel.app/api/share/${LINK_ID}`,
    // 호스트가 로컬·사설·클라우드 메타데이터
    `https://localhost/api/share/${LINK_ID}`,
    `https://127.0.0.1/api/share/${LINK_ID}`,
    `https://169.254.169.254/api/share/${LINK_ID}`,
    `https://192.168.0.1/api/share/${LINK_ID}`,
    `https://10.0.0.5/api/share/${LINK_ID}`,
    `https://[::1]/api/share/${LINK_ID}`,
    // 점 없는 단일 라벨은 내부망 호스트명이다
    `https://router/api/share/${LINK_ID}`,
    `https://intranet/api/share/${LINK_ID}`,
    // 로컬 전용 접미사
    `https://foo.localhost/api/share/${LINK_ID}`,
    `https://desk.local/api/share/${LINK_ID}`,
    `https://svc.internal/api/share/${LINK_ID}`,
    // 대문자로 우회 시도
    `https://LOCALHOST/api/share/${LINK_ID}`,
    // 포트를 붙여 내부 서비스를 겨냥하는 경우
    `https://friend-desk.vercel.app:8080/api/share/${LINK_ID}`,
    // 파서를 헷갈리게 하는 userinfo
    `https://evil.com@friend-desk.vercel.app/api/share/${LINK_ID}`,
    `https://friend-desk.vercel.app:pass@evil.com/api/share/${LINK_ID}`,
  ];
  for (const input of blocked) {
    assert.equal(parseDeskTransferLink(input), null, `통과하면 안 됨: ${input}`);
  }
});

test("ShareDesk 공개 링크 형태가 아니면 거부한다", () => {
  const blocked = [
    `https://evil.com/anything`,
    `https://friend-desk.vercel.app/`,
    `https://friend-desk.vercel.app/api/share/`,
    // linkId 길이가 다르다
    `https://friend-desk.vercel.app/api/share/${"a".repeat(47)}`,
    `https://friend-desk.vercel.app/api/share/${"a".repeat(49)}`,
    // hex가 아니다
    `https://friend-desk.vercel.app/api/share/${"g".repeat(48)}`,
    `https://friend-desk.vercel.app/api/share/${"A".repeat(48)}`,
    // 경로를 덧붙여 다른 엔드포인트로 새는 경우
    `https://friend-desk.vercel.app/api/share/${LINK_ID}/../../admin`,
    `https://friend-desk.vercel.app/api/admin/${LINK_ID}`,
  ];
  for (const input of blocked) {
    assert.equal(parseDeskTransferLink(input), null, `통과하면 안 됨: ${input}`);
  }
});

test("문자열이 아니거나 지나치게 긴 입력은 파싱하지 않는다", () => {
  for (const input of [null, undefined, 42, {}, [], "", "   "]) {
    assert.equal(parseDeskTransferLink(input), null);
  }
  assert.equal(
    parseDeskTransferLink(`https://a.com/api/share/${LINK_ID}?${"x".repeat(3000)}`),
    null,
  );
});

test("폴더 항목 주소는 보내는 데스크가 알려 준 id 형태만 받는다", () => {
  const source = parseDeskTransferLink(VALID);
  assert.ok(source);

  const urls = deskTransferEntryUrls(source, "1AbC_de-42");
  assert.ok(urls);
  assert.equal(urls.fileUrl, `${VALID}?entryId=1AbC_de-42`);
  assert.equal(urls.manifestUrl, `${VALID}?format=json&entryId=1AbC_de-42`);

  // 쿼리·경로를 끼워 넣어 다른 대상을 가리키려는 값은 막는다.
  for (const bogus of [
    "",
    "../../secret",
    "a&entryId=b",
    "a?format=html",
    "a b",
    "a/b",
    "a".repeat(257),
  ]) {
    assert.equal(
      deskTransferEntryUrls(source, bogus),
      null,
      `통과하면 안 됨: ${bogus}`,
    );
  }
});
