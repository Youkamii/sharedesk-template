import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  badgeFolders,
  capNewBadgeState,
  countNewEntries,
  folderSeenAt,
  foldersDueForCount,
  isNewEntry,
  markFolderSeen,
  MAX_BADGE_FOLDERS,
  MAX_OWN_UPLOADS,
  MAX_SEEN_FOLDERS,
  NEW_BADGE_REFRESH_MS,
  newBadgeStorageKey,
  newBadgeText,
  readNewBadgeState,
  rememberOwnUpload,
  ROOT_SEEN_DELAY_MS,
  writeNewBadgeState,
} from "../src/lib/client/new-badges";

// #16 C-2 — 안 본 새 파일 NEW 배지. 서버 기록 없이 브라우저 localStorage만 쓴다.

const read = (path: string) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const file = (id: string, modifiedAt: string | null, isFolder = false) => ({
  id,
  isFolder,
  modifiedAt,
});

test("저장 키는 데스크 원점·스페이스·사용자로 나뉜다", () => {
  const main = newBadgeStorageKey("https://desk.example.com", null, "a@example.com");
  assert.equal(main, "sharedesk.new-badges.v1|https://desk.example.com|main|a@example.com");
  assert.notEqual(main, newBadgeStorageKey("https://desk.example.com", "sea", "a@example.com"));
  assert.notEqual(main, newBadgeStorageKey("https://other.example.com", null, "a@example.com"));
  // 손님(이메일 없음)은 guest 칸을 쓴다.
  assert.match(newBadgeStorageKey("https://desk.example.com", null, ""), /\|guest$/);
});

test("처음 온 브라우저는 지금이 기준이라 기존 파일은 NEW가 아니다", () => {
  const storage = new MemoryStorage();
  const key = "k";
  const state = readNewBadgeState(storage, key, 1_000);
  assert.deepEqual(state, { since: 1_000, seen: {}, own: [] });
  // 한 번도 연 적 없는 폴더의 기준은 since다.
  assert.equal(folderSeenAt(state, "root"), 1_000);
  assert.equal(isNewEntry(file("a", new Date(999).toISOString()), 1_000, new Set()), false);
  assert.equal(isNewEntry(file("b", new Date(1_001).toISOString()), 1_000, new Set()), true);

  writeNewBadgeState(storage, key, markFolderSeen(state, "root", 5_000));
  const again = readNewBadgeState(storage, key, 9_000);
  assert.equal(again.since, 1_000, "since는 처음 본 시각 그대로");
  assert.equal(folderSeenAt(again, "root"), 5_000);
});

test("깨진 저장값·막힌 저장소는 빈 상태로 시작하고 쓰기 실패를 삼킨다", () => {
  const broken = new MemoryStorage();
  broken.setItem("k", "{not json");
  assert.deepEqual(readNewBadgeState(broken, "k", 7), { since: 7, seen: {}, own: [] });
  broken.setItem("k", JSON.stringify({ since: "x", seen: { a: 1 } }));
  assert.deepEqual(readNewBadgeState(broken, "k", 8), { since: 8, seen: {}, own: [] });
  broken.setItem(
    "k",
    JSON.stringify({ since: 5, seen: { a: 10, b: "x", "": 3 }, own: ["f1", 2, ""] }),
  );
  assert.deepEqual(readNewBadgeState(broken, "k", 9), { since: 5, seen: { a: 10 }, own: ["f1"] });

  assert.deepEqual(readNewBadgeState(null, "k", 3), { since: 3, seen: {}, own: [] });
  const throwing = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("quota");
    },
  };
  assert.deepEqual(readNewBadgeState(throwing, "k", 4), { since: 4, seen: {}, own: [] });
  assert.doesNotThrow(() => writeNewBadgeState(throwing, "k", { since: 4, seen: {}, own: [] }));
  assert.doesNotThrow(() => writeNewBadgeState(null, "k", { since: 4, seen: {}, own: [] }));
});

test("판정: 폴더는 점이 없고, 기준이 없거나 시각을 모르면 NEW가 아니며, 내 업로드는 뺀다", () => {
  const own = new Set(["mine"]);
  const later = new Date(2_000).toISOString();
  assert.equal(isNewEntry(file("x", later), 1_000, own), true);
  assert.equal(isNewEntry(file("x", later, true), 1_000, own), false, "폴더는 배지로 센다");
  assert.equal(isNewEntry(file("x", later), null, own), false, "기준이 아직 없으면 그리지 않는다");
  assert.equal(isNewEntry(file("x", null), 1_000, own), false);
  assert.equal(isNewEntry(file("x", "not-a-date"), 1_000, own), false);
  assert.equal(isNewEntry(file("mine", later), 1_000, own), false, "내가 올린 파일은 NEW가 아니다");
  assert.equal(isNewEntry(file("x", new Date(1_000).toISOString()), 1_000, own), false, "같은 시각은 본 것");
});

