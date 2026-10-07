import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import test from "node:test";
import type { EntryAudit } from "../src/lib/entry-audit";
import {
  buildRecentRows,
  DEFAULT_RECENT_DAYS,
  goneByRecord,
  MAX_RECENT_LIMIT,
  parseRecentQuery,
  RECENT_DAY_CHOICES,
  RECENT_LOCATE_ROWS,
  RECENT_TRAVERSAL_LIMIT,
  recentItem,
  type RecentFilesResponse,
} from "../src/lib/recent-files";

// 최근 파일(#16 C-1) — 순수 함수(기간·묶기·휴지통 표시) → 항목별 내력 기록 →
// 불러오기(지금 자리·지워짐·탐색 범위·스페이스) → 배선 → 화면 → 실제 HTTP.

const read = (relative: string) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();

test("기간·개수 읽기 — 1~30일(기본 7), 개수는 1 이상·200까지 (#16 C-1)", () => {
  assert.deepEqual([...RECENT_DAY_CHOICES], [1, 3, 7, 30]);
  assert.equal(DEFAULT_RECENT_DAYS, 7);
  assert.equal(RECENT_LOCATE_ROWS, 50);
  assert.equal(RECENT_TRAVERSAL_LIMIT, 1_000);
  const parse = (query: string) => parseRecentQuery(new URLSearchParams(query));
  assert.deepEqual(parse(""), { days: 7, limit: MAX_RECENT_LIMIT });
  assert.deepEqual(parse("days=1&limit=5"), { days: 1, limit: 5 });
  assert.deepEqual(parse("days=30"), { days: 30, limit: 200 });
  assert.deepEqual(parse("limit=999"), { days: 7, limit: 200 }, "상한으로 자른다");
  for (const bad of [
    "days=0",
    "days=31",
    "days=-1",
    "days=1.5",
    "days=abc",
    "limit=0",
    "limit=x",
    "limit=-3",
  ]) {
    assert.equal(parse(bad), null, bad);
  }
});

test("묶기·기간 거르기·시간 역순 — 같은 항목의 잇단 같은 행위(같은 사람)만 한 줄, 휴지통 표시는 줄이 아니다 (#16 C-1)", () => {
  const audits: Record<string, EntryAudit> = {
    "k:a": {
      uploadedBy: "가람구글",
      uploadedById: "u-a",
      uploadedAt: iso(10 * DAY), // 7일 밖
      changes: [
        { at: iso(1 * HOUR), kind: "edit", by: "가람구글", byId: "u-a" },
        { at: iso(2 * HOUR), kind: "edit", by: "가람구글", byId: "u-a" },
        { at: iso(3 * HOUR), kind: "edit", by: "가람구글", byId: "u-a" },
        { at: iso(4 * HOUR), kind: "rename", by: "베타", byId: "u-b" },
        { at: iso(5 * HOUR), kind: "edit", by: "가람구글", byId: "u-a" },
      ],
    },
    "k:b": {
      uploadedBy: "홍길동",
      uploadedByGuest: true,
      uploadedAt: iso(30 * 60 * 1000),
    },
    // id 없는 옛 기록은 이름으로 같은 사람을 가린다.
    "k:c": {
      changes: [
        { at: iso(2 * DAY), kind: "move", by: "옛이름" },
        { at: iso(3 * DAY), kind: "move", by: "옛이름" },
      ],
    },
    // 사람이 번갈아 바꾸면 묶지 않는다.
    "k:d": {
      changes: [
        { at: iso(6 * HOUR), kind: "edit", by: "가", byId: "u-a" },
        { at: iso(7 * HOUR), kind: "edit", by: "나", byId: "u-b" },
        { at: iso(8 * HOUR), kind: "edit", by: "가", byId: "u-a" },
      ],
    },
    // 휴지통에 갔다가 돌아왔다 — 표시는 줄을 만들지 않는다.
    "k:e": {
      changes: [
        { at: iso(0.2 * HOUR), kind: "restored", by: "가", byId: "u-a" },
        { at: iso(0.3 * HOUR), kind: "deleted", by: "가", byId: "u-a" },
        { at: iso(9 * HOUR), kind: "edit", by: "가", byId: "u-a" },
      ],
    },
  };

  const week = buildRecentRows(audits, { now: NOW, days: 7 });
  assert.deepEqual(
    week.map((row) => [row.layoutKey, row.action, row.count, row.at]),
    [
      ["k:b", "upload", 1, NOW - 30 * 60 * 1000],
      ["k:a", "edit", 3, NOW - 1 * HOUR],
      ["k:a", "rename", 1, NOW - 4 * HOUR],
      ["k:a", "edit", 1, NOW - 5 * HOUR],
      ["k:d", "edit", 1, NOW - 6 * HOUR],
      ["k:d", "edit", 1, NOW - 7 * HOUR],
      ["k:d", "edit", 1, NOW - 8 * HOUR],
      ["k:e", "edit", 1, NOW - 9 * HOUR],
      ["k:c", "move", 2, NOW - 2 * DAY],
    ],
  );
  assert.equal(week[0].guest, true);
  assert.equal(week[0].by, "홍길동");
  assert.equal(week[1].byId, "u-a");

  // 기간 칩: 하루면 사흘 전 이동이 빠지고, 한 달이면 열흘 전 업로드가 들어온다.
  const day = buildRecentRows(audits, { now: NOW, days: 1 });
  assert.equal(
    day.every((row) => row.at >= NOW - DAY),
    true,
    "하루 칩은 24시간 안의 줄만",
  );
  assert.equal(day.some((row) => row.layoutKey === "k:c"), false);
  const month = buildRecentRows(audits, { now: NOW, days: 30 });
  assert.deepEqual(month.at(-1), {
    layoutKey: "k:a",
    at: NOW - 10 * DAY,
    action: "upload",
    count: 1,
    by: "가람구글",
    byId: "u-a",
    guest: false,
  });
  // 기간 경계 밖의 일은 묶음 수에서도 빠진다(먼저 거르고 묶는다).
  assert.equal(
    buildRecentRows({ "k:c": audits["k:c"] }, { now: NOW, days: 3 })[0].count,
    2,
  );
  assert.equal(
    buildRecentRows({ "k:c": audits["k:c"] }, { now: NOW + 12 * HOUR, days: 3 })[0]
      .count,
    1,
  );
  assert.deepEqual(buildRecentRows({}, { now: NOW, days: 7 }), []);

  // 휴지통 표시 — 마지막 표시가 deleted일 때만 지워짐.
  assert.equal(goneByRecord(audits["k:e"]), false, "복원이 마지막");
  assert.equal(
    goneByRecord({
      changes: [
        { at: iso(1 * HOUR), kind: "deleted", by: "가" },
        { at: iso(2 * HOUR), kind: "restored", by: "가" },
      ],
    }),
    true,
  );
  assert.equal(goneByRecord(audits["k:a"]), false);
  assert.equal(goneByRecord(undefined), false);
});

