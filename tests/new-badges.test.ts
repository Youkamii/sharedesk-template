import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  badgeFolders,
  clearNewBadgeStores,
  countNewEntries,
  folderSeenAt,
  foldersDueForCount,
  isNewEntry,
  listStamp,
  markFolderSeen,
  MAX_BADGE_FOLDERS,
  MAX_OWN_UPLOADS,
  MAX_SEEN_FOLDERS,
  NEW_BADGE_REFRESH_MS,
  newBadgeStorageKey,
  newBadgeText,
  observeList,
  openNewBadgeStore,
  ownUploadIndex,
  parseNewBadgeState,
  pruneBadgeCache,
  rememberOwnUpload,
  settleOwnUploads,
  type NewBadgeState,
} from "../src/lib/client/new-badges";

// #16 C-2 — 안 본 새 파일 NEW 배지. 서버 기록 없이 브라우저 localStorage만, 시각은 서버 시각만.

const read = (path: string) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

class MemoryStorage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

const at = (ms: number) => new Date(ms).toISOString();
const file = (id: string, modified: number | null, isFolder = false) => ({
  id,
  isFolder,
  modifiedAt: modified === null ? null : at(modified),
});
const empty = (): NewBadgeState => ({ since: null, seen: {}, own: [] });
const NONE = ownUploadIndex(null);

test("저장 키는 데스크 원점·스페이스·사용자로 나뉜다", () => {
  const main = newBadgeStorageKey("https://desk.example.com", null, "a@example.com");
  assert.equal(main, "sharedesk.new-badges.v1|https://desk.example.com|main|a@example.com");
  assert.notEqual(main, newBadgeStorageKey("https://desk.example.com", "sea", "a@example.com"));
  assert.notEqual(main, newBadgeStorageKey("https://other.example.com", null, "a@example.com"));
  assert.match(newBadgeStorageKey("https://desk.example.com", null, ""), /\|guest$/);
});

test("도장은 목록의 최대 modifiedAt — 시각이 없으면 null", () => {
  assert.equal(listStamp([file("a", 10), file("b", 30), file("c", 20)]), 30);
  assert.equal(listStamp([file("a", null)]), null);
  assert.equal(listStamp([]), null);
  assert.equal(listStamp([{ modifiedAt: "not-a-date" }]), null);
});

test("처음 받은 목록의 도장이 since — 처음 온 브라우저에서는 기존 파일이 NEW가 아니다", () => {
  const first = observeList(empty(), [file("a", 1_000), file("b", 2_000)]);
  assert.equal(first.since, 2_000);
  assert.equal(folderSeenAt(first, "root"), 2_000);
  assert.equal(isNewEntry(file("b", 2_000), folderSeenAt(first, "root"), NONE), false);
  assert.equal(isNewEntry(file("c", 2_001), folderSeenAt(first, "root"), NONE), true);
  // since는 한 번 정하면 바뀌지 않는다.
  assert.equal(observeList(first, [file("z", 9_999)]).since, 2_000);
  assert.equal(observeList(first, [file("z", 9_999)]), first, "바뀐 게 없으면 같은 객체");
  // 빈 데스크면 0 — 그 뒤 올라오는 것은 모두 NEW.
  assert.equal(observeList(empty(), []).since, 0);
  // 아직 아무 목록도 못 봤으면 기준이 없다(점을 그리지 않는다).
  assert.equal(folderSeenAt(empty(), "root"), null);
});

test("확인 기준은 목록의 도장까지만 오르고 내려가지 않는다", () => {
  const base = observeList(empty(), [file("a", 1_000)]);
  const seen = markFolderSeen(base, "F", [file("x", 5_000), file("y", 4_000)]);
  assert.equal(folderSeenAt(seen, "F"), 5_000);
  assert.equal(markFolderSeen(seen, "F", [file("old", 3_000)]), seen, "옛 목록으로 내려가지 않는다");
  assert.equal(markFolderSeen(seen, "F", []), seen, "시각 없는 목록은 그대로");
  assert.equal(folderSeenAt(markFolderSeen(seen, "F", [file("n", 6_000)]), "F"), 6_000);
  // 본 기록이 since보다 이르면 since가 기준이다(처음 온 순간의 내용은 새것이 아니다).
  const early = markFolderSeen(observeList(empty(), [file("r", 8_000)]), "G", [file("g", 2_000)]);
  assert.equal(folderSeenAt(early, "G"), 8_000);
  // 다른 폴더는 since.
  assert.equal(folderSeenAt(seen, "other"), 1_000);
});

