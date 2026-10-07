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
  MAX_RECENT_LIMIT,
  parseRecentQuery,
  RECENT_DAY_CHOICES,
  recentActor,
  recentItem,
  type RecentFilesResponse,
} from "../src/lib/recent-files";

// 최근 파일(#16 C-1) — 순수 함수(기간·묶기·행위자) → 항목별 내력 기록 →
// 불러오기(지금 자리·사라짐·스페이스 범위) → 배선 → 실제 HTTP(세션·스페이스·limit).

const read = (relative: string) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW - offsetMs).toISOString();

test("기간·개수 읽기 — 1~30일(기본 7), 개수는 1 이상·200까지 (#16 C-1)", () => {
  assert.deepEqual([...RECENT_DAY_CHOICES], [1, 3, 7, 30]);
  assert.equal(DEFAULT_RECENT_DAYS, 7);
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

test("묶기·기간 거르기·시간 역순 — 같은 항목의 잇단 같은 행위(같은 사람)만 한 줄 (#16 C-1)", () => {
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
  };

  const week = buildRecentRows(audits, { now: NOW, days: 7, limit: 200 });
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
      ["k:c", "move", 2, NOW - 2 * DAY],
    ],
  );
  assert.equal(week[0].guest, true);
  assert.equal(week[0].by, "홍길동");
  assert.equal(week[1].byId, "u-a");

  // 기간 칩: 하루면 사흘 전 이동이 빠지고, 한 달이면 열흘 전 업로드가 들어온다.
  const day = buildRecentRows(audits, { now: NOW, days: 1, limit: 200 });
  assert.ok(
    day.every((row) => row.at >= NOW - DAY),
    "하루 칩은 24시간 안의 줄만",
  );
  assert.equal(day.some((row) => row.layoutKey === "k:c"), false);
  const month = buildRecentRows(audits, { now: NOW, days: 30, limit: 200 });
  assert.deepEqual(month.at(-1), {
    layoutKey: "k:a",
    at: NOW - 10 * DAY,
    action: "upload",
    count: 1,
    by: "가람구글",
    byId: "u-a",
    guest: false,
  });
  // 기간 경계 바로 밖의 이동은 묶음 수에서도 빠진다(먼저 거르고 묶는다).
  const threeDays = buildRecentRows(
    { "k:c": audits["k:c"] },
    { now: NOW, days: 3, limit: 200 },
  );
  assert.equal(threeDays[0].count, 2);
  const halfDayLater = buildRecentRows(
    { "k:c": audits["k:c"] },
    { now: NOW + 12 * HOUR, days: 3, limit: 200 },
  );
  assert.equal(halfDayLater[0].count, 1);

  // limit은 묶은 뒤의 줄 수다.
  assert.deepEqual(
    buildRecentRows(audits, { now: NOW, days: 7, limit: 2 }).map(
      (row) => row.layoutKey,
    ),
    ["k:b", "k:a"],
  );
  assert.deepEqual(buildRecentRows({}, { now: NOW, days: 7, limit: 10 }), []);
});

test("행위자 — 멤버는 지금 화면 이름, 접속 키·공개 폴더 손님은 손님 (#16 C-1)", () => {
  const names = new Map([["u-a", "가람"]]);
  assert.deepEqual(
    recentActor({ by: "가람구글", byId: "u-a", guest: false }, names),
    { name: "가람", guest: false },
  );
  assert.deepEqual(
    recentActor({ by: "떠난사람", byId: "u-gone", guest: false }, names),
    { name: "떠난사람", guest: false },
    "명단에 없으면 기록 당시 이름",
  );
  assert.deepEqual(
    recentActor({ by: "손님", byId: "key:abcd1234", guest: false }, names),
    { name: null, guest: true },
  );
  assert.deepEqual(
    recentActor({ by: "홍길동", byId: null, guest: true }, names),
    { name: "홍길동", guest: true },
  );
  assert.deepEqual(recentActor({ by: null, byId: null, guest: true }, names), {
    name: null,
    guest: true,
  });
});

