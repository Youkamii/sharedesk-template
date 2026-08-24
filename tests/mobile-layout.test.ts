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
