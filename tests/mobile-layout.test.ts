import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MOBILE_LAYOUT_MAX_WIDTH,
  uiScaleForViewport,
} from "../src/app/files/ui-scale";
import {
  formatSize,
  sortEntries,
  type MobileEntry,
} from "../src/lib/client/mobile-listing";

function entry(
  name: string,
  isFolder: boolean,
  size: number | null = null,
): MobileEntry {
  return { id: name, name, isFolder, size, mimeType: null };
}

// 목록 화면을 따로 두는 근거 자체를 고정한다. 데스크탑을 그대로 축소하면
// 좁은 화면에서 글자가 읽히지 않는다.
test("좁은 화면 기준 아래에서는 데스크탑 배율이 읽을 수 없는 수준으로 떨어진다", () => {
  const phones: [string, number, number][] = [
    ["iPhone SE", 375, 667],
    ["iPhone 14", 390, 844],
    ["Galaxy S", 360, 800],
  ];
  for (const [label, width, height] of phones) {
    assert.ok(
      width < MOBILE_LAYOUT_MAX_WIDTH,
      `${label}은 목록 화면 대상이어야 한다`,
    );
    const scale = uiScaleForViewport(width, height);
    // 11px 글자가 4px 아래로 내려간다.
    assert.ok(scale < 0.4, `${label} 배율이 예상보다 크다: ${scale}`);
  }
});

test("넓은 화면은 데스크탑을 그대로 쓰고 배율도 읽을 만하다", () => {
  for (const [label, width, height] of [
    ["노트북", 1280, 720],
    ["태블릿 가로", 1024, 768],
  ] as [string, number, number][]) {
    assert.ok(
      width >= MOBILE_LAYOUT_MAX_WIDTH,
      `${label}은 데스크탑 대상이어야 한다`,
    );
    assert.ok(uiScaleForViewport(width, height) >= 0.8, `${label} 배율이 낮다`);
  }
});

test("목록은 폴더를 위로 올리고 이름순으로 정렬한다", () => {
  const sorted = sortEntries([
    entry("나중.txt", false, 10),
    entry("하위폴더", true),
    entry("가나다.txt", false, 20),
    entry("가폴더", true),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.name),
    ["가폴더", "하위폴더", "가나다.txt", "나중.txt"],
  );
});

test("정렬은 원본 배열을 바꾸지 않는다", () => {
  const original = [entry("b", false), entry("a", true)];
  const copy = [...original];
  sortEntries(original);
  assert.deepEqual(original, copy);
});

test("크기 표시는 단위를 올려 가며 읽기 쉽게 줄인다", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(1024), "1.0 KB");
  assert.equal(formatSize(1536), "1.5 KB");
  // 열 단위를 넘으면 소수점을 버린다.
  assert.equal(formatSize(1024 * 15), "15 KB");
  assert.equal(formatSize(1024 * 1024), "1.0 MB");
  assert.equal(formatSize(1024 * 1024 * 1024 * 3), "3.0 GB");
  // 폴더처럼 크기를 모르는 항목은 아무것도 붙이지 않는다.
  assert.equal(formatSize(null), "");
  assert.equal(formatSize(-1), "");
  assert.equal(formatSize(Number.NaN), "");
});

