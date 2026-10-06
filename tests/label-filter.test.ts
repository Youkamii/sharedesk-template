import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  filterEntriesByLabel,
  labelColorsInUse,
  nextLabelFilter,
} from "../src/lib/client/label-filter";
import type { FolderColorId } from "../src/lib/folder-color-ids";

// #16 C-7 — 파일 색 라벨과 폴더 창 라벨 필터.

const read = (path: string) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

const entries = [
  { layoutKey: "folder-red", isFolder: true },
  { layoutKey: "folder-green", isFolder: true },
  { layoutKey: "file-red", isFolder: false },
  { layoutKey: "file-blue", isFolder: false },
  { layoutKey: "file-plain", isFolder: false },
];
const colors: Record<string, FolderColorId> = {
  "folder-red": "red",
  "folder-green": "green",
  "file-red": "red",
  "file-blue": "blue",
  "elsewhere": "violet",
};

test("필터: 고른 색의 항목만(파일·폴더 함께), 필터가 없으면 그대로", () => {
  assert.equal(filterEntriesByLabel(entries, colors, null), entries);
  assert.deepEqual(
    filterEntriesByLabel(entries, colors, "red").map((entry) => entry.layoutKey),
    ["folder-red", "file-red"],
  );
  assert.deepEqual(filterEntriesByLabel(entries, colors, "violet"), []);
});

test("칩: 이 목록의 파일 라벨 색만 — 색 입힌 하위 폴더만 있으면 칩 줄이 없다", () => {
  // green은 폴더에만 있어 칩이 없고, 다른 폴더의 색(violet)도 없다.
  assert.deepEqual(labelColorsInUse(entries, colors), ["red", "blue"]);
  assert.deepEqual(
    labelColorsInUse(entries.filter((entry) => entry.isFolder), colors),
    [],
    "#14 폴더 색만 쓰는 사용자의 창 모양은 그대로",
  );
  // 고른 색은 비어도 남긴다(해제할 수 있게).
  assert.deepEqual(labelColorsInUse(entries, colors, "violet"), ["red", "blue", "violet"]);
  assert.deepEqual(labelColorsInUse([], colors), []);
});

test("칩 누르기: 다른 색은 바꾸고, 같은 색을 다시 누르거나 모두면 해제", () => {
  assert.equal(nextLabelFilter(null, "red"), "red");
  assert.equal(nextLabelFilter("red", "blue"), "blue");
  assert.equal(nextLabelFilter("red", "red"), null);
  assert.equal(nextLabelFilter("red", null), null);
});