test("브라우저 시계가 2시간 빠르거나 느려도 판정이 같다", () => {
  // 서버 시각만 쓰는 시나리오 — 첫 방문, 루트 확인, 남의 업로드, 내 업로드, 폴더 열기.
  const scenario = () => {
    let state = observeList(empty(), [file("old", 1_000), file("folder", 1_500, true)]);
    state = markFolderSeen(state, "root", [file("old", 1_000)]);
    state = rememberOwnUpload(state, "mine", 3_000);
    const root = [file("old", 1_000), file("theirs", 2_500), file("mine", 3_000)];
    const folder = [file("f1", 1_200), file("f2", 2_800)];
    const before = folderSeenAt(state, "folder");
    const own = ownUploadIndex(state);
    const result = {
      dots: root.map((entry) => isNewEntry(entry, folderSeenAt(state, "root"), own)),
      badge: countNewEntries(folder, before, own),
    };
    state = markFolderSeen(state, "folder", folder);
    return { ...result, after: countNewEntries(folder, folderSeenAt(state, "folder"), own), state };
  };
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 2 * 60 * 60 * 1000;
    const fast = scenario();
    Date.now = () => realNow() - 2 * 60 * 60 * 1000;
    const slow = scenario();
    Date.now = realNow;
    const normal = scenario();
    assert.deepEqual(fast, normal);
    assert.deepEqual(slow, normal);
    assert.deepEqual(normal.dots, [false, true, false]);
    assert.equal(normal.badge, 1);
    assert.equal(normal.after, 0);
  } finally {
    Date.now = realNow;
  }
});