test("좁은 화면에서는 데스크탑 대신 목록 화면으로 갈라진다", async () => {
  const source = await readFile(
    new URL("../src/app/files/FilesView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /import MobileFilesView from "\.\/MobileFilesView"/);
  // 훅 순서를 지키려면 모든 훅 뒤, 최종 return 앞에서 갈라져야 한다.
  // 개행이 CRLF일 수 있으므로 공백은 정규식으로 흘린다.
  const branch = source.search(
    /viewport\.width < MOBILE_LAYOUT_MAX_WIDTH/,
  );
  const finalReturn = source.search(/<main\s+className=\{styles\.viewport\}/);
  assert.ok(branch > 0, "모바일 분기를 찾지 못했다");
  assert.ok(finalReturn > 0, "데스크탑 렌더를 찾지 못했다");
  assert.ok(
    branch < finalReturn,
    "모바일 분기는 데스크탑 렌더보다 앞에 있어야 한다",
  );
  assert.match(
    source,
    /viewport\.width > 0 && viewport\.width < MOBILE_LAYOUT_MAX_WIDTH/,
  );
  // 서버 렌더 스냅숏이 1280:720이므로 width가 0일 때 목록으로 새면 안 된다.
  assert.match(source, /<MobileFilesView[\s\S]{0,200}allowUpload=\{allowUpload\}/);
});

test("모바일 목록 화면은 터치에 맞는 크기와 안전 영역을 쓴다", async () => {
  const css = await readFile(
    new URL("../src/app/files/mobile.module.css", import.meta.url),
    "utf8",
  );
  // 터치 대상은 44px 이상 (DESIGN.md: 터치 화면은 comfortable).
  assert.match(css, /\.row\s*\{[^}]*min-height:\s*(4[4-9]|[5-9]\d)px/);
  assert.match(css, /\.dock button\s*\{[^}]*min-height:\s*(4[4-9]|[5-9]\d)px/);
  // 홈 인디케이터에 버튼이 가리지 않게 한다.
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  // 주소창이 접혔다 펴져도 화면이 잘리지 않게 한다.
  assert.match(css, /100dvh/);
});

test("모바일 업로드도 데스크탑과 같은 직행 경로를 쓴다 (#14)", async () => {
  const [mobile, desktop, driveAdapter] = await Promise.all([
    readFile(
      new URL("../src/app/files/MobileFilesView.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/storage/drive.ts", import.meta.url), "utf8"),
  ]);

  // 드라이브 어댑터가 못박은 계약: UI는 업로드 세션을 먼저 받는다. 서버 경유
  // upload 라우트는 API를 직접 호출하는 클라이언트용 폴백이다.
  assert.match(driveAdapter, /UI는 항상 createUploadSession\(direct\)을 쓴다/);
  for (const source of [desktop, mobile]) {
    assert.match(source, /\/api\/drive\/upload-session/);
    assert.match(source, /session\.mode === "direct"/);
    assert.match(source, /startUploadReservationHeartbeat\(/);
    assert.match(source, /\/api\/drive\/upload-complete/);
  }

  // 세션을 건너뛰고 파일 전체를 서버로 POST하면 서버리스 본문 상한에 걸린다.
  assert.doesNotMatch(
    mobile,
    /fetch\(\s*apiPath\(`\/api\/drive\/upload\?/,
    "모바일이 업로드 세션 없이 곧바로 서버로 올리면 안 된다",
  );
  // 폴백(local 모드)에서는 예약 id를 달고 간다.
  assert.match(mobile, /reservationId=\$\{encodeURIComponent\(session\.reservationId\)\}/);

  // 실패하면 개수만 세지 말고 서버가 준 이유를 보여준다.
  assert.match(mobile, /올리지 못했습니다 · \{failures\}/);
  assert.doesNotMatch(mobile, /\{count\}개를 올리지 못했습니다/);
  // 오류는 저절로 사라지지 않고 눌러서 닫는다 — 안 보고 있는 사이에
  // 사라지면 실패한 줄도 모른다.
  assert.match(mobile, /if \(!notice \|\| notice\.kind === "error"\) return;/);
  assert.match(mobile, /onClick=\{\(\) => setNotice\(null\)\}/);
});

test("모바일 업로드는 진행 상황을 실시간으로 보여준다 (#14)", async () => {
  const [mobile, css] = await Promise.all([
    readFile(
      new URL("../src/app/files/MobileFilesView.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/files/mobile.module.css", import.meta.url),
      "utf8",
    ),
  ]);

  // 진행 콜백이 두 업로드 분기(직행·프록시) 모두에 실제로 연결돼야 한다.
  assert.match(mobile, /onProgress: \(sent: number, total: number\) => void/);
  assert.doesNotMatch(
    mobile,
    /uploadWithProgress\([\s\S]{0,200}?\(\) => \{\}/,
    "진행 콜백을 버리면 안 된다",
  );
  // 화면에 파일명·순번·퍼센트가 뜬다.
  assert.match(mobile, /올리는 중 \{current\}\/\{total\}/);
  assert.match(mobile, /\{progress\.percent\}%/);
  assert.match(mobile, /<progress max=\{100\} value=\{progress\.percent\} \/>/);
  assert.match(css, /\.uploadProgress \{/);
});

test("모바일 독의 카메라 버튼은 찍자마자 같은 직행 경로로 올린다 (#15 A-2)", async () => {
  const source = await readFile(
    new URL("../src/app/files/MobileFilesView.tsx", import.meta.url),
    "utf8",
  );

  // capture가 폰에서 카메라를 바로 연다 — 갤러리 경유 3단계를 없앤다.
  assert.match(source, /accept="image\/\*"/);
  assert.match(source, /capture="environment"/);
  assert.match(source, /사진 찍기/);
  // 카메라 입력도 일반 업로드와 같은 uploadFiles(직행 세션·진행 표시)를 탄다.
  const cameraBlock = source.slice(source.indexOf('capture="environment"'));
  assert.match(cameraBlock, /void uploadFiles\(event\.target\.files\)/);
});