test("행위자 — 멤버는 별명 또는 이름 없이(실명 폴백 없음), 접속 키·공개 폴더 손님은 손님 (#16 C-1)", async () => {
  const { recentActor } = await import("../src/lib/recent-files-load");
  const nicknames = new Map([["u-a", "가람"]]);
  assert.deepEqual(
    recentActor({ by: "가람구글", byId: "u-a", guest: false }, nicknames),
    { name: "가람", guest: false },
  );
  assert.deepEqual(
    recentActor({ by: "Beta Lee", byId: "u-b", guest: false }, nicknames),
    { name: null, guest: false },
    "별명이 없으면 실명 대신 이름 없음(화면은 멤버)",
  );
  assert.deepEqual(
    recentActor({ by: "옛 실명", byId: null, guest: false }, nicknames),
    { name: null, guest: false },
    "id 없는 옛 기록도 실명을 내보내지 않는다",
  );
  assert.deepEqual(
    recentActor({ by: "손님", byId: "key:abcd1234", guest: false }, nicknames),
    { name: null, guest: true },
  );
  assert.deepEqual(
    recentActor({ by: "홍길동", byId: null, guest: true }, nicknames),
    { name: "홍길동", guest: true },
  );
});

test("응답 항목 — 지금 자리가 있으면 그 이름·자리, 없으면 내력의 이름, 이름도 없으면 뺀다 (#16 C-1)", () => {
  const row = {
    layoutKey: "k:a",
    at: NOW,
    action: "edit" as const,
    count: 2,
    by: "가람구글",
    byId: "u-a",
    guest: false,
  };
  const actor = { name: "가람", guest: false };
  const location = {
    entry: {
      id: "id-a",
      layoutKey: "k:a",
      name: "지금이름.txt",
      isFolder: false,
      size: 3,
      modifiedAt: iso(0),
      mimeType: "text/plain",
      version: "v1",
    },
    parentId: "f1",
    breadcrumbs: [
      { id: "root", name: "ShareDesk" },
      { id: "f1", name: "문서" },
    ],
    path: "/문서/지금이름.txt",
  };
  const present = recentItem(row, { name: "옛이름.txt" }, location, true, actor);
  assert.equal(present?.exists, true);
  assert.equal(present?.name, "지금이름.txt", "지금 이름이 우선");
  assert.deepEqual(present?.location, location);
  assert.equal(present?.at, new Date(NOW).toISOString());
  assert.equal(present?.count, 2);
  assert.deepEqual(present?.actor, actor);

  const gone = recentItem(row, { name: "옛이름.txt", isFolder: true }, null, false, actor);
  assert.equal(gone?.exists, false);
  assert.equal(gone?.location, null);
  assert.equal(gone?.name, "옛이름.txt");
  assert.equal(gone?.isFolder, true);

  const unknown = recentItem(row, { name: "옛이름.txt" }, null, null, actor);
  assert.equal(unknown?.exists, null);

  assert.equal(recentItem(row, {}, null, false, actor), null);
  assert.equal(recentItem(row, undefined, null, false, actor), null);
});