test("폴더 집계: 바로 아래 파일 중 NEW 수, 10개부터 9+", () => {
  const children = [
    file("a", new Date(2_000).toISOString()),
    file("b", new Date(3_000).toISOString()),
    file("old", new Date(500).toISOString()),
    file("sub", new Date(4_000).toISOString(), true),
    file("mine", new Date(5_000).toISOString()),
  ];
  assert.equal(countNewEntries(children, 1_000, new Set(["mine"])), 2);
  assert.equal(countNewEntries(children, 2_500, new Set()), 2);
  assert.equal(countNewEntries([], 0, new Set()), 0);

  assert.equal(newBadgeText(0), null);
  assert.equal(newBadgeText(-1), null);
  assert.equal(newBadgeText(Number.NaN), null);
  assert.equal(newBadgeText(1), "1");
  assert.equal(newBadgeText(9), "9");
  assert.equal(newBadgeText(10), "9+");
  assert.equal(newBadgeText(250), "9+");
});

test("폴더를 열면 확인 시각이 앞으로만 간다 — 배지가 사라진다", () => {
  const start = { since: 1_000, seen: {}, own: [] };
  const children = [file("a", new Date(2_000).toISOString())];
  assert.equal(countNewEntries(children, folderSeenAt(start, "F"), new Set()), 1);
  const opened = markFolderSeen(start, "F", 3_000);
  assert.equal(countNewEntries(children, folderSeenAt(opened, "F"), new Set()), 0);
  // 시계가 뒤로 가도 기준은 거꾸로 가지 않는다.
  assert.equal(markFolderSeen(opened, "F", 2_500), opened);
  assert.equal(folderSeenAt(markFolderSeen(opened, "F", 4_000), "F"), 4_000);
  // 다른 폴더는 그대로.
  assert.equal(folderSeenAt(opened, "G"), 1_000);
});

test("기록 상한: 확인 시각은 오래된 것부터, 내 업로드는 앞에서부터 버린다", () => {
  let state = { since: 1, seen: {} as Record<string, number>, own: [] as string[] };
  for (let index = 0; index < MAX_SEEN_FOLDERS + 5; index += 1) {
    state = markFolderSeen(state, `f${index}`, 10 + index);
  }
  assert.equal(Object.keys(state.seen).length, MAX_SEEN_FOLDERS);
  assert.equal(state.seen.f0, undefined, "가장 오래된 확인 기록이 빠진다");
  assert.equal(state.seen[`f${MAX_SEEN_FOLDERS + 4}`], 10 + MAX_SEEN_FOLDERS + 4);

  for (let index = 0; index < MAX_OWN_UPLOADS + 3; index += 1) {
    state = rememberOwnUpload(state, `u${index}`);
  }
  assert.equal(state.own.length, MAX_OWN_UPLOADS);
  assert.equal(state.own[0], "u3");
  assert.equal(rememberOwnUpload(state, "u3"), state, "이미 있으면 그대로");
  assert.equal(rememberOwnUpload(state, ""), state);
  const capped = capNewBadgeState(state);
  assert.equal(capped, state, "상한 안이면 같은 객체");
});

test("배지 대상 폴더: 보이는 순서로 상한까지, 2분 지난 것만 다시 센다", () => {
  const ids = Array.from({ length: MAX_BADGE_FOLDERS + 6 }, (_, index) => `d${index}`);
  assert.equal(badgeFolders([...ids, "d0"]).length, MAX_BADGE_FOLDERS);
  assert.deepEqual(badgeFolders(["a", "b", "a"]), ["a", "b"]);
  const now = 1_000_000;
  const due = foldersDueForCount(
    ["a", "b", "c"],
    { a: now - 1_000, b: now - NEW_BADGE_REFRESH_MS },
    now,
  );
  assert.deepEqual(due, ["b", "c"]);
  assert.deepEqual(foldersDueForCount(["a", "b"], {}, now, 1), ["a"]);
  assert.equal(ROOT_SEEN_DELAY_MS, 10_000);
  assert.equal(NEW_BADGE_REFRESH_MS, 120_000);
});