test("응답 항목 — 지금 자리, 사라짐(회색), 확인 못 함, 이름 모르는 옛 기록은 뺀다 (#16 C-1)", () => {
  const row = {
    layoutKey: "k:a",
    at: NOW,
    action: "edit" as const,
    count: 2,
    by: "가람구글",
    byId: "u-a",
    guest: false,
  };
  const entry = {
    id: "id-a",
    layoutKey: "k:a",
    name: "지금이름.txt",
    isFolder: false,
    size: 3,
    modifiedAt: iso(0),
    mimeType: "text/plain",
    version: "v1",
  };
  const path = [
    { id: "root", name: "ShareDesk" },
    { id: "f1", name: "문서" },
  ];
  const present = recentItem(
    row,
    { name: "옛이름.txt" },
    { entry, parentId: "f1", path },
    true,
    new Map(),
  );
  assert.equal(present?.exists, true);
  assert.equal(present?.id, "id-a");
  assert.equal(present?.name, "지금이름.txt", "지금 이름이 우선");
  assert.deepEqual(present?.path, path);
  assert.equal(present?.parentId, "f1");
  assert.equal(present?.at, new Date(NOW).toISOString());
  assert.equal(present?.count, 2);

  const gone = recentItem(row, { name: "옛이름.txt", isFolder: true }, undefined, true, new Map());
  assert.equal(gone?.exists, false);
  assert.equal(gone?.id, null);
  assert.equal(gone?.entry, null);
  assert.equal(gone?.name, "옛이름.txt");
  assert.equal(gone?.isFolder, true);
  assert.deepEqual(gone?.path, []);

  const unknown = recentItem(row, { name: "옛이름.txt" }, undefined, false, new Map());
  assert.equal(unknown?.exists, null, "탐색 상한에 걸리면 사라졌다고 단정하지 않는다");

  assert.equal(recentItem(row, {}, undefined, true, new Map()), null);
  assert.equal(recentItem(row, undefined, undefined, true, new Map()), null);
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

test("항목별 내력 — 수정·이름 변경·이동을 남기고, 열쇠가 바뀌면 앞 기록을 옮긴다 (#16 C-1)", async () => {
  await withLocalStorage(async () => {
    const { getAdapter } = await import("../src/lib/storage");
    const { ROOT_ID } = await import("../src/lib/storage/types");
    const audit = await import("../src/lib/entry-audit");
    const adapter = getAdapter();
    const alpha = { userId: "u-a", name: "가람구글" };
    const beta = { userId: "u-b", name: "베타" };

    const uploaded = await adapter.upload(ROOT_ID, "메모.txt", "text/plain", text("a"));
    await audit.recordEntryUpload(uploaded.layoutKey, alpha.name, {
      userId: alpha.userId,
      name: uploaded.name,
    });
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
    assert.equal(record?.uploadedAt !== undefined, true);

    // 폴더 이름 변경은 폴더 표시를 남긴다.
    const folder = await adapter.createFolder(ROOT_ID, "사진");
    await audit.recordEntryChange(folder, alpha, "rename");
    assert.equal((await audit.getEntryAudit(folder.layoutKey))?.isFolder, true);

    // 공개 폴더 손님이 같은 자리에 다시 올리면 앞 주인의 id가 남지 않는다.
    await audit.recordEntryGuestUpload(edited.layoutKey, null, { name: "회의록.txt" });
    record = await audit.getEntryAudit(edited.layoutKey);
    assert.equal(record?.uploadedById, undefined);
    assert.equal(record?.uploadedByGuest, true);

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
            { at: iso(0), kind: "delete", by: "가" },
            { at: iso(0), kind: "edit", by: "" },
            { at: iso(0), kind: "move", by: "멤버", byId: `x${String.fromCharCode(7)}` },
            { at: iso(0), kind: "rename", by: "멤버", byId: "u-ok" },
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
      { at: iso(0), kind: "rename", by: "멤버", byId: "u-ok" },
    ]);
  });
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

test("최근 파일 불러오기 — 지금 자리·사라짐·화면 이름·limit (#16 C-1)", async () => {
  await withLocalStorage(async () => {
    const { getAdapter } = await import("../src/lib/storage");
    const { ROOT_ID } = await import("../src/lib/storage/types");
    const audit = await import("../src/lib/entry-audit");
    const { loadRecentFiles, locateByLayoutKey } = await import(
      "../src/lib/recent-files-load"
    );
    const adapter = getAdapter();
    await adapter.writeState(
      "users.json",
      usersFile([member("u-a", "가람구글", "가람"), member("u-b", "베타", null)]),
    );

    const folder = await adapter.createFolder(ROOT_ID, "사진");
    const inRoot = await adapter.upload(ROOT_ID, "a.txt", "text/plain", text("a"));
    await audit.recordEntryUpload(inRoot.layoutKey, "가람구글", {
      userId: "u-a",
      name: inRoot.name,
    });
    await pause(5);
    const inFolder = await adapter.upload(folder.id, "b.png", "image/png", text("b"));
    await audit.recordEntryUpload(inFolder.layoutKey, "베타", {
      userId: "u-b",
      name: inFolder.name,
    });
    await pause(5);
    const doomed = await adapter.upload(ROOT_ID, "c.txt", "text/plain", text("c"));
    await audit.recordEntryUpload(doomed.layoutKey, "손님", {
      userId: "key:abcd1234",
      name: doomed.name,
    });
    await adapter.remove(doomed.id);
    // 이름을 모르는 옛 기록이 가리키던 항목은 이제 없다 — 줄에서 빠진다.
    await audit.recordEntryUpload("local:legacy:gone", "옛사람");
    await pause(5);
    await audit.recordEntryChange(inRoot, { userId: "u-a", name: "가람구글" }, "edit");

    const all = await loadRecentFiles({ days: 7, limit: 200 });
    assert.equal(all.truncated, false);
    assert.equal(all.days, 7);
    assert.ok(Number.isFinite(Date.parse(all.now)), "서버 시각을 함께 준다");
    assert.deepEqual(
      all.items.map((item) => [item.name, item.action, item.exists]),
      [
        ["a.txt", "edit", true],
        ["c.txt", "upload", false],
        ["b.png", "upload", true],
        ["a.txt", "upload", true],
      ],
    );
    const [edit, gone, png] = all.items;
    assert.deepEqual(edit.actor, { name: "가람", guest: false }, "별명이 화면 이름");
    assert.equal(edit.parentId, ROOT_ID);
    assert.deepEqual(edit.path, [{ id: ROOT_ID, name: "ShareDesk" }]);
    assert.equal(edit.entry?.id, inRoot.id);
    assert.equal(edit.id, inRoot.id);
    assert.deepEqual(gone.actor, { name: null, guest: true }, "접속 키 손님");
    assert.equal(gone.id, null);
    assert.deepEqual(gone.path, []);
    assert.deepEqual(png.actor, { name: "베타", guest: false }, "별명이 없으면 이름");
    assert.equal(png.parentId, folder.id);
    assert.deepEqual(png.path, [
      { id: ROOT_ID, name: "ShareDesk" },
      { id: folder.id, name: "사진" },
    ]);

    const one = await loadRecentFiles({ days: 7, limit: 1 });
    assert.deepEqual(
      one.items.map((item) => item.name),
      ["a.txt"],
    );

    // 탐색 상한에 걸리면 complete=false — 못 찾은 항목을 사라졌다고 하지 않는다.
    const partial = await locateByLayoutKey(new Set([inFolder.layoutKey]), adapter, {
      maxTraversal: 1,
    });
    assert.equal(partial.complete, false);
    assert.equal(partial.found.size, 0);
    const whole = await locateByLayoutKey(new Set([inFolder.layoutKey]), adapter);
    assert.equal(whole.complete, true);
    assert.equal(whole.found.get(inFolder.layoutKey)?.parentId, folder.id);
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
    await audit.recordEntryUpload(base.layoutKey, actor.name, {
      userId: actor.userId,
      name: base.name,
    });
    await runWithSpace(space, async () => {
      const inTeam = await adapter.upload(ROOT_ID, "team.txt", "text/plain", text("t"));
      await audit.recordEntryUpload(inTeam.layoutKey, actor.name, {
        userId: actor.userId,
        name: inTeam.name,
      });
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

test("배선: 최근 파일 API는 세션만 요구하고 쓰기 라우트가 내력을 남긴다 (#16 C-1)", async () => {
  const [route, content, rename, move, complete, upload] = await Promise.all([
    read("src/app/api/drive/recent/route.ts"),
    read("src/app/api/drive/content/route.ts"),
    read("src/app/api/drive/rename/route.ts"),
    read("src/app/api/drive/move/route.ts"),
    read("src/app/api/drive/upload-complete/route.ts"),
    read("src/app/api/drive/upload/route.ts"),
  ]);

  // 관리자 전용이 아니다 — 멤버 누구나(스페이스 문맥은 러너가 세운다).
  assert.match(route, /export async function GET\(req: NextRequest\)/);
  assert.match(route, /runWithSession\(null,/);
  assert.doesNotMatch(route, /runWithAdmin|runWithEditRights|runWithUploadRights/);
  assert.match(route, /parseRecentQuery\(req\.nextUrl\.searchParams\)/);
  assert.match(route, /\{ status: 400 \}/);
  assert.match(route, /loadRecentFiles\(query, \{ signal: req\.signal \}\)/);

  assert.match(
    content,
    /recordEntryChangeAfter\(entry, session, "edit", \{\s*previousLayoutKey: current\.layoutKey,\s*\}\)/,
  );
  assert.match(rename, /recordEntryChangeAfter\(entry, session, "rename"\)/);
  assert.match(move, /recordEntryChangeAfter\(entry, session, "move"\)/);
  // 내력은 본 작업이 성공한 뒤에만 남긴다(import 줄이 아니라 호출부로 견준다).
  assert.ok(
    rename.indexOf("recordEntryChangeAfter(entry") >
      rename.indexOf("getAdapter().rename("),
    "이름 변경이 끝난 뒤에 기록한다",
  );
  assert.ok(
    move.indexOf("recordEntryChangeAfter(entry") >
      move.indexOf("getAdapter().move("),
    "이동이 끝난 뒤에 기록한다",
  );
  // drive 직행 업로드도 프록시 업로드와 같은 기록을 남긴다.
  for (const source of [complete, upload]) {
    assert.match(
      source,
      /recordEntryUploadAfter\(entry\.layoutKey, session\.name, \{\s*userId: session\.userId,\s*name: entry\.name,\s*\}\)/,
    );
  }
  assert.ok(
    complete.indexOf("recordEntryUploadAfter(entry") >
      complete.indexOf("await finishUploadReservation("),
    "예약을 마친 뒤에 기록한다",
  );
});

// ---------------------------------------------------------------------------
// 실제 HTTP — 세션·스페이스 범위·limit. 다른 통합 테스트와 같은 방식으로
// next dev를 임시 저장소에 띄운다(실행 전 개발 서버를 꺼 둘 것).

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

test("HTTP: 세션이 있어야 하고, 스페이스 밖은 못 보며, limit·기간을 지킨다 (#16 C-1)", async (t) => {
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
        member("u-b", "베타", null),
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
    JSON.stringify(usersFile([member("u-b", "베타", null)])),
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
  const beta = userCookie("u-b");
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
  type Entry = { id: string; name: string; version: string; layoutKey: string };
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
  // 기록은 응답 뒤(after)에 남으므로 기대한 줄 수가 될 때까지 기다린다.
  const settle = async (prefix: string, cookie: string, count: number) => {
    const deadline = Date.now() + 15_000;
    let body: RecentFilesResponse | null = null;
    while (Date.now() < deadline) {
      const response = await recent(prefix, cookie);
      assert.equal(response.status, 200);
      body = (await response.json()) as RecentFilesResponse;
      if (body.items.length >= count) return body;
      await pause(150);
    }
    assert.fail(`최근 파일이 ${count}줄이 되지 않았습니다: ${JSON.stringify(body)}`);
  };

  // 세션이 없으면 401(proxy 또는 러너).
  assert.equal((await recent("", null)).status, 401);

  // 가람이 올리고 이름을 바꾸고 본문을 고치고, 손님이 올린다. 한 단계의 기록이
  // 남은 뒤에 다음 단계로 간다(응답 뒤 기록끼리 순서가 뒤바뀌지 않게).
  const first = await uploadText("", alpha, "보고서.txt");
  await settle("", alpha, 1);
  const renamedResponse = await postJson("/api/drive/rename", alpha, {
    id: first.id,
    name: "최종 보고서.txt",
    expectedVersion: first.version,
  });
  assert.equal(renamedResponse.status, 200);
  const renamed = ((await renamedResponse.json()) as { entry: Entry }).entry;
  await settle("", alpha, 2);
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
  await settle("", alpha, 3);
  await uploadText("", guest, "손님메모.txt");

  // 베타(멤버, 관리자 아님)도 본다 — 시간 역순·행위자 화면 이름.
  const listed = await settle("", beta, 4);
  assert.deepEqual(
    listed.items.map((item) => [item.name, item.action, item.actor]),
    [
      ["손님메모.txt", "upload", { name: null, guest: true }],
      ["최종 보고서.txt", "edit", { name: "가람", guest: false }],
      ["최종 보고서.txt", "rename", { name: "가람", guest: false }],
      ["최종 보고서.txt", "upload", { name: "가람", guest: false }],
    ],
  );
  assert.ok(
    listed.items.every((item) => item.exists === true),
    "지금 있는 항목은 exists=true",
  );
  assert.equal(listed.items[1].path[0]?.id, "root");

  // limit·기간 검증.
  const limited = await recent("", beta, "?limit=1&days=1");
  assert.equal(limited.status, 200);
  const limitedBody = (await limited.json()) as RecentFilesResponse;
  assert.equal(limitedBody.items.length, 1);
  assert.equal(limitedBody.days, 1);
  for (const bad of ["?days=0", "?days=31", "?limit=abc"]) {
    assert.equal((await recent("", beta, bad)).status, 400, bad);
  }

  // 스페이스: 멤버만, 그 스페이스의 내력만.
  await uploadText("/team", beta, "팀파일.txt");
  const team = await settle("/team", beta, 1);
  assert.deepEqual(
    team.items.map((item) => item.name),
    ["팀파일.txt"],
  );
  assert.equal((await recent("/team", outsider)).status, 403);
  const base = (await (await recent("", beta)).json()) as RecentFilesResponse;
  assert.equal(
    base.items.some((item) => item.name === "팀파일.txt"),
    false,
    "기본 데스크에는 스페이스 파일이 없다",
  );
});