async function withLocalStorage(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sharedesk-recent-"));
  const previousDriver = process.env.STORAGE_DRIVER;
  const previousRoot = process.env.LOCAL_STORAGE_ROOT;
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  try {
    await run(root);
  } finally {
    if (previousDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = previousDriver;
    if (previousRoot === undefined) delete process.env.LOCAL_STORAGE_ROOT;
    else process.env.LOCAL_STORAGE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value: string) => new Blob([value]).stream();

test("항목별 내력 — 변경 기록·열쇠 옮기기(횟수 합산)·조건부 업로드 기록 (#16 C-1)", async () => {
  await withLocalStorage(async () => {
    const { getAdapter } = await import("../src/lib/storage");
    const { ROOT_ID } = await import("../src/lib/storage/types");
    const audit = await import("../src/lib/entry-audit");
    const adapter = getAdapter();
    const alpha = { userId: "u-a", name: "가람구글" };
    const beta = { userId: "u-b", name: "베타" };

    const uploaded = await adapter.upload(ROOT_ID, "메모.txt", "text/plain", text("a"));
    await audit.recordEntryUpload(uploaded, alpha);
    const renamed = await adapter.rename(uploaded.id, "회의록.txt", uploaded.version!);
    assert.equal(renamed.layoutKey, uploaded.layoutKey, "이름을 바꿔도 같은 열쇠");
    await audit.recordEntryChange(renamed, beta, "rename");
    let record = await audit.getEntryAudit(renamed.layoutKey);
    assert.equal(record?.name, "회의록.txt");
    assert.equal(record?.uploadedBy, "가람구글");
    assert.equal(record?.uploadedById, "u-a");
    assert.deepEqual(
      record?.changes?.map((change) => [change.kind, change.by, change.byId]),
      [["rename", "베타", "u-b"]],
    );

    // local은 본문을 바꾸면 identity가 새로 생긴다 — 앞 열쇠의 기록이 따라온다.
    const edited = await adapter.replaceContent(
      renamed.id,
      renamed.version!,
      "text/plain",
      text("바뀐 본문"),
    );
    await audit.recordEntryChange(edited, alpha, "edit", {
      previousLayoutKey: renamed.layoutKey,
    });
    record = await audit.getEntryAudit(edited.layoutKey);
    assert.equal(record?.uploadedBy, "가람구글", "올린 사람이 새 열쇠로 옮겨졌다");
    assert.deepEqual(
      record?.changes?.map((change) => change.kind),
      ["edit", "rename"],
    );
    if (edited.layoutKey !== renamed.layoutKey) {
      assert.equal(await audit.getEntryAudit(renamed.layoutKey), null);
    }

    // 항목 하나는 최근 20건만 기억한다.
    for (let index = 0; index < 25; index += 1) {
      await audit.recordEntryChange(edited, beta, "move");
    }
    record = await audit.getEntryAudit(edited.layoutKey);
    assert.equal(record?.changes?.length, 20);

    // 휴지통 표시도 같은 내력에 남는다.
    await audit.recordEntryChange(edited, beta, "deleted");
    assert.equal(
      (await audit.getEntryAudit(edited.layoutKey))?.changes?.[0]?.kind,
      "deleted",
    );

    // 폴더 이름 변경은 폴더 표시를 남긴다.
    const folder = await adapter.createFolder(ROOT_ID, "사진");
    await audit.recordEntryChange(folder, alpha, "rename");
    assert.equal((await audit.getEntryAudit(folder.layoutKey))?.isFolder, true);

    // 조건부 업로드 기록 — 이미 올린 사람이 있으면 바꾸지 않고, 없으면 남긴다.
    await audit.recordEntryUpload(edited, beta, { onlyIfUnrecorded: true });
    assert.equal(
      (await audit.getEntryAudit(edited.layoutKey))?.uploadedById,
      "u-a",
      "남이 올린 파일의 주인이 바뀌지 않는다",
    );
    const fresh = await adapter.upload(ROOT_ID, "새것.txt", "text/plain", text("n"));
    await audit.recordEntryUpload(fresh, beta, { onlyIfUnrecorded: true });
    assert.equal((await audit.getEntryAudit(fresh.layoutKey))?.uploadedById, "u-b");

    // 공개 폴더 손님이 같은 자리에 다시 올리면 앞 주인의 id가 남지 않는다.
    await audit.recordEntryGuestUpload(edited, null);
    record = await audit.getEntryAudit(edited.layoutKey);
    assert.equal(record?.uploadedById, undefined);
    assert.equal(record?.uploadedByGuest, true);
    // 손님 업로드도 "기록 있음"이다.
    await audit.recordEntryUpload(edited, beta, { onlyIfUnrecorded: true });
    assert.equal((await audit.getEntryAudit(edited.layoutKey))?.uploadedByGuest, true);

    // 손으로 고친 깨진 내력은 버리고 멀쩡한 것만 남는다.
    await adapter.writeState("entry-audit.json", {
      version: 1,
      entries: {
        "k:broken": {
          name: "  남은 이름.txt  ",
          isFolder: "yes",
          uploadedById: `bad${String.fromCharCode(1)}id`,
          changes: [
            { at: "언제인지 모름", kind: "edit", by: "가" },
            { at: iso(0), kind: "purge", by: "가" },
            { at: iso(0), kind: "edit", by: "" },
            { at: iso(0), kind: "move", by: "멤버", byId: `x${String.fromCharCode(7)}` },
            { at: iso(0), kind: "deleted", by: "멤버", byId: "u-ok" },
          ],
        },
      },
    });
    const broken = (await audit.listEntryAudits())["k:broken"];
    assert.equal(broken.name, "남은 이름.txt");
    assert.equal(broken.isFolder, undefined);
    assert.equal(broken.uploadedById, undefined);
    assert.deepEqual(broken.changes, [
      { at: iso(0), kind: "move", by: "멤버" },
      { at: iso(0), kind: "deleted", by: "멤버", byId: "u-ok" },
    ]);
  });
});

test("열쇠 옮기기는 내려받기 횟수를 더하고 기록을 시각순으로 합친다 · 직행 완료 판정 (#16 C-1)", async () => {
  const { mergeAudits, changedSince } = await import("../src/lib/entry-audit");
  const merged = mergeAudits(
    {
      uploadedBy: "가람구글",
      downloadCount: 2,
      downloads: [
        { at: iso(1 * HOUR), by: "가" },
        { at: iso(3 * HOUR), by: "나" },
      ],
      linkDownloadCount: 1,
      lastLinkDownloadAt: iso(1 * HOUR),
      changes: [{ at: iso(2 * HOUR), kind: "rename", by: "가" }],
    },
    {
      name: "새이름.txt",
      downloadCount: 1,
      downloads: [{ at: iso(2 * HOUR), by: "다" }],
      linkDownloadCount: 3,
      lastLinkDownloadAt: iso(5 * HOUR),
      changes: [{ at: iso(0), kind: "edit", by: "가" }],
    },
  );
  assert.equal(merged.downloadCount, 3);
  assert.equal(merged.linkDownloadCount, 4);
  assert.equal(merged.lastLinkDownloadAt, iso(1 * HOUR), "늦은 쪽");
  assert.deepEqual(
    merged.downloads?.map((download) => download.by),
    ["가", "다", "나"],
  );
  assert.deepEqual(
    merged.changes?.map((change) => change.kind),
    ["edit", "rename"],
  );
  assert.equal(merged.uploadedBy, "가람구글");
  assert.equal(merged.name, "새이름.txt");

  // 직행 완료가 가리킨 파일이 예약 뒤에 생기거나 바뀌었나.
  assert.equal(changedSince(iso(0), iso(1 * HOUR)), true);
  assert.equal(changedSince(iso(2 * HOUR), iso(1 * HOUR)), false, "예약보다 오래된 파일");
  assert.equal(changedSince(iso(0), null), false, "생성 시각 없는 옛 예약");
  assert.equal(changedSince(null, iso(0)), false);
});

function usersFile(users: object[]) {
  return { version: 2, rev: 1, users, invitations: [] };
}

function member(
  id: string,
  name: string,
  nickname: string | null,
  role = "editor",
) {
  return {
    id,
    email: `${id}@example.com`,
    name,
    status: "approved",
    role,
    isAdmin: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    invitationId: null,
    sessionsValidFrom: 0,
    sessionVersion: 0,
    sessions: [],
    nickname,
    nicknameHistory: [],
  };
}

// 목록 읽기를 세는 어댑터 — 위치 찾기를 했는지 본다.
function counting<T extends { list(folderId: string): Promise<unknown> }>(adapter: T) {
  const calls: string[] = [];
  return {
    calls,
    list: (folderId: string) => {
      calls.push(folderId);
      return adapter.list(folderId) as ReturnType<T["list"]>;
    },
  };
}

test("최근 파일 불러오기 — 지금 자리·휴지통 기록·지워진 폴더 속·별명·limit은 거른 뒤 (#16 C-1)", async () => {
  await withLocalStorage(async () => {
    const { getAdapter } = await import("../src/lib/storage");
    const { ROOT_ID } = await import("../src/lib/storage/types");
    const audit = await import("../src/lib/entry-audit");
    const { loadRecentFiles, locateLayoutKeys } = await import(
      "../src/lib/recent-files-load"
    );
    const adapter = getAdapter();
    const alpha = { userId: "u-a", name: "가람구글" };
    const beta = { userId: "u-b", name: "Beta Lee" };
    await adapter.writeState(
      "users.json",
      usersFile([member("u-a", "가람구글", "가람"), member("u-b", "Beta Lee", null)]),
    );

    const folder = await adapter.createFolder(ROOT_ID, "사진");
    const inRoot = await adapter.upload(ROOT_ID, "a.txt", "text/plain", text("a"));
    await audit.recordEntryUpload(inRoot, alpha);
    await pause(5);
    const inFolder = await adapter.upload(folder.id, "b.png", "image/png", text("b"));
    await audit.recordEntryUpload(inFolder, beta);
    await pause(5);
    // 휴지통으로 보낸 파일 — 내력의 deleted로 판정한다.
    const doomed = await adapter.upload(ROOT_ID, "c.txt", "text/plain", text("c"));
    await audit.recordEntryUpload(doomed, { userId: "key:abcd1234", name: "손님" });
    await adapter.remove(doomed.id);
    await audit.recordEntryChange(doomed, alpha, "deleted");
    await pause(5);
    // 지운 폴더 속 파일 — 표시는 폴더에만 있어 위치 찾기로 "지워짐"을 가린다.
    const dropped = await adapter.createFolder(ROOT_ID, "버림");
    const inside = await adapter.upload(dropped.id, "속.txt", "text/plain", text("d"));
    await audit.recordEntryUpload(inside, alpha);
    await adapter.remove(dropped.id);
    await audit.recordEntryChange(dropped, alpha, "deleted");
    await pause(5);
    await audit.recordEntryChange(inRoot, alpha, "edit");
    await pause(5);
    // 가장 최근 줄이 이름 모르는 옛 기록이다 — 걸러진 뒤에 limit을 센다.
    await audit.recordEntryUpload(
      { layoutKey: "local:legacy:gone", name: "", isFolder: false },
      { userId: "u-old", name: "옛사람" },
    );

    const listing = counting(adapter);
    const all = await loadRecentFiles({ days: 7, limit: 200 }, { adapter: listing });
    assert.equal(all.truncated, false);
    assert.equal(all.days, 7);
    assert.ok(all.explored > 0, "있는 항목은 찾아야 하므로 탐색했다");
    assert.ok(Number.isFinite(Date.parse(all.now)), "서버 시각을 함께 준다");
    assert.deepEqual(
      all.items.map((item) => [item.name, item.action, item.exists]),
      [
        ["a.txt", "edit", true],
        ["속.txt", "upload", false],
        ["c.txt", "upload", false],
        ["b.png", "upload", true],
        ["a.txt", "upload", true],
      ],
    );
    const [edit, insideRow, gone, png] = all.items;
    assert.deepEqual(edit.actor, { name: "가람", guest: false }, "별명이 화면 이름");
    assert.equal(edit.location?.parentId, ROOT_ID);
    assert.deepEqual(edit.location?.breadcrumbs, [{ id: ROOT_ID, name: "ShareDesk" }]);
    assert.equal(edit.location?.entry.id, inRoot.id);
    assert.equal(edit.location?.path, "/a.txt");
    assert.equal(insideRow.location, null);
    assert.deepEqual(gone.actor, { name: null, guest: true }, "접속 키 손님");
    assert.equal(gone.location, null);
    assert.deepEqual(png.actor, { name: null, guest: false }, "별명이 없으면 실명 대신 이름 없음");
    assert.equal(png.location?.parentId, folder.id);
    assert.equal(png.location?.path, "/사진/b.png");

    // limit은 이름 모르는 옛 기록을 거른 뒤에 센다.
    const two = await loadRecentFiles({ days: 7, limit: 2 });
    assert.deepEqual(
      two.items.map((item) => item.name),
      ["a.txt", "속.txt"],
    );

    // 탐색 상한에 걸리면 complete=false — 못 찾은 항목을 사라졌다고 하지 않는다.
    const partial = await locateLayoutKeys(new Set([inFolder.layoutKey]), adapter, {
      maxTraversal: 1,
    });
    assert.equal(partial.complete, false);
    assert.equal(partial.found.size, 0);
    const whole = await locateLayoutKeys(new Set([inFolder.layoutKey]), adapter);
    assert.equal(whole.complete, true);
    assert.equal(whole.found.get(inFolder.layoutKey)?.parentId, folder.id);
  });
});

test("휴지통 기록만 있으면 위치 찾기를 하지 않는다 · 앞 50줄만 찾는다 (#16 C-1)", async () => {
  await withLocalStorage(async () => {
    const { getAdapter } = await import("../src/lib/storage");
    const { ROOT_ID } = await import("../src/lib/storage/types");
    const audit = await import("../src/lib/entry-audit");
    const { loadRecentFiles } = await import("../src/lib/recent-files-load");
    const adapter = getAdapter();
    const alpha = { userId: "u-a", name: "가람구글" };

    const doomed = await adapter.upload(ROOT_ID, "지울것.txt", "text/plain", text("x"));
    await audit.recordEntryUpload(doomed, alpha);
    await adapter.remove(doomed.id);
    await audit.recordEntryChange(doomed, alpha, "deleted");

    const listing = counting(adapter);
    const onlyGone = await loadRecentFiles({ days: 7, limit: 200 }, { adapter: listing });
    assert.deepEqual(
      onlyGone.items.map((item) => [item.name, item.exists]),
      [["지울것.txt", false]],
    );
    assert.equal(listing.calls.length, 0, "목록을 한 번도 읽지 않았다");
    assert.equal(onlyGone.explored, 0);

    // 복원 기록이 마지막이면 다시 찾는다.
    await audit.recordEntryChange(doomed, alpha, "restored");
    const restoredListing = counting(adapter);
    const afterRestore = await loadRecentFiles(
      { days: 7, limit: 200 },
      { adapter: restoredListing },
    );
    assert.ok(restoredListing.calls.length > 0, "복원 뒤에는 위치를 찾는다");
    assert.equal(afterRestore.items[0].exists, false, "휴지통에 그대로 있다");

    // 줄이 55개면 앞 50줄의 항목만 찾고 나머지는 "확인 못 함".
    const entries: Record<string, EntryAudit> = {};
    for (let index = 0; index < 55; index += 1) {
      entries[`local:fake:${index}`] = {
        name: `가짜-${index}.txt`,
        uploadedBy: "가람구글",
        uploadedById: "u-a",
        uploadedAt: new Date(Date.now() - index * 60_000).toISOString(),
      };
    }
    await adapter.writeState("entry-audit.json", { version: 1, entries });
    const many = await loadRecentFiles({ days: 7, limit: 200 });
    assert.equal(many.items.length, 55);
    assert.deepEqual(
      [...new Set(many.items.slice(0, 50).map((item) => item.exists))],
      [false],
      "앞 50줄은 끝까지 찾아 없으니 지워짐",
    );
    assert.deepEqual(
      [...new Set(many.items.slice(50).map((item) => item.exists))],
      [null],
    );
    assert.equal(many.truncated, true);
  });
});

test("스페이스 범위 — 다른 스페이스의 내력·파일은 보이지 않는다 (#16 C-1)", async () => {
  await withLocalStorage(async () => {
    const { getAdapter } = await import("../src/lib/storage");
    const { ROOT_ID } = await import("../src/lib/storage/types");
    const { runWithSpace } = await import("../src/lib/space-store");
    const audit = await import("../src/lib/entry-audit");
    const { loadRecentFiles } = await import("../src/lib/recent-files-load");
    const adapter = getAdapter();
    const actor = { userId: "u-a", name: "가람구글" };
    const space = { slug: "team", folderId: ".spaces/team" };

    const base = await adapter.upload(ROOT_ID, "base.txt", "text/plain", text("b"));
    await audit.recordEntryUpload(base, actor);
    await runWithSpace(space, async () => {
      const inTeam = await adapter.upload(ROOT_ID, "team.txt", "text/plain", text("t"));
      await audit.recordEntryUpload(inTeam, actor);
      await audit.recordEntryChange(inTeam, actor, "rename");
    });

    const inBase = await loadRecentFiles({ days: 7, limit: 200 });
    assert.deepEqual(
      inBase.items.map((item) => item.name),
      ["base.txt"],
      "기본 데스크는 스페이스(.spaces) 안을 보지 않는다",
    );
    const inSpace = await runWithSpace(space, () =>
      loadRecentFiles({ days: 7, limit: 200 }),
    );
    assert.deepEqual(
      inSpace.items.map((item) => [item.name, item.action, item.exists]),
      [
        ["team.txt", "rename", true],
        ["team.txt", "upload", true],
      ],
    );
  });
});

test("배선: API는 멤버만(손님 403), 쓰기 라우트가 내력을 남기고, 위치 찾기는 검색과 같은 순회 (#16 C-1)", async () => {
  const [route, content, rename, move, complete, upload, importRoute, del, trash, search, load, auth] =
    await Promise.all([
      read("src/app/api/drive/recent/route.ts"),
      read("src/app/api/drive/content/route.ts"),
      read("src/app/api/drive/rename/route.ts"),
      read("src/app/api/drive/move/route.ts"),
      read("src/app/api/drive/upload-complete/route.ts"),
      read("src/app/api/drive/upload/route.ts"),
      read("src/app/api/drive/import/route.ts"),
      read("src/app/api/drive/delete/route.ts"),
      read("src/app/api/drive/trash/route.ts"),
      read("src/lib/search.ts"),
      read("src/lib/recent-files-load.ts"),
      read("src/lib/auth.ts"),
    ]);

  // 관리자 전용이 아니지만 접속 키 손님은 막는다.
  assert.match(route, /runWithSession\(null,/);
  assert.doesNotMatch(route, /runWithAdmin|runWithEditRights|runWithUploadRights/);
  assert.match(route, /if \(session\.isGuest\) \{[\s\S]*?status: 403/);
  assert.match(route, /parseRecentQuery\(req\.nextUrl\.searchParams\)/);
  assert.match(route, /loadRecentFiles\(query, \{ signal: req\.signal \}\)/);

  assert.match(
    content,
    /recordEntryChangeAfter\(entry, session, "edit", \{\s*previousLayoutKey: current\.layoutKey,?\s*\}\)/,
  );
  assert.match(rename, /recordEntryChangeAfter\(entry, session, "rename"\)/);
  assert.match(move, /recordEntryChangeAfter\(entry, session, "move"\)/);
  assert.match(del, /recordEntryChangeAfter\(entry, session, "deleted"\)/);
  assert.match(trash, /recordEntryChangeAfter\(restored, session, "restored"\)/);
  for (const source of [upload, importRoute]) {
    assert.match(source, /recordEntryUploadAfter\(entry, session\);/);
  }
  // 직행 완료: 예약 뒤에 생기거나 바뀐 파일이 아니면 기록이 없을 때만 남긴다.
  assert.match(
    complete,
    /recordEntryUploadAfter\(entry, session, \{\s*onlyIfUnrecorded: !changedSince\(entry\.modifiedAt, reservation\.createdAt\),?\s*\}\)/,
  );
  // 내력은 본 작업이 성공한 뒤에만 남긴다(import 줄이 아니라 호출부로 견준다).
  for (const [source, operation] of [
    [rename, "getAdapter().rename("],
    [move, "getAdapter().move("],
    [del, "adapter.remove(body.id)"],
    [complete, "await finishUploadReservation("],
  ] as const) {
    assert.ok(
      source.indexOf("recordEntry") > 0 &&
        source.lastIndexOf("recordEntry") > source.indexOf(operation),
      `${operation} 뒤에 기록한다`,
    );
  }

  // 검색·검색 범위 찾기·최근 파일 위치 찾기가 같은 순회 하나를 쓴다.
  assert.match(search, /export async function walkFolders\(/);
  assert.equal(search.match(/await walkFolders\(/g)?.length, 2);
  assert.match(load, /await walkFolders\(/);
  assert.match(load, /from "@\/lib\/search"/);
  assert.match(load, /KEY_GUEST_ID_PREFIX/);
  assert.match(auth, /export const KEY_GUEST_ID_PREFIX = "key:"/);
});

test("상대 시각 문구 — 방금·n분 전·n시간 전·어제 14:02·날짜 (#16 C-1)", async () => {
  const { recentTimeParts, formatRecentTime } = await import(
    "../src/lib/client/recent-files-view"
  );
  const { translate } = await import("../src/lib/i18n");
  // 날짜 경계는 지역 시간대 기준 — 지역 시각으로 만들면 어느 시간대에서도 같다.
  const now = new Date(2026, 9, 7, 14, 2).getTime();
  assert.deepEqual(recentTimeParts(now - 30_000, now), { kind: "now" });
  assert.deepEqual(recentTimeParts(now + 5 * 60_000, now), { kind: "now" }, "앞날짜도 방금");
  assert.deepEqual(recentTimeParts(now - 3 * 60_000, now), { kind: "minutes", count: 3 });
  assert.deepEqual(recentTimeParts(now - 59 * 60_000, now), { kind: "minutes", count: 59 });
  assert.deepEqual(recentTimeParts(new Date(2026, 9, 7, 9, 0).getTime(), now), {
    kind: "hours",
    count: 5,
  });
  assert.deepEqual(recentTimeParts(new Date(2026, 9, 6, 14, 2).getTime(), now), {
    kind: "yesterday",
  });
  assert.deepEqual(recentTimeParts(new Date(2026, 9, 5, 23, 59).getTime(), now), {
    kind: "date",
  });
  // 자정을 넘어도 한 시간 안이면 n분 전.
  const afterMidnight = new Date(2026, 9, 7, 0, 30).getTime();
  assert.deepEqual(
    recentTimeParts(new Date(2026, 9, 6, 23, 50).getTime(), afterMidnight),
    { kind: "minutes", count: 40 },
  );
  assert.deepEqual(
    recentTimeParts(new Date(2026, 9, 6, 22, 0).getTime(), afterMidnight),
    { kind: "yesterday" },
  );

  const ko = (value: string, vars?: Record<string, string | number>) =>
    translate("ko", value, vars);
  const en = (value: string, vars?: Record<string, string | number>) =>
    translate("en", value, vars);
  assert.equal(formatRecentTime(now - 3 * 60_000, now, "ko", ko), "3분 전");
  assert.equal(formatRecentTime(now, now, "ko", ko), "방금 전");
  assert.equal(
    formatRecentTime(new Date(2026, 9, 6, 14, 2).getTime(), now, "ko", ko),
    "어제 14:02",
  );
  assert.equal(
    formatRecentTime(new Date(2026, 9, 7, 9, 0).getTime(), now, "ko", ko),
    "5시간 전",
  );
  assert.equal(formatRecentTime(now - 3 * 60_000, now, "en", en), "3 min ago");
  assert.equal(
    formatRecentTime(new Date(2026, 9, 6, 14, 2).getTime(), now, "en", en),
    "Yesterday 14:02",
  );
  assert.match(
    formatRecentTime(new Date(2026, 8, 30, 8, 5).getTime(), now, "ko", ko),
    /9월 30일 08:05/,
  );
});

test("NEW 점 — 데스크의 NEW 배지와 같은 판정, 자리가 없는 항목·폴더는 점이 없다 (#16 C-1·C-2)", async () => {
  const { recentItemIsNew, parseRecentResponse, serverClockOffset, recentActionLabel } =
    await import("../src/lib/client/recent-files-view");
  const { ownUploadIndex } = await import("../src/lib/client/new-badges");
  const seenAt = Date.parse("2026-10-07T10:00:00.000Z");
  const state = { since: seenAt - DAY, seen: { root: seenAt }, own: [] };
  const later = "2026-10-07T11:00:00.000Z";
  const earlier = "2026-10-07T09:00:00.000Z";
  const none = ownUploadIndex(null);
  const at = (modifiedAt: string, parentId = "root", isFolder = false) =>
    ({
      location: {
        entry: { id: "a", isFolder, modifiedAt },
        parentId,
        breadcrumbs: [],
        path: "/a",
      },
    }) as never;

  assert.equal(recentItemIsNew(at(later), state, none), true);
  assert.equal(recentItemIsNew(at(earlier), state, none), false);
  // 그 폴더를 본 기록이 없으면 처음 온 기준(since)으로 판정한다.
  assert.equal(recentItemIsNew(at(earlier, "f1"), state, none), true);
  // 내가 올린 그 버전이면 NEW가 아니다.
  const mine = ownUploadIndex({ ...state, own: [{ id: "a", at: Date.parse(later) }] });
  assert.equal(recentItemIsNew(at(later), state, mine), false);
  assert.equal(recentItemIsNew(at(later, "root", true), state, none), false);
  assert.equal(recentItemIsNew({ location: null }, state, none), false);
  assert.equal(recentItemIsNew(at(later), null, none), false);

  assert.equal(recentActionLabel("upload"), "업로드");
  assert.equal(recentActionLabel("edit"), "내용 수정");
  assert.equal(recentActionLabel("rename"), "이름 변경");
  assert.equal(recentActionLabel("move"), "이동");

  assert.equal(serverClockOffset("2026-10-07T10:00:05.000Z", seenAt), 5_000);
  assert.equal(serverClockOffset("엉터리", seenAt), 0);
  assert.equal(serverClockOffset(undefined, seenAt), 0);

  assert.equal(parseRecentResponse(null), null);
  assert.equal(parseRecentResponse({ items: "x" }), null);
  const parsed = parseRecentResponse({
    now: "2026-10-07T10:00:00.000Z",
    days: 7,
    truncated: false,
    explored: 0,
    items: [
      {
        layoutKey: "k",
        name: "a.txt",
        isFolder: false,
        mimeType: null,
        at: "2026-10-07T09:00:00.000Z",
        action: "edit",
        count: 1,
        actor: { name: null, guest: true },
        exists: false,
        location: null,
      },
      { layoutKey: "bad", action: "delete" },
      { layoutKey: "k2", name: "b", isFolder: false, at: "2026-10-07T09:00:00.000Z", action: "edit", count: 1, actor: { name: null, guest: false }, exists: true, location: { entry: {} } },
      null,
    ],
  });
  assert.equal(parsed?.items.length, 1, "꼴이 어긋난 줄은 버린다");
  assert.equal(parsed?.days, 7);
});

test("배선: 사이드바(멤버만) → 최근 파일 창, 한 번=고르기·두 번=열기·위치 열기=원래 자리 (#16 C-1)", async () => {
  const [view, recentWindow, css, i18n] = await Promise.all([
    read("src/app/files/FilesView.tsx"),
    read("src/app/files/RecentFilesWindow.tsx"),
    read("src/app/files/desktop.module.css"),
    import("../src/lib/i18n"),
  ]);

  // 사이드바: 올리기 권한과 무관하되 접속 키 손님에게는 없다(API 403).
  const sidebar = view.slice(view.indexOf('id="desk-sidebar"'));
  const recentButton = sidebar.indexOf("onClick={openRecentWindow}");
  assert.ok(recentButton > 0, "사이드바에 최근 파일 항목이 있다");
  assert.ok(
    recentButton < sidebar.indexOf("{allowUpload && ("),
    "올리기 권한 묶음 밖",
  );
  assert.ok(
    sidebar.lastIndexOf("{!isGuest && (", recentButton) >= 0,
    "손님에게는 숨긴다",
  );
  // 창: 기존 유틸리티 창과 같은 틀·작업표시줄 복원·맨 위 창 판정.
  assert.match(view, /\{recentWindow && !recentWindow\.minimized && \(\s*<RecentFilesWindow/);
  assert.match(view, /onClick=\{focusRecentWindow\}/);
  assert.match(view, /recentWindow && !recentWindow\.minimized \? recentWindow\.z : 0/);
  // 열기·메뉴는 검색 결과의 것을 그대로 — 응답의 location이 검색 결과 꼴이다.
  assert.match(view, /onOpen=\{openSearchResult\}/);
  assert.match(view, /onContextMenu=\{openSearchContextMenu\}/);
  assert.match(view, /onKeyboardMenu=\{openSearchKeyboardMenu\}/);
  assert.match(view, /onReveal=\{revealRecentLocation\}/);
  // 위치 열기 = 검색의 원래 위치. 바탕화면이면 창을 내리지 않고 뒤로 보낸다.
  const reveal = view.slice(
    view.indexOf("function revealRecentLocation"),
    view.indexOf("function revealRecentLocation") + 600,
  );
  assert.match(reveal, /openOriginalLocation\(location\)/);
  assert.match(reveal, /BACK_WINDOW_Z/);
  assert.doesNotMatch(reveal, /minimized: true/);
  // 목록이 뜬 뒤 고른 아이콘을 보이게 하는 일은 openFolderPath가 맡는다(검색과 같다).
  const openPath = view.slice(
    view.indexOf("function openFolderPath"),
    view.indexOf("function openFolder("),
  );
  assert.equal(openPath.match(/\.then\(/g)?.length, 3, "바탕화면·기존 창·새 창");
  assert.match(view, /function revealEntryAfterLoad[\s\S]*?scrollIntoView\(/);
  assert.doesNotMatch(view, /recentRevealRef|recentSearchResult/);

  // 창 컴포넌트: 최소화·최대화·닫기, 기간 칩, 60초 갱신(열려 있고 탭이 보일 때만).
  assert.match(recentWindow, /aria-label=\{t\("최소화"\)\}/);
  assert.match(recentWindow, /maximized \? t\("복원"\) : t\("최대화"\)/);
  assert.match(recentWindow, /styles\.utilityMaximized/);
  assert.match(recentWindow, /\/api\/drive\/recent\?days=\$\{[^}]+\}&limit=\$\{MAX_RECENT_LIMIT\}/);
  assert.match(recentWindow, /RECENT_DAY_CHOICES\.map/);
  assert.match(recentWindow, /setInterval\([\s\S]*?visibilityState !== "visible"[\s\S]*?RECENT_REFRESH_MS/);
  // 한 번 누르기는 고르기만, 두 번은 열기, Enter·위치 열기 단추는 원래 자리. 지연 타이머 없음.
  assert.equal(
    recentWindow.match(/onReveal\(/g)?.length,
    2,
    "원래 자리로 가는 길은 Enter와 위치 열기 단추뿐(한 번 누르기는 고르기만)",
  );
  assert.match(recentWindow, /onDoubleClick=\{[\s\S]*?onOpen\(/);
  assert.match(recentWindow, /event\.key === "Enter"[\s\S]*?onReveal\(/);
  assert.match(recentWindow, /t\("위치 열기"\)/);
  assert.match(recentWindow, /aria-pressed=\{\w+\}/);
  assert.doesNotMatch(recentWindow, /setTimeout\([^)]*onReveal|REVEAL_DELAY/);
  // 지워진 항목은 회색 "지워짐", NEW 점은 데스크와 같은 판정, 별명 없는 멤버는 "멤버".
  assert.match(recentWindow, /styles\.recentGone/);
  assert.match(recentWindow, /t\("지워짐"\)/);
  assert.match(recentWindow, /recentItemIsNew\(/);
  assert.match(recentWindow, /styles\.newDot/);
  assert.match(recentWindow, /guestDisplayName\(/);
  assert.match(recentWindow, /t\("멤버"\)/);

  for (const selector of [".recentFilesWindow", ".recentGone", ".recentSelected", ".recentReveal"]) {
    assert.ok(css.includes(selector), `CSS ${selector}`);
  }

  // 창이 쓰는 문구는 모두 영어 사전에 있고 ja·hi·zh도 번역한다.
  const english = i18n.englishDictionary();
  const literals = [
    ...recentWindow.matchAll(/\bt\(\s*"([^"]+)"/g),
    ...view.matchAll(/\bt\("(최근 파일|파일 기록)"\)/g),
  ].map(([, key]) => key);
  const { recentActionLabel } = await import("../src/lib/client/recent-files-view");
  for (const action of ["upload", "edit", "rename", "move"] as const) {
    literals.push(recentActionLabel(action));
  }
  literals.push("방금 전", "{count}분 전", "{count}시간 전", "어제 {time}");
  assert.ok(literals.length > 15, "문구를 찾았다");
  for (const key of new Set(literals)) {
    assert.ok(key in english, `영어 사전에 없음: ${key}`);
    for (const locale of ["ja", "hi", "zh"] as const) {
      assert.notEqual(
        i18n.translate(locale, key),
        english[key],
        `${locale} 번역이 영어 그대로: ${key}`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 실제 HTTP — 세션·손님·스페이스 범위·limit·직행 완료·휴지통. 다른 통합 테스트와
// 같은 방식으로 next dev를 임시 저장소에 띄운다(실행 전 개발 서버를 꺼 둘 것).

const SESSION_SECRET = ["recent-files-", "session-secret-32-characters"].join("");
const ACCESS_KEY = ["recent-", "guest-key"].join("");

function signed(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET)
    .update(Buffer.from(body, "base64url"))
    .digest("base64url");
  return `sharedesk_session=${body}.${signature}`;
}

const userCookie = (sub: string) =>
  signed({ t: "user", sub, iat: Math.floor(Date.now() / 1000) });
const guestCookie = () =>
  signed({
    t: "key",
    k: createHash("sha256").update(ACCESS_KEY).digest("hex").slice(0, 32),
    iat: Math.floor(Date.now() / 1000),
  });

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("테스트 포트를 만들지 못했습니다"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForServer(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next 테스트 서버가 종료됐습니다 (${child.exitCode})`);
    }
    try {
      const response = await fetch(origin, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // 포트가 열릴 때까지 다시 본다.
    }
    await pause(150);
  }
  throw new Error("Next 테스트 서버가 준비되지 않았습니다");
}

// Windows에서는 부모만 죽이면 자식 프로세스가 dev 잠금·포트를 쥔 채 남을 수 있다.
async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    child.kill();
  }
  await Promise.race([exited, pause(10_000)]);
}

test("HTTP: 멤버만(손님 403)·스페이스 밖 403·limit·기간, 직행 완료는 남의 파일 주인을 바꾸지 않고, 휴지통은 지워짐 (#16 C-1)", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-recent-api-"));
  const stateDir = path.join(root, ".sharedesk");
  const teamState = path.join(root, ".spaces", "team", ".sharedesk");
  await mkdir(stateDir, { recursive: true });
  await mkdir(teamState, { recursive: true });
  await writeFile(
    path.join(stateDir, "users.json"),
    JSON.stringify(
      usersFile([
        member("u-a", "가람구글", "가람"),
        member("u-b", "Beta Lee", null, "viewer"),
        member("u-c", "Carol Park", "나래"),
        member("u-out", "바깥", null),
      ]),
    ),
    "utf8",
  );
  await writeFile(
    path.join(stateDir, "spaces.json"),
    JSON.stringify({
      version: 1,
      spaces: [
        {
          slug: "team",
          name: "팀",
          folderId: ".spaces/team",
          createdAt: "2026-08-01T00:00:00.000Z",
          createdByUserId: "u-a",
        },
      ],
    }),
    "utf8",
  );
  await writeFile(
    path.join(teamState, "users.json"),
    JSON.stringify(usersFile([member("u-c", "Carol Park", "나래")])),
    "utf8",
  );

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "dev", "-p", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_ROOT: root,
      SESSION_SECRET,
      ADMIN_EMAILS: "",
      PUBLIC_BASE_URL: origin,
      ACCESS_KEYS: ACCESS_KEY,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  // 출력을 읽어 주지 않으면 파이프가 차서 서버가 멈춘다. 끝부분만 남겨
  // 실패했을 때 보여 준다.
  let serverLog = "";
  const keepLog = (chunk: Buffer) => {
    serverLog = (serverLog + chunk.toString("utf8")).slice(-8_000);
  };
  child.stdout?.on("data", keepLog);
  child.stderr?.on("data", keepLog);
  t.after(async () => {
    await stopServer(child);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  t.after(() => {
    if (process.exitCode) console.error(`[next dev 로그 끝]\n${serverLog}`);
  });
  try {
    await waitForServer(origin, child);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${serverLog}`);
  }

  const alpha = userCookie("u-a");
  const viewer = userCookie("u-b");
  const carol = userCookie("u-c");
  const outsider = userCookie("u-out");
  const guest = guestCookie();
  // 요청마다 상한을 둔다 — 첫 요청은 라우트를 컴파일하느라 오래 걸릴 수 있다.
  const call = (pathname: string, cookie: string | null, init: RequestInit = {}) =>
    fetch(`${origin}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(90_000),
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
  const postJson = (pathname: string, cookie: string, body: unknown) =>
    call(pathname, cookie, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  type Entry = {
    id: string;
    name: string;
    version: string;
    layoutKey: string;
    size: number;
  };
  const uploadText = async (prefix: string, cookie: string, name: string) => {
    const response = await call(
      `${prefix}/api/drive/upload?parentId=root&name=${encodeURIComponent(name)}`,
      cookie,
      { method: "POST", headers: { "Content-Type": "text/plain" }, body: name },
    );
    assert.equal(response.status, 201, `${name} 업로드`);
    return ((await response.json()) as { entry: Entry }).entry;
  };
  const recent = async (prefix: string, cookie: string | null, query = "") =>
    call(`${prefix}/api/drive/recent${query}`, cookie);
  // 기록은 응답 뒤(after)에 남으므로 조건이 맞을 때까지 기다린다.
  const settle = async (
    prefix: string,
    cookie: string,
    ready: (body: RecentFilesResponse) => boolean,
    label: string,
  ) => {
    const deadline = Date.now() + 15_000;
    let body: RecentFilesResponse | null = null;
    while (Date.now() < deadline) {
      const response = await recent(prefix, cookie);
      assert.equal(response.status, 200);
      body = (await response.json()) as RecentFilesResponse;
      if (ready(body)) return body;
      await pause(150);
    }
    assert.fail(`${label}: ${JSON.stringify(body)}`);
  };
  const rows = (count: number) => (body: RecentFilesResponse) =>
    body.items.length >= count;

  // 세션이 없으면 401, 접속 키 손님은 403(누가 무엇을 바꿨는지 보지 않는다).
  assert.equal((await recent("", null)).status, 401);
  assert.equal((await recent("", guest)).status, 403);

  // 가람이 올리고 이름을 바꾸고 본문을 고치고, 손님이 올린다. 한 단계의 기록이
  // 남은 뒤에 다음 단계로 간다(응답 뒤 기록끼리 순서가 뒤바뀌지 않게).
  const first = await uploadText("", alpha, "보고서.txt");
  await settle("", alpha, rows(1), "업로드");
  const renamedResponse = await postJson("/api/drive/rename", alpha, {
    id: first.id,
    name: "최종 보고서.txt",
    expectedVersion: first.version,
  });
  assert.equal(renamedResponse.status, 200);
  const renamed = ((await renamedResponse.json()) as { entry: Entry }).entry;
  await settle("", alpha, rows(2), "이름 변경");
  const editedResponse = await call("/api/drive/content", alpha, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: renamed.id,
      expectedVersion: renamed.version,
      mimeType: "text/plain",
      content: "고친 본문",
    }),
  });
  assert.equal(editedResponse.status, 200);
  await settle("", alpha, rows(3), "본문 수정");
  await uploadText("", guest, "손님메모.txt");

  // 보기 전용 멤버도 본다 — 시간 역순·행위자 별명(실명은 나가지 않는다).
  const listed = await settle("", viewer, rows(4), "보기 전용 멤버");
  assert.deepEqual(
    listed.items.map((item) => [item.name, item.action, item.actor]),
    [
      ["손님메모.txt", "upload", { name: null, guest: true }],
      ["최종 보고서.txt", "edit", { name: "가람", guest: false }],
      ["최종 보고서.txt", "rename", { name: "가람", guest: false }],
      ["최종 보고서.txt", "upload", { name: "가람", guest: false }],
    ],
  );
  assert.equal(
    listed.items.every((item) => item.exists === true),
    true,
    "지금 있는 항목은 exists=true",
  );
  assert.equal(listed.items[1].location?.breadcrumbs[0]?.id, "root");
  assert.doesNotMatch(JSON.stringify(listed), /가람구글|Beta Lee/, "실명이 응답에 없다");

  // limit·기간 검증.
  const limited = await recent("", viewer, "?limit=1&days=1");
  assert.equal(limited.status, 200);
  const limitedBody = (await limited.json()) as RecentFilesResponse;
  assert.equal(limitedBody.items.length, 1);
  assert.equal(limitedBody.days, 1);
  for (const bad of ["?days=0", "?days=31", "?limit=abc"]) {
    assert.equal((await recent("", viewer, bad)).status, 400, bad);
  }

  // 직행 완료(drive) — local은 직행 예약을 만들지 않으므로 예약 장부에 직접 넣는다.
  const reservations = path.join(stateDir, "upload-reservations.json");
  const reserve = (id: string, name: string, size: number) =>
    writeFile(
      reservations,
      JSON.stringify({
        version: 3,
        reservations: [
          {
            id,
            userId: "u-c",
            parentId: "root",
            publicFolderId: null,
            name,
            size,
            transport: "direct",
            claimedAt: null,
            expiresAt: new Date(Date.now() + DAY).toISOString(),
            createdAt: new Date().toISOString(),
          },
        ],
        completedUploads: [],
      }),
      "utf8",
    );
  // (1) 가람의 기존 파일 id로 나래가 완료를 부른다 — 주인이 바뀌면 안 된다.
  const existing = await uploadText("", alpha, "기존.txt");
  await settle("", alpha, (body) => body.items.some((item) => item.name === "기존.txt"), "기존.txt");
  await pause(20);
  await reserve("reservation-old", existing.name, existing.size);
  const hijack = await postJson("/api/drive/upload-complete", carol, {
    reservationId: "reservation-old",
    fileId: existing.id,
  });
  assert.equal(hijack.status, 200, await hijack.clone().text());
  // (2) 예약 뒤 새로 생긴 파일은 나래의 업로드로 남는다(응답 뒤 기록이 차례로 돈다).
  await reserve("reservation-new", "직행.txt", Buffer.byteLength("직행 본문"));
  await pause(20);
  await writeFile(path.join(root, "직행.txt"), "직행 본문", "utf8");
  const direct = await postJson("/api/drive/upload-complete", carol, {
    reservationId: "reservation-new",
    fileId: Buffer.from("직행.txt", "utf8").toString("base64url"),
  });
  assert.equal(direct.status, 200, await direct.clone().text());
  const afterDirect = await settle(
    "",
    alpha,
    (body) => body.items.some((item) => item.name === "직행.txt"),
    "직행 완료 기록",
  );
  const uploaderOf = (name: string) =>
    afterDirect.items.find((item) => item.name === name && item.action === "upload")
      ?.actor;
  assert.deepEqual(uploaderOf("직행.txt"), { name: "나래", guest: false });
  assert.deepEqual(
    uploaderOf("기존.txt"),
    { name: "가람", guest: false },
    "기존 파일의 올린 사람은 그대로",
  );

  // 휴지통 — 지운 파일은 "지워짐"으로 남는다(휴지통 기록으로 판정).
  const deleted = await postJson("/api/drive/delete", alpha, { id: existing.id });
  assert.equal(deleted.status, 200);
  await settle(
    "",
    alpha,
    (body) =>
      body.items.some((item) => item.name === "기존.txt" && item.exists === false),
    "휴지통 기록",
  );

  // 스페이스: 멤버만, 그 스페이스의 내력만.
  await uploadText("/team", carol, "팀파일.txt");
  const team = await settle("/team", carol, rows(1), "스페이스");
  assert.deepEqual(
    team.items.map((item) => item.name),
    ["팀파일.txt"],
  );
  assert.equal((await recent("/team", outsider)).status, 403);
  const base = (await (await recent("", viewer)).json()) as RecentFilesResponse;
  assert.equal(
    base.items.some((item) => item.name === "팀파일.txt"),
    false,
    "기본 데스크에는 스페이스 파일이 없다",
  );
});
