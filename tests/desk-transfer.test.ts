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
    "a".repeat(1025),
  ]) {
    assert.equal(
      deskTransferEntryUrls(source, bogus),
      null,
      `통과하면 안 됨: ${bogus}`,
    );
  }
});

// --- 적대 리뷰에서 잡힌 결함들의 재발 방지 ---

// 후행 점을 하나만 지우면 점 두 개로 "단일 라벨"과 "로컬 접미사" 검사를
// 동시에 빠져나갔다.
test("후행 점을 여러 개 붙여도 로컬 이름을 통과시키지 않는다", () => {
  for (const host of [
    "localhost.",
    "localhost..",
    "localhost...",
    "svc.internal..",
    "desk.local..",
    "router..",
  ]) {
    assert.equal(
      parseDeskTransferLink(`https://${host}/api/share/${LINK_ID}`),
      null,
      `통과하면 안 됨: ${host}`,
    );
  }
  // 정상 도메인은 후행 점이 붙어도 그대로 통과해야 한다.
  assert.ok(
    parseDeskTransferLink(`https://desk.example.com./api/share/${LINK_ID}`),
  );
});

// 이름 모양만으로는 127.0.0.1.nip.io 같은 주소를 막지 못한다. 실제 해석되는
// IP를 보고 판단해야 한다.
test("사설·루프백·클라우드 메타데이터 대역을 거부한다", async () => {
  const { isBlockedIpv4, isBlockedIpv6 } = await import(
    "../src/lib/desk-transfer-source"
  );
  for (const ip of [
    "127.0.0.1",
    "127.1.2.3",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.1",
    // 클라우드 인스턴스 메타데이터
    "169.254.169.254",
    // 통신사 대규모 NAT
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
  ]) {
    assert.equal(isBlockedIpv4(ip), true, `막아야 함: ${ip}`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1"]) {
    assert.equal(isBlockedIpv4(ip), false, `막으면 안 됨: ${ip}`);
  }
  for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12::3", "::ffff:127.0.0.1"]) {
    assert.equal(isBlockedIpv6(ip), true, `막아야 함: ${ip}`);
  }
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isBlockedIpv6(ip), false, `막으면 안 됨: ${ip}`);
  }
});

// --- 2라운드 리뷰에서 잡힌 결함들의 재발 방지 ---

// 공유 폴더 페이지는 하위 항목을 ?entryId=로 가리키는 링크로 보여 준다. 그
// 주소를 붙여넣었을 때 쿼리를 버리면 고른 것과 다른 대상(루트 전체)이 복사된다.
test("주소에 붙은 항목 지정을 버리지 않는다", () => {
  const source = parseDeskTransferLink(`${VALID}?entryId=abc123`);
  assert.ok(source);
  assert.equal(source.entryId, "abc123");
  assert.equal(source.fileUrl, `${VALID}?entryId=abc123`);
  assert.equal(source.manifestUrl, `${VALID}?format=json&entryId=abc123`);

  // 항목 지정이 없으면 링크 루트를 가리킨다.
  const plain = parseDeskTransferLink(VALID);
  assert.ok(plain);
  assert.equal(plain.entryId, null);
  assert.equal(plain.fileUrl, VALID);

  // 형태가 어긋난 항목 지정은 조용히 무시하지 않고 통째로 거부한다.
  assert.equal(parseDeskTransferLink(`${VALID}?entryId=a/b`), null);
  assert.equal(parseDeskTransferLink(`${VALID}?entryId=`), null);
});

// 이미 쿼리가 붙은 주소에 항목 지정을 덧붙이면 ?가 두 번 들어간다.
test("항목 주소는 이미 쿼리가 있어도 올바르게 조립된다", () => {
  const source = parseDeskTransferLink(`${VALID}?entryId=first`);
  assert.ok(source);
  const urls = deskTransferEntryUrls(source, "second");
  assert.ok(urls);
  assert.equal(urls.fileUrl, `${VALID}?entryId=second`);
  assert.equal(urls.manifestUrl, `${VALID}?format=json&entryId=second`);
});

// 로컬 저장소는 상대경로를 base64url로 감싼 id를 쓴다. 한글 폴더 몇 단계면
// 256자를 넘어 정상 트리가 복사되지 않았다.
test("긴 항목 id도 받아들인다", () => {
  const source = parseDeskTransferLink(VALID);
  assert.ok(source);
  // 한글 15자 폴더 5단계를 base64url로 감싼 정도의 길이.
  assert.ok(deskTransferEntryUrls(source, "a".repeat(400)));
  assert.ok(deskTransferEntryUrls(source, "a".repeat(1024)));
  assert.equal(deskTransferEntryUrls(source, "a".repeat(1025)), null);
});

test("IPv4에 숨긴 IPv6 주소와 예약 대역도 거부한다", async () => {
  const { isBlockedIpv4, isBlockedIpv6 } = await import(
    "../src/lib/desk-transfer-source"
  );
  // 6to4(2002::/16)와 NAT64(64:ff9b::/96)는 IPv4를 안에 품는다.
  assert.equal(isBlockedIpv6("2002:0a00:0001::"), true, "6to4로 감싼 10.0.0.1");
  assert.equal(isBlockedIpv6("2002:7f00:0001::"), true, "6to4로 감싼 127.0.0.1");
  assert.equal(isBlockedIpv6("64:ff9b::10.0.0.1"), true, "NAT64 점표기");
  assert.equal(isBlockedIpv6("64:ff9b::a00:1"), true, "NAT64 16진 표기");
  // 폐기됐지만 아직 쓰이는 사이트로컬.
  assert.equal(isBlockedIpv6("fec0::1"), true);
  // 6to4로 감싼 공개 주소는 막지 않는다.
  assert.equal(isBlockedIpv6("2002:0808:0808::"), false, "6to4로 감싼 8.8.8.8");

  // 문서용·릴레이 대역
  assert.equal(isBlockedIpv4("198.51.100.1"), true);
  assert.equal(isBlockedIpv4("203.0.113.1"), true);
  assert.equal(isBlockedIpv4("192.88.99.1"), true);
  assert.equal(isBlockedIpv4("192.0.0.1"), true);
  assert.equal(isBlockedIpv4("192.0.2.1"), true);
  // 192.0.0.0/16 전체를 막으면 정상 공개 주소까지 걸린다.
  assert.equal(isBlockedIpv4("192.0.66.1"), false);
  assert.equal(isBlockedIpv4("198.51.99.1"), false);
});