test("배선: 데스크 화면 — 확인 시각 저장·창 기준·폴더 배지·내 업로드 (#16 C-2)", async () => {
  const view = await read("src/app/files/FilesView.tsx");

  // 저장 열쇠는 원점·스페이스·사용자, 처음 읽은 상태를 곧바로 저장해 since를 남긴다.
  assert.match(
    view,
    /newBadgeStorageKey\(\s*window\.location\.origin,\s*spaceSlugFromPathname\(window\.location\.pathname\),\s*userEmail,\s*\)/,
  );
  assert.match(view, /writeNewBadgeState\(storage, key, state\);/);
  // 루트는 첫 목록이 뜬 뒤 10초 머물러야 본 것.
  assert.match(
    view,
    /window\.setTimeout\(\(\) => \{\s*fired = true;\s*updateNewBadges\(\(state\) => markFolderSeen\(state, ROOT_ID, listedAt\)\);\s*\}, ROOT_SEEN_DELAY_MS\)/,
  );
  // 창은 처음 뜬 목록에서 이전 기준을 잡고 지금을 확인 시각으로 남긴다.
  assert.match(view, /opened\[item\.id\] = \{ folderId, at: folderSeenAt\(state, folderId\) \};/);
  assert.match(view, /markFolderSeen\(next, folderId, now\)/);
  // 폴더 배지는 배치 저장이 없는 가벼운 목록으로 센다.
  assert.match(view, /\/api\/drive\/list\?folderId=\$\{encodeURIComponent\(folderId\)\}&layout=0/);
  assert.match(view, /foldersDueForCount\(folderIds, fetchedAt, Date\.now\(\)\)/);
  // 아이콘: 파일 점과 폴더 배지, 버튼 이름에도 싣는다.
  assert.match(view, /const isNew = isNewEntry\(entry, newBaseline, ownUploadIds\);/);
  assert.match(
    view,
    /countNewEntries\(\s*badgeChildEntries\(entry\.id\),\s*folderSeenAt\(newBadges, entry\.id\),\s*ownUploadIds,\s*\)/,
  );
  assert.match(view, /\{isNew && \(\s*<span className=\{styles\.newDot\} aria-hidden="true" \/>/);
  assert.match(view, /<span className=\{styles\.newCount\} aria-hidden="true">\s*\{newCountText\}/);
  assert.match(view, /t\("새 파일 \{count\}개", \{ count: newCount \}\)/);
  // 내가 올리거나 고친 파일은 NEW에서 뺀다.
  assert.match(view, /const uploadedId = body\?\.entry\?\.id \?\? null;\s*markOwnUpload\(uploadedId\);/);
  assert.match(view, /markOwnUpload\(await flow\.resume\(record, file, updateTransfer\)\);/);
  assert.match(view, /markOwnUpload\(result\.entry\.id\);/);
  // 서버 기록은 없다 — 배지 상태를 서버로 보내지 않는다.
  assert.doesNotMatch(view, /api\/[a-z/-]*new-badge/);

  const css = await read("src/app/files/desktop.module.css");
  assert.match(css, /\.newDot \{[^}]*background: #ffd27d;[^}]*border: 2px solid #10172b;/);
  assert.match(css, /\.newCount \{/);
  assert.match(css, /\.iconGlyph \{[^}]*position: relative;/);
});

test("배선: 가벼운 목록(layout=0)은 배치를 읽거나 쓰지 않고 항목만 준다 (#16 C-2)", async () => {
  const route = await read("src/app/api/drive/list/route.ts");
  assert.match(
    route,
    /searchParams\.get\("layout"\) === "0"\) \{\s*return NextResponse\.json\(\{ entries: await getAdapter\(\)\.list\(folderId\) \}\);/,
  );
  // 기본 목록은 그대로 배치와 함께.
  assert.match(route, /getFolderListingWithLayout\(folderId\)/);
  assert.match(route, /runWithSession\(null,/);
});

test("배선: 위젯 서랍도 같은 규칙으로 파일 점을 그린다 (#16 C-2)", async () => {
  const widget = await read("src/app/widget/WidgetView.tsx");
  assert.match(widget, /from "@\/lib\/client\/new-badges"/);
  assert.match(widget, /setNewBaseline\(\{ folderId, at: folderSeenAt\(state, folderId\) \}\);/);
  assert.match(widget, /markFolderSeen\(current, ROOT_ID, listedAt\)\),\s*ROOT_SEEN_DELAY_MS/);
  assert.match(widget, /\{isNew && <span className=\{styles\.newDot\} aria-hidden="true" \/>\}/);
  assert.match(widget, /if \(uploadedId\) updateNewBadges\(\(state\) => rememberOwnUpload\(state, uploadedId\)\);/);
  const page = await read("src/app/files/page.tsx");
  assert.match(page, /<WidgetView\s+userName=\{session\.name\}\s+userEmail=\{session\.email\}/);
});

test("i18n: 배지 문구가 네 사전에 있다 (#16 C-2)", async () => {
  const [{ EN_FILES }, { JA }, { HI }, { ZH }] = await Promise.all([
    import("../src/lib/i18n-en-files"),
    import("../src/lib/i18n-ja"),
    import("../src/lib/i18n-hi"),
    import("../src/lib/i18n-zh"),
  ]);
  for (const key of ["새 파일", "새 파일 {count}개"]) {
    for (const [name, dictionary] of Object.entries({ EN_FILES, JA, HI, ZH })) {
      assert.ok(key in dictionary, `${name} 사전에 없는 키 — ${key}`);
    }
  }
});