test("NEW 판정 모듈은 브라우저 시계를 읽지 않는다", async () => {
  const source = await read("src/lib/client/new-badges.ts");
  const code = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(code, /Date\.now\(|new Date\(\s*\)|performance\.now\(/);
});

test("내 업로드는 그 버전까지만 NEW에서 빠지고, 남이 다시 고치면 다시 NEW", () => {
  let state = observeList(empty(), [file("a", 1_000)]);
  state = rememberOwnUpload(state, "doc", 5_000);
  let own = ownUploadIndex(state);
  assert.equal(isNewEntry(file("doc", 5_000), 1_000, own), false, "내가 올린 버전");
  assert.equal(isNewEntry(file("doc", 6_000), 1_000, own), true, "그 뒤 누가 고쳤다");
  assert.equal(isNewEntry(file("doc", 6_000), 6_000, own), false, "그 수정도 이미 봤다");
  // 다시 내가 고치면 새 시각으로 바뀐다.
  state = rememberOwnUpload(state, "doc", 6_000);
  own = ownUploadIndex(state);
  assert.equal(isNewEntry(file("doc", 6_000), 1_000, own), false);
  assert.equal(state.own.length, 1);
  // 시각을 모르는 업로드(직행)는 NEW가 아니고, 목록에서 처음 본 시각으로 채운다.
  state = rememberOwnUpload(state, "direct", null);
  assert.equal(isNewEntry(file("direct", 7_000), 1_000, ownUploadIndex(state)), false);
  const settled = settleOwnUploads(state, [file("direct", 7_000), file("other", 9_000)]);
  assert.deepEqual(settled.own.find((record) => record.id === "direct"), { id: "direct", at: 7_000 });
  assert.equal(isNewEntry(file("direct", 8_000), 1_000, ownUploadIndex(settled)), true);
  assert.equal(settleOwnUploads(settled, [file("direct", 8_000)]), settled, "이미 채운 시각은 바꾸지 않는다");
  assert.equal(rememberOwnUpload(settled, "", 1), settled);
});

test("폴더 집계: 바로 아래 파일 중 NEW 수, 10개부터 9+", () => {
  const own = ownUploadIndex(rememberOwnUpload(empty(), "mine", 5_000));
  const children = [
    file("a", 2_000),
    file("b", 3_000),
    file("old", 500),
    file("sub", 4_000, true),
    file("mine", 5_000),
  ];
  assert.equal(countNewEntries(children, 1_000, own), 2);
  assert.equal(countNewEntries(children, null, own), 0, "기준이 없으면 세지 않는다");
  assert.equal(newBadgeText(0), null);
  assert.equal(newBadgeText(Number.NaN), null);
  assert.equal(newBadgeText(9), "9");
  assert.equal(newBadgeText(10), "9+");
});

test("저장소 헬퍼: 다른 탭이 쓴 값 위에 바꾸고, 같으면 같은 객체, 막혀도 탭 안에서는 기억한다", () => {
  const storage = new MemoryStorage();
  const store = openNewBadgeStore("k", storage);
  const first = store.update((state) => observeList(state, [file("a", 1_000)]));
  assert.equal(first.since, 1_000);
  assert.equal(store.update((state) => state), first, "바뀐 게 없으면 같은 객체");
  assert.equal(store.read(), first);
  // 다른 탭이 저장한 값을 읽어 그 위에 바꾼다.
  const otherTab = openNewBadgeStore("k", storage);
  otherTab.update((state) => markFolderSeen(state, "F", [file("x", 2_000)]));
  const merged = store.update((state) => rememberOwnUpload(state, "u", 3_000));
  assert.equal(merged.seen.F, 2_000);
  assert.equal(merged.own[0].id, "u");
  assert.deepEqual(parseNewBadgeState(storage.getItem("k")), merged);

  const blocked = {
    getItem(): string | null {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("quota");
    },
  };
  const memoryOnly = openNewBadgeStore("k", blocked);
  memoryOnly.update((state) => observeList(state, [file("a", 4_000)]));
  assert.equal(memoryOnly.read().since, 4_000, "이 탭에서는 기억한다");
  const noStorage = openNewBadgeStore("k", null);
  noStorage.update((state) => observeList(state, [file("a", 5_000)]));
  assert.equal(noStorage.read().since, 5_000);
});

test("깨진 저장값은 빈 상태, 옛 형식(문자열 own)도 읽는다", () => {
  assert.deepEqual(parseNewBadgeState("{not json"), empty());
  assert.deepEqual(parseNewBadgeState(null), empty());
  assert.deepEqual(
    parseNewBadgeState(JSON.stringify({ since: "x", seen: { a: 10, b: "x", "": 3 }, own: ["f1", 2, "", { id: "f2", at: 7 }] })),
    { since: null, seen: { a: 10 }, own: [{ id: "f2", at: 7 }] },
  );
});

test("기록 상한: 확인 기록은 오래된 것부터, 내 업로드는 앞에서부터 버린다", () => {
  const store = openNewBadgeStore("k", new MemoryStorage());
  let state = store.read();
  for (let index = 0; index < MAX_SEEN_FOLDERS + 5; index += 1) {
    state = markFolderSeen(state, `f${index}`, [file("x", 10 + index)]);
  }
  for (let index = 0; index < MAX_OWN_UPLOADS + 3; index += 1) {
    state = rememberOwnUpload(state, `u${index}`, index);
  }
  const capped = store.update(() => state);
  assert.equal(Object.keys(capped.seen).length, MAX_SEEN_FOLDERS);
  assert.equal(capped.seen.f0, undefined);
  assert.equal(capped.own.length, MAX_OWN_UPLOADS);
  assert.equal(capped.own[0].id, "u3");
});

test("로그아웃: 이 브라우저의 NEW 배지 기록만 모두 지운다", () => {
  const storage = new MemoryStorage();
  storage.setItem(newBadgeStorageKey("https://a.example", null, "a@example.com"), "{}");
  storage.setItem(newBadgeStorageKey("https://a.example", "sea", "b@example.com"), "{}");
  storage.setItem("sharedesk.wallpaper", "dusk");
  storage.setItem("sharedesk.new-badges.v1-not-mine", "x");
  assert.equal(clearNewBadgeStores(storage), 2);
  assert.deepEqual([...storage.values.keys()], ["sharedesk.wallpaper", "sharedesk.new-badges.v1-not-mine"]);
  assert.equal(clearNewBadgeStores(null), 0);
});

test("배지 대상: 보이는 순서로, 창으로 열린 폴더는 빼고 상한까지 · 2분 지난 것만 다시 · 빠진 폴더 캐시는 버린다", () => {
  const ids = Array.from({ length: MAX_BADGE_FOLDERS + 6 }, (_, index) => `d${index}`);
  assert.equal(badgeFolders([...ids, "d0"]).length, MAX_BADGE_FOLDERS);
  assert.deepEqual(badgeFolders(["a", "b", "a", "c"], new Set(["b"])), ["a", "c"]);
  const now = 1_000_000;
  assert.deepEqual(
    foldersDueForCount(["a", "b", "c"], { a: now - 1_000, b: now - NEW_BADGE_REFRESH_MS }, now),
    ["b", "c"],
  );
  // 30초 확인의 4번째 차례가 조금 이르게 와도 그 차례에 다시 센다(2분 주기 유지).
  assert.deepEqual(foldersDueForCount(["a"], { a: now - (NEW_BADGE_REFRESH_MS - 400) }, now), ["a"]);
  assert.deepEqual(foldersDueForCount(["a"], { a: now - (NEW_BADGE_REFRESH_MS - 30_000) }, now), []);
  const cache = { a: 1, b: 2 };
  assert.equal(pruneBadgeCache(cache, ["a", "b", "c"]), cache, "버릴 게 없으면 같은 객체");
  assert.deepEqual(pruneBadgeCache(cache, ["b"]), { b: 2 });
});

test("가벼운 목록(layout=0)도 배치 목록과 같은 id 검증을 거친다", async () => {
  const root = await mkdtemp(join(tmpdir(), "sharedesk-badge-list-"));
  const previousDriver = process.env.STORAGE_DRIVER;
  const previousRoot = process.env.LOCAL_STORAGE_ROOT;
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  try {
    const [{ getFolderEntries }, storage, types] = await Promise.all([
      import("../src/lib/desktop-layout"),
      import("../src/lib/storage"),
      import("../src/lib/storage/types"),
    ]);
    await storage.getAdapter().createFolder(types.ROOT_ID, "모음");
    const entries = await getFolderEntries(types.ROOT_ID);
    assert.deepEqual(entries.map((entry) => entry.name), ["모음"]);
    await assert.rejects(getFolderEntries(""), { code: "BAD_ID" });
    await assert.rejects(getFolderEntries("x".repeat(1_025)), { code: "BAD_ID" });
  } finally {
    process.env.STORAGE_DRIVER = previousDriver;
    process.env.LOCAL_STORAGE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
  const route = await read("src/app/api/drive/list/route.ts");
  assert.match(route, /searchParams\.get\("layout"\) === "0"/);
  assert.match(route, /getFolderEntries\(folderId\)/);
  assert.match(route, /getFolderListingWithLayout\(folderId\)/);
  assert.match(route, /runWithSession\(/);
});

test("배선: 데스크 화면 — 저장소 헬퍼, 목록마다 기준 올리기, 30초 확인에 얹힌 폴더 배지, 내 업로드 (#16 C-2)", async () => {
  const view = await read("src/app/files/FilesView.tsx");
  assert.match(view, /openNewBadgeStore\(/);
  assert.match(view, /newBadgeStorageKey\(\s*window\.location\.origin,\s*spaceSlugFromPathname\(window\.location\.pathname\),\s*userEmail,?\s*\)/);
  // 목록을 받을 때마다 비추고(observeList) 탭이 보일 때 기준을 올린다(markFolderSeen) — 바탕화면은 머문 뒤.
  assert.match(view, /observeList\(/);
  assert.match(view, /markFolderSeen\([^)]*ROOT_ID/);
  assert.match(view, /document\.visibilityState !== "visible"/);
  assert.match(view, /ROOT_SEEN_DELAY_MS/);
  assert.match(view, /addEventListener\("visibilitychange"/);
  // 창마다의 점 기준은 창 상태에 있고, 폴더를 옮기면 비운다.
  assert.match(view, /newBaseline: \{ at: number \| null \} \| null;/);
  assert.equal(view.match(/newBaseline: null,/g)?.length, 4, "창 생성 + 폴더를 옮기는 세 자리");
  // 폴더 배지: 30초 목록 확인이 부르고, 별도 타이머는 없다. 창으로 열린 폴더는 빼고 캐시는 버린다.
  const listPoll = view.slice(view.indexOf("const listPoll = window.setInterval"), view.indexOf("}, LIST_POLL_MS);"));
  assert.match(listPoll, /refreshFolderBadgesRef\.current\(\)/);
  assert.doesNotMatch(view, /setInterval\(\(\) => void round\(\)/);
  assert.match(view, /\/api\/drive\/list\?folderId=\$\{encodeURIComponent\(folderId\)\}&layout=0/);
  assert.match(view, /pruneBadgeCache\(/);
  assert.match(view, /badgeFolders\(/);
  // 아이콘: 파일 점·폴더 배지·버튼 이름.
  assert.match(view, /isNewEntry\(entry, newBaseline, ownUploads\)/);
  assert.match(view, /className=\{styles\.newDot\}/);
  assert.match(view, /className=\{styles\.newCount\}/);
  assert.match(view, /t\("새 파일 \{count\}개", \{ count: newCount \}\)/);
  // 내 업로드는 그 버전의 시각과 함께.
  assert.match(view, /markOwnUpload\(uploadedId, entryTime\(body\?\.entry\)\)/);
  assert.match(view, /markOwnUpload\(result\.entry\.id, entryTime\(result\.entry\)\)/);
  // 로그아웃 때 기록을 지운다.
  assert.match(view, /clearNewBadgeStores\(\);\s*await fetch\(apiPath\("\/api\/auth"\), \{ method: "DELETE" \}\)/);
  assert.doesNotMatch(view, /api\/[a-z/-]*new-badge/, "서버 기록 없음");

  const css = await read("src/app/files/desktop.module.css");
  assert.match(css, /\.newDot \{[^}]*background: #ffd27d;/);
  assert.match(css, /\.newCount \{/);
  assert.match(css, /\.iconGlyph \{[^}]*position: relative;/);

  const logout = await read("src/app/LogoutButton.tsx");
  assert.match(logout, /clearNewBadgeStores\(\);\s*await fetch\("\/api\/auth", \{ method: "DELETE" \}\)/);
});

test("배선: 위젯 서랍도 같은 헬퍼·같은 규칙으로 파일 점을 그린다 (#16 C-2)", async () => {
  const widget = await read("src/app/widget/WidgetView.tsx");
  assert.match(widget, /openNewBadgeStore\(/);
  assert.match(widget, /observeList\(/);
  assert.match(widget, /markFolderSeen\(/);
  assert.match(widget, /ROOT_SEEN_DELAY_MS/);
  assert.match(widget, /isWidgetHidden\(document, window\)/);
  assert.match(widget, /className=\{styles\.newDot\}/);
  assert.match(widget, /rememberOwnUpload\(/);
  assert.doesNotMatch(widget, /readNewBadgeState|writeNewBadgeState|window\.localStorage;\s*\} catch/);
  const page = await read("src/app/files/page.tsx");
  assert.match(page, /<WidgetView[\s\S]*?userEmail=\{session\.email\}/);
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
