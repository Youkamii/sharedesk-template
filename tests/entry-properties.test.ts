import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relative: string) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

test("업로드는 항목별 내력에도 올린 사람을 남긴다 (#14)", async () => {
  const [upload, importRoute] = await Promise.all([
    read("src/app/api/drive/upload/route.ts"),
    read("src/app/api/drive/import/route.ts"),
  ]);

  for (const source of [upload, importRoute]) {
    assert.match(
      source,
      /recordEntryUploadAfter\(entry\.layoutKey, session\.name\)/,
      "activity.json은 최근 200건뿐이라 항목별 기록이 따로 있어야 한다",
    );
  }
});

test("내려받기 기록은 통짜 다운로드만 센다 (#14)", async () => {
  const source = await read("src/app/api/drive/download/route.ts");

  // 미리보기(inline)는 열람이고, 범위 요청은 한 번의 내려받기가 쪼개진 것이다.
  assert.match(source, /if \(!wantsInline && !range\) \{/);
  assert.match(
    source,
    /recordEntryDownloadAfter\(entry\.layoutKey, session\.name\)/,
  );
});

test("공개 링크로 받아 간 것도 기록하되 방문자로 표시한다 (#14 10)", async () => {
  const source = await read(
    "src/app/api/public-folder/[token]/download/route.ts",
  );

  assert.match(source, /if \(!open && !range\) \{/);
  assert.match(
    source,
    /recordEntryDownloadAfter\(\s*entry\.layoutKey,\s*resolved\.folder\.name,\s*true,?\s*\)/,
  );
});

test("내려받기 기록은 관리자에게만 나간다 (#14)", async () => {
  const source = await read("src/app/api/drive/properties/route.ts");

  assert.match(source, /const admin = session\.role === "admin"/);
  assert.match(source, /downloadCount: admin \? \(audit\?\.downloadCount \?\? 0\) : null/);
  assert.match(source, /downloads: admin \? \(audit\?\.downloads \?\? \[\]\) : null/);
  // 올린 사람은 누구나 본다 — 데스크 참여자끼리의 최소 정보다.
  assert.match(source, /uploadedBy: audit\?\.uploadedBy \?\? null/);
});

test("속성 메뉴는 항목 메뉴와 검색 결과 메뉴 양쪽에 있다 (#14)", async () => {
  const source = await read("src/app/files/FilesView.tsx");

  assert.match(
    source,
    /openProperties\(\s*contextMenu\.entry!,\s*scopeAddress\(contextMenu\.scopeId, contextMenu\.entry!\),\s*\)/,
  );
  // 검색 결과는 지금 창이 아니라 원래 위치가 주소다.
  assert.match(
    source,
    /openProperties\(\s*contextMenu\.searchResult!\.entry,[\s\S]*?addressFor\(\s*contextMenu\.searchResult!\.breadcrumbs,/,
  );
  assert.match(source, /styles\.propertiesDialog/);
});
