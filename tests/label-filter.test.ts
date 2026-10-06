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
  { layoutKey: "folder-red", name: "빨간 폴더" },
  { layoutKey: "file-red", name: "a.txt" },
  { layoutKey: "file-blue", name: "b.txt" },
  { layoutKey: "file-plain", name: "c.txt" },
];
const colors: Record<string, FolderColorId> = {
  "folder-red": "red",
  "file-red": "red",
  "file-blue": "blue",
  "elsewhere": "green",
};

test("필터: 고른 색의 항목만(파일·폴더 함께), 필터가 없으면 그대로", () => {
  assert.equal(filterEntriesByLabel(entries, colors, null), entries);
  assert.deepEqual(
    filterEntriesByLabel(entries, colors, "red").map((entry) => entry.layoutKey),
    ["folder-red", "file-red"],
  );
  assert.deepEqual(
    filterEntriesByLabel(entries, colors, "blue").map((entry) => entry.layoutKey),
    ["file-blue"],
  );
  assert.deepEqual(filterEntriesByLabel(entries, colors, "violet"), []);
});

test("칩: 이 목록에서 쓰이는 색만 팔레트 순서로, 고른 색은 비어도 남긴다", () => {
  // 다른 폴더의 색(green)은 이 창의 칩에 나오지 않는다.
  assert.deepEqual(labelColorsInUse(entries, colors), ["red", "blue"]);
  assert.deepEqual(labelColorsInUse(entries, colors, "violet"), ["red", "blue", "violet"]);
  assert.deepEqual(labelColorsInUse([], colors), []);
  assert.deepEqual(labelColorsInUse([{ layoutKey: "file-blue" }, { layoutKey: "folder-red" }], colors), [
    "red",
    "blue",
  ]);
});

test("칩 누르기: 다른 색은 바꾸고, 같은 색을 다시 누르거나 모두면 해제", () => {
  assert.equal(nextLabelFilter(null, "red"), "red");
  assert.equal(nextLabelFilter("red", "blue"), "blue");
  assert.equal(nextLabelFilter("red", "red"), null);
  assert.equal(nextLabelFilter("red", null), null);
  assert.equal(nextLabelFilter(null, null), null);
});

test("배선: 파일 우클릭 메뉴는 라벨 색, 아이콘에 색 띠, 폴더 창에 라벨 필터 칩 (#16 C-7)", async () => {
  const view = await read("src/app/files/FilesView.tsx");

  // 같은 스와치 줄이 파일에도 열리고, 이름은 폴더면 폴더 색·파일이면 라벨 색.
  assert.match(view, /\{allowUpload && contextMenu\.entry && \(\s*<div\s+className=\{styles\.colorSwatchRow\}/);
  assert.match(view, /contextMenu\.entry\.isFolder \? t\("폴더 색"\) : t\("라벨 색"\)/);
  assert.doesNotMatch(view, /allowUpload && contextMenu\.entry\?\.isFolder && \(/);
  assert.match(view, /t\("라벨 색을 저장하지 못했습니다"\)/);

  // 파일 아이콘의 색 띠와 버튼 이름.
  assert.match(view, /const fileLabel = entry\.isFolder\s*\? null\s*: \(folderColors\[entry\.layoutKey\] \?\? null\);/);
  assert.match(view, /className=\{styles\.colorLabel\}\s*data-label=\{fileLabel\}/);
  assert.match(view, /t\("라벨 색"\)\} \$\{t\(FOLDER_COLOR_LABELS\[fileLabel\]\)\}/);

  // 폴더 창: 쓰이는 색이 있을 때만 칩 줄, 모두 + 색 칩(aria-pressed), 창마다 따로인 상태.
  assert.match(view, /labelColorsInUse\(\s*item\.data\.entries,\s*folderColors,\s*labelFilter,\s*\)/);
  assert.match(view, /\{labelColors\.length > 0 && \(\s*<div\s+className=\{styles\.labelFilterRow\}\s+role="group"\s+aria-label=\{t\("라벨로 거르기"\)\}/);
  assert.match(view, /aria-pressed=\{labelFilter === null\}\s+onClick=\{\(\) => pressLabelFilter\(item\.id, null\)\}/);
  assert.match(view, /\{t\("모두"\)\}/);
  assert.match(view, /aria-pressed=\{labelFilter === color\}\s+onClick=\{\(\) => pressLabelFilter\(item\.id, color\)\}/);
  assert.match(view, /useState<\s*Record<string, \{ folderId: string; color: FolderColorId \}>\s*>\(\{\}\)/);
  assert.match(view, /filter && filter\.folderId === scopeFolderId\(scopeId\)/, "다른 폴더로 넘어가면 적용하지 않는다");

  // 캔버스: 폴더 창에서만 거르고, 숨긴 항목은 자리를 지키며 선택에도 걸리지 않는다.
  assert.match(view, /const labelFilter = isRoot \? null : windowLabelFilter\(scopeId\);/);
  assert.match(view, /if \(visibleKeys && !visibleKeys\.has\(entry\.layoutKey\)\) return null;\s*const position = placementFor\(scopeId, entry, index\);/);
  assert.match(view, /startSelectionRectangle\(event, scopeId, visibleEntries\)/);
  assert.match(view, /moveIconSelectionWithKeyboard\(\s*event,\s*scopeId,\s*visibleEntries,\s*entry,\s*\)/);
  assert.match(view, /selectIconFromClick\(\s*scopeId,\s*visibleEntries,/);

  const css = await read("src/app/files/desktop.module.css");
  assert.match(css, /\.folderWindow\.folderWindowWithLabels \{\s*grid-template-rows: 32px 42px 30px minmax\(0, 1fr\) 24px;/);
  assert.match(css, /\.colorLabel \{[^}]*height: 4px;/);
  for (const color of ["red", "orange", "yellow", "green", "blue", "indigo", "violet"]) {
    assert.match(css, new RegExp(`:is\\(\\.colorLabel, \\.labelChipSwatch\\)\\[data-label="${color}"\\]`));
  }
});

test("배선: 색 라우트는 파일도 받고, 권한은 폴더 색과 같다 (#16 C-7)", async () => {
  const route = await read("src/app/api/desktop/folder-color/route.ts");
  assert.match(route, /runWithUploadRights\(\{ fresh: true \}/);
  assert.doesNotMatch(route, /entry\.isFolder/);
  assert.doesNotMatch(route, /폴더에만 색을 지정할 수 있습니다/);
  assert.match(route, /const entry = await getAdapter\(\)\.getEntry\(body\.id\);\s*const colors = await setFolderColor\(entry\.layoutKey, color\);/);
});

test("i18n: 라벨 문구가 네 사전에 있다 (#16 C-7)", async () => {
  const [{ EN_FILES }, { JA }, { HI }, { ZH }] = await Promise.all([
    import("../src/lib/i18n-en-files"),
    import("../src/lib/i18n-ja"),
    import("../src/lib/i18n-hi"),
    import("../src/lib/i18n-zh"),
  ]);
  for (const key of ["라벨 색", "라벨로 거르기", "모두", "라벨 색을 저장하지 못했습니다"]) {
    for (const [name, dictionary] of Object.entries({ EN_FILES, JA, HI, ZH })) {
      assert.ok(key in dictionary, `${name} 사전에 없는 키 — ${key}`);
    }
  }
});