test("배선: 파일 우클릭 메뉴는 라벨 색, 아이콘에 색 띠, 폴더 창에 라벨 필터 칩 (#16 C-7)", async () => {
  const view = await read("src/app/files/FilesView.tsx");

  // 같은 스와치 줄이 파일에도 열리고, 이름은 폴더면 폴더 색·파일이면 라벨 색.
  assert.match(view, /allowUpload && contextMenu\.entry && \(\s*<div\s+className=\{styles\.colorSwatchRow\}/);
  assert.match(view, /t\("폴더 색"\) : t\("라벨 색"\)/);
  assert.match(view, /t\("라벨 색을 저장하지 못했습니다"\)/);

  // 파일 아이콘의 색 띠(폴더는 아이콘 자체가 그 색)와 버튼 이름.
  assert.match(view, /className=\{styles\.colorLabel\}\s*data-color=/);
  assert.match(view, /t\("라벨 색"\)\} \$\{t\(FOLDER_COLOR_LABELS\[/);

  // 폴더 창: 칩 줄(모두 + 색 칩, aria-pressed). 필터 상태는 창(DeskWindow)에 있어 창을 닫으면
  // 사라지고, 폴더를 옮기는 세 자리(+ 창 생성)에서 비운다.
  assert.match(view, /labelColorsInUse\(/);
  assert.match(view, /role="group"\s+aria-label=\{t\("라벨로 거르기"\)\}/);
  assert.match(view, /\{t\("모두"\)\}/);
  assert.match(view, /aria-pressed=\{labelFilter === null\}/);
  assert.match(view, /aria-pressed=\{labelFilter === color\}/);
  assert.match(view, /labelFilter: FolderColorId \| null;/);
  assert.equal(view.match(/labelFilter: null,/g)?.length, 4, "창 생성 + 폴더를 옮기는 세 자리");

  // 캔버스·옆 미리보기는 보이는 항목만 — 숨는 항목을 미리 보던 중이면 미리보기를 닫는다.
  assert.match(view, /function windowVisibleEntries\(item: DeskWindow\)/);
  const preview = view.slice(view.indexOf("function moveFolderSidePreview"), view.indexOf("function openPreviewInScope"));
  assert.match(preview, /windowVisibleEntries\(item\)/);
  assert.doesNotMatch(preview, /item\.data\.entries/);
  assert.match(view, /folderImagePreviewEntries\(visibleEntries\)/);
  const press = view.slice(view.indexOf("function pressLabelFilter"), view.indexOf("async function applyFolderColor"));
  assert.match(press, /sidePreviewLayoutKey: keepPreview \? item\.sidePreviewLayoutKey : null/);
  assert.match(view, /if \(visibleKeys && !visibleKeys\.has\(entry\.layoutKey\)\) return null;/);
  assert.match(view, /startSelectionRectangle\(event, scopeId, visibleEntries\)/);

  // 우클릭 메뉴 높이에 색 줄(파일·폴더 모두)을 넣는다 — 화면 아래에서 메뉴가 잘리지 않게.
  const height = view.slice(view.indexOf("function itemContextMenuHeight"), view.indexOf("function desktopContextMenuHeight"));
  assert.match(height, /colorRow \? COLOR_SWATCH_ROW_HEIGHT : 0/);
  assert.equal(
    view.match(/itemContextMenuHeight\(\s*(?:current\.)?entry,[\s\S]*?allowUpload,?\s*\)/g)?.length,
    2,
    "두 호출 모두 색 줄 여부(올릴 수 있는 역할)를 넘긴다",
  );

  // 7색은 data-color 한 벌로 스와치·라벨 띠·칩이 함께 쓴다.
  const css = await read("src/app/files/desktop.module.css");
  assert.doesNotMatch(css, /data-label/);
  assert.doesNotMatch(view, /data-label=/);
  for (const color of ["red", "orange", "yellow", "green", "blue", "indigo", "violet"]) {
    assert.equal(
      css.match(new RegExp(`\\[data-color="${color}"\\]`, "g"))?.length,
      1,
      `${color}는 한 번만 정의한다`,
    );
  }
  assert.match(css, /:is\(\.colorSwatch, \.colorLabel, \.labelChipSwatch\)\[data-color="red"\]/);
  assert.match(css, /\.folderWindowWithLabels \{\s*grid-template-rows:/);
  assert.match(css, /\.colorLabel \{/);
});

test("배선: 색 라우트는 파일도 받고, 권한은 폴더 색과 같다 (#16 C-7)", async () => {
  const route = await read("src/app/api/desktop/folder-color/route.ts");
  assert.match(route, /runWithUploadRights\(/);
  assert.doesNotMatch(route, /entry\.isFolder/);
  assert.match(route, /getAdapter\(\)\.getEntry\(body\.id\)/);
  assert.match(route, /setFolderColor\(entry\.layoutKey, color\)/);
});

test("i18n: 라벨 문구가 네 사전에 있고 죽은 폴더 전용 문구는 없다 (#16 C-7)", async () => {
  const [{ EN_FILES }, { JA }, { HI }, { ZH }] = await Promise.all([
    import("../src/lib/i18n-en-files"),
    import("../src/lib/i18n-ja"),
    import("../src/lib/i18n-hi"),
    import("../src/lib/i18n-zh"),
  ]);
  for (const [name, dictionary] of Object.entries({ EN_FILES, JA, HI, ZH })) {
    for (const key of ["라벨 색", "라벨로 거르기", "모두", "라벨 색을 저장하지 못했습니다"]) {
      assert.ok(key in dictionary, `${name} 사전에 없는 키 — ${key}`);
    }
    assert.ok(!("폴더에만 색을 지정할 수 있습니다" in dictionary), `${name}: 쓰지 않는 문구`);
  }
});
