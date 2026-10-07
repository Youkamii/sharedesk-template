import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createWindowLimiter } from "../src/lib/rate-window";
import { createSerialQueue } from "../src/lib/serial-queue";
import {
  applyShareLinkDownload,
  MAX_TRACKED_LINKS,
  normalizeShareLinkDownloads,
  RECORD_LIMIT_PER_LINK,
  RECORD_LIMIT_TOTAL,
  withShareLinkDownloads,
} from "../src/lib/share-link-downloads";

// 공유 링크 "받아 갔는지"(#17 B-7): 기록 상한(창 카운터), 링크별 장부(순수
// 함수), 실제 /api/share/<linkId> 핸들러로 무엇을 세고 무엇을 안 세는지,
// 링크 정리 때 장부도 지워지는지, 화면·API 배선.

const read = (relative: string) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

const linkIdOf = (seed: number) => seed.toString(16).padStart(48, "0");

test("창 카운터: 키별·전역 상한, 창이 지나면 다시 센다", () => {
  const limited = createWindowLimiter({ windowMs: 1_000, perKey: 3, total: 5 });
  const t0 = 10_000;
  // 키 하나는 3번까지 통과, 4번째부터 넘음.
  assert.deepEqual(
    [1, 2, 3, 4].map(() => limited("a", t0)),
    [false, false, false, true],
  );
  // 전역 상한 5: 이미 4번 셌으니 다른 키도 한 번만 통과.
  assert.equal(limited("b", t0), false);
  assert.equal(limited("c", t0), true, "전역 상한을 넘었다");
  // 창이 지나면 둘 다 새로 센다.
  assert.equal(limited("a", t0 + 1_001), false);
  assert.equal(limited("c", t0 + 1_001), false);
});

test("기록 상한: 링크당 분당 6회·전역 분당 60회 (#17 B-7)", () => {
  assert.equal(RECORD_LIMIT_PER_LINK, 6);
  assert.equal(RECORD_LIMIT_TOTAL, 60);
  const limited = createWindowLimiter({
    windowMs: 60_000,
    perKey: RECORD_LIMIT_PER_LINK,
    total: RECORD_LIMIT_TOTAL,
  });
  const hits = Array.from({ length: 10 }, () => limited(linkIdOf(1), 0));
  assert.equal(hits.filter((over) => !over).length, RECORD_LIMIT_PER_LINK);
  // 링크를 바꿔 가며 몰아쳐도 전역 상한에서 멈춘다 — 넘은 시도도 전역 창에
  // 세므로, 창 하나에서 통과는 60번을 넘지 못하고 60번째 시도 뒤로는 전부 막힌다.
  const spread = Array.from({ length: 200 }, (_, index) =>
    limited(linkIdOf(1_000 + index), 0),
  );
  const passed = RECORD_LIMIT_PER_LINK + spread.filter((over) => !over).length;
  assert.ok(passed <= RECORD_LIMIT_TOTAL);
  assert.ok(
    spread.slice(RECORD_LIMIT_TOTAL - 10).every((over) => over),
    "전역 60번째 시도 뒤로는 기록하지 않는다",
  );
  assert.equal(spread.filter((over) => !over).length, RECORD_LIMIT_TOTAL - 10);
});

test("한 줄 쓰기: 겹쳐 들어온 작업을 차례로 돌리고, 실패해도 다음은 돈다", async () => {
  const enqueue = createSerialQueue();
  const order: string[] = [];
  let running = 0;
  let maxRunning = 0;
  const task = (label: string, fail = false) => () =>
    (async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(label);
      running -= 1;
      if (fail) throw new Error(label);
      return label;
    })();
  const results = await Promise.allSettled([
    enqueue(task("a")),
    enqueue(task("b", true)),
    enqueue(task("c")),
  ]);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(maxRunning, 1, "한 번에 하나만");
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "rejected", "fulfilled"],
  );
});

test("장부: 받을 때마다 1씩 늘고 마지막 시각이 바뀐다 (#17 B-7)", () => {
  const empty = normalizeShareLinkDownloads(null);
  assert.deepEqual(empty, { version: 1, links: {} });

  const id = linkIdOf(1);
  const once = applyShareLinkDownload(empty, id, "2026-10-07T01:00:00.000Z");
  assert.deepEqual(once.links[id], { count: 1, lastAt: "2026-10-07T01:00:00.000Z" });
  const twice = applyShareLinkDownload(once, id, "2026-10-07T02:00:00.000Z");
  assert.deepEqual(twice.links[id], { count: 2, lastAt: "2026-10-07T02:00:00.000Z" });
  // 원본을 고치지 않는다(CAS 재시도에서 같은 입력을 다시 쓸 수 있어야 한다).
  assert.equal(once.links[id].count, 1);
  // 링크 id 꼴이 아니면 장부를 건드리지 않는다.
  assert.equal(applyShareLinkDownload(twice, "nope", "2026-10-07T03:00:00.000Z"), twice);
});

test("장부: 넘치면 활성 링크는 지키고 죽은 링크부터 버린다 (#17 B-7)", () => {
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
  const keeper = linkIdOf(1);
  // 가장 오래된 기록을 가진 활성 링크 1개 + 새 링크 400개.
  let file = applyShareLinkDownload(normalizeShareLinkDownloads(null), keeper, at(0));
  const active = new Set([keeper]);
  for (let index = 0; index < MAX_TRACKED_LINKS; index += 1) {
    file = applyShareLinkDownload(file, linkIdOf(index + 2), at(index + 1), active);
  }
  assert.equal(Object.keys(file.links).length, MAX_TRACKED_LINKS);
  assert.ok(file.links[keeper], "lastAt이 제일 오래돼도 활성 링크는 남는다");
  assert.equal(file.links[linkIdOf(2)], undefined, "죽은 링크 중 가장 오래된 것이 빠진다");

  // 활성 목록이 없으면(넘치기 전 빠른 길) 그냥 오래된 것부터.
  let plain = normalizeShareLinkDownloads(null);
  for (let index = 0; index <= MAX_TRACKED_LINKS; index += 1) {
    plain = applyShareLinkDownload(plain, linkIdOf(index + 1), at(index));
  }
  assert.equal(Object.keys(plain.links).length, MAX_TRACKED_LINKS);
  assert.equal(plain.links[linkIdOf(1)], undefined);
});

test("장부: 손상된 값은 버리고 정상 값만 남긴다", () => {
  const good = linkIdOf(7);
  const file = normalizeShareLinkDownloads({
    links: {
      [good]: { count: 3.9, lastAt: "2026-10-07T00:00:00Z" },
      [linkIdOf(8)]: { count: 0, lastAt: "2026-10-07T00:00:00Z" },
      [linkIdOf(9)]: { count: 2, lastAt: "어제" },
      [linkIdOf(10)]: null,
      "../escape": { count: 1, lastAt: "2026-10-07T00:00:00Z" },
    },
  });
  assert.deepEqual(file.links, {
    [good]: { count: 3, lastAt: "2026-10-07T00:00:00.000Z" },
  });
  assert.deepEqual(normalizeShareLinkDownloads({ links: [] }).links, {});
});

test("목록 덧붙이기: 기록 없는 링크는 0회·null", () => {
  const seen = linkIdOf(11);
  const merged = withShareLinkDownloads(
    [
      { linkId: seen, name: "a.txt" },
      { linkId: linkIdOf(12), name: "b.txt" },
      // 프로토타입 키 이름과 겹쳐도 남의 값을 읽지 않는다.
      { linkId: "constructor", name: "c.txt" },
    ],
    { [seen]: { count: 4, lastAt: "2026-10-07T05:00:00.000Z" } },
  );
  assert.deepEqual(
    merged.map(({ downloadCount, lastDownloadAt }) => ({ downloadCount, lastDownloadAt })),
    [
      { downloadCount: 4, lastDownloadAt: "2026-10-07T05:00:00.000Z" },
      { downloadCount: 0, lastDownloadAt: null },
      { downloadCount: 0, lastDownloadAt: null },
    ],
  );
  assert.equal(merged[0].name, "a.txt");
});

async function withLocalStorage(run: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sharedesk-link-downloads-"));
  const previousDriver = process.env.STORAGE_DRIVER;
  const previousRoot = process.env.LOCAL_STORAGE_ROOT;
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  try {
    await run();
  } finally {
    if (previousDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = previousDriver;
    if (previousRoot === undefined) delete process.env.LOCAL_STORAGE_ROOT;
    else process.env.LOCAL_STORAGE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

// 기록은 응답 뒤(after) 최선 노력이라, 핸들러를 직접 부르면 기다려 줘야 한다.
async function eventually<T>(
  probe: () => Promise<T | null | undefined | false>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`기다렸지만 기록이 없다 — ${label}`);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

async function loadModules() {
  const [storage, types, shareLinks, downloads, audit, server, route, space] =
    await Promise.all([
      import("../src/lib/storage"),
      import("../src/lib/storage/types"),
      import("../src/lib/share-links"),
      import("../src/lib/share-link-downloads"),
      import("../src/lib/entry-audit"),
      import("next/server"),
      import("../src/app/api/share/[linkId]/route"),
      import("../src/lib/space-store"),
    ]);
  const call = (
    linkId: string,
    query = "",
    init?: { method?: string; headers?: Record<string, string> },
  ) =>
    route.GET(
      new server.NextRequest(`http://localhost/api/share/${linkId}${query}`, init),
      { params: Promise.resolve({ linkId }) },
    );
  const countOf = async (linkId: string) =>
    (await downloads.readShareLinkDownloads())[linkId]?.count ?? 0;
  return {
    adapter: storage.getAdapter(),
    ROOT_ID: types.ROOT_ID,
    shareLinks,
    downloads,
    audit,
    space,
    call,
    countOf,
  };
}

test("API: 처음부터 받은 것만 세고, 범위·HEAD·목록은 세지 않으며, 멤버 기록을 밀어내지 않는다 (#17 B-7)", async () => {
  await withLocalStorage(async () => {
    const { adapter, ROOT_ID, shareLinks, audit, space, call, countOf } =
      await loadModules();
    await space.runWithSpace(null, async () => {
      const file = await adapter.upload(
        ROOT_ID,
        "report.txt",
        "text/plain",
        new Blob(["hello world"]).stream(),
      );
      const fileLink = await shareLinks.createShareLink(file.id, "report.txt", "Tester", 1, {
        createdByUserId: "u-1",
      });
      // 멤버가 데스크에서 받은 기록이 하나 있다.
      await audit.recordEntryDownload(file.layoutKey, "멤버");

      // 세지 않는 요청: 이어받기 범위·HEAD·manifest.
      const ranged = await call(fileLink.linkId, "", { headers: { range: "bytes=3-" } });
      assert.equal(ranged.status, 206);
      await ranged.arrayBuffer();
      const head = await call(fileLink.linkId, "", { method: "HEAD" });
      assert.ok(head.ok);
      await head.body?.cancel();
      const manifest = await call(fileLink.linkId, "?format=json");
      assert.equal((await manifest.json()).kind, "file");
      await settle();
      assert.equal(await countOf(fileLink.linkId), 0);

      // 통짜 내려받기와 "bytes=0-"(처음부터 받는 범위 요청)은 센다.
      const full = await call(fileLink.linkId);
      assert.equal(await full.text(), "hello world");
      const fromZero = await call(fileLink.linkId, "", { headers: { range: "bytes=0-" } });
      assert.ok(fromZero.ok);
      await fromZero.arrayBuffer();
      await eventually(async () => (await countOf(fileLink.linkId)) === 2, "파일 링크 2회");
      const fileAudit = await eventually(
        async () => {
          const value = await audit.getEntryAudit(file.layoutKey);
          return value?.linkDownloadCount === 2 ? value : null;
        },
        "파일의 링크 경유 2회",
      );
      assert.ok(fileAudit.lastLinkDownloadAt);
      // 링크 방문은 내려받기 목록·횟수에 들어가지 않는다 — 멤버 기록이 그대로.
      assert.equal(fileAudit.downloadCount, 1);
      assert.deepEqual(fileAudit.downloads?.map(({ by }) => by), ["멤버"]);

      // ── 폴더 링크: 목록은 세지 않고, 안의 파일을 받으면 센다 ──
      const folder = await adapter.createFolder(ROOT_ID, "shared");
      const child = await adapter.upload(
        folder.id,
        "inside.txt",
        "text/plain",
        new Blob(["inside"]).stream(),
      );
      const folderLink = await shareLinks.createShareLink(folder.id, "shared", "Tester", 1, {
        kind: "folder",
        createdByUserId: "u-1",
      });
      assert.match(await (await call(folderLink.linkId)).text(), /inside\.txt/);
      await (await call(folderLink.linkId, "?format=json")).json();
      await settle();
      assert.equal(await countOf(folderLink.linkId), 0);
      const inside = await call(folderLink.linkId, `?entryId=${encodeURIComponent(child.id)}`);
      assert.equal(await inside.text(), "inside");
      await eventually(async () => (await countOf(folderLink.linkId)) === 1, "폴더 링크 1회");
      const childAudit = await eventually(
        async () => await audit.getEntryAudit(child.layoutKey),
        "폴더 안 파일",
      );
      assert.equal(childAudit.linkDownloadCount, 1);
      assert.equal(childAudit.downloads, undefined);

      // ── 간이 링크(숨김 임시 파일)도 같은 경로로 센다 ──
      const temporary = await adapter.uploadTemporary(
        "quick.txt",
        "text/plain",
        new Blob(["quick"]).stream(),
      );
      const quickLink = await shareLinks.createShareLink(temporary.id, "quick.txt", "Tester", 1, {
        createdByUserId: "u-1",
        quick: true,
        deleteOnExpire: true,
      });
      assert.equal(await (await call(quickLink.linkId)).text(), "quick");
      await eventually(async () => (await countOf(quickLink.linkId)) === 1, "간이 링크 1회");

      // 없는 링크는 404다.
      assert.equal((await call(linkIdOf(999))).status, 404);
    });
  });
});

test("API: 같은 링크를 10번 연속 받으면 기록은 6번만 (#17 B-7)", async () => {
  await withLocalStorage(async () => {
    const { adapter, ROOT_ID, shareLinks, space, call, countOf } = await loadModules();
    await space.runWithSpace(null, async () => {
      const file = await adapter.upload(
        ROOT_ID,
        "burst.txt",
        "text/plain",
        new Blob(["burst"]).stream(),
      );
      const link = await shareLinks.createShareLink(file.id, "burst.txt", "Tester", 1, {
        createdByUserId: "u-1",
      });
      for (let index = 0; index < 10; index += 1) {
        const response = await call(link.linkId);
        assert.equal(response.status, 200, "상한을 넘어도 내려받기는 정상");
        assert.equal(await response.text(), "burst");
      }
      await eventually(async () => (await countOf(link.linkId)) === 6, "6회");
      await settle();
      assert.equal(await countOf(link.linkId), 6, "넘긴 4번은 버린다");
    });
  });
});

test("링크를 멈추거나 만료 정리하면 장부 기록도 지운다, 넘칠 땐 활성 링크를 지킨다 (#17 B-7)", async () => {
  await withLocalStorage(async () => {
    const { adapter, ROOT_ID, shareLinks, downloads, space } = await loadModules();
    await space.runWithSpace(null, async () => {
      const file = await adapter.upload(
        ROOT_ID,
        "keep.txt",
        "text/plain",
        new Blob(["keep"]).stream(),
      );
      const make = () =>
        shareLinks.createShareLink(file.id, "keep.txt", "Tester", 1, {
          createdByUserId: "u-1",
        });
      const revoked = await make();
      const expiring = await make();
      const dropped = await make();
      for (const link of [revoked, expiring, dropped]) {
        await downloads.recordShareLinkDownload(link.linkId);
      }
      const ids = async () => Object.keys(await downloads.readShareLinkDownloads());

      // 멈추기(revoke).
      assert.equal(await shareLinks.revokeShareLink(revoked.linkId), true);
      assert.ok(!(await ids()).includes(revoked.linkId));

      // 만료 정리(cleanup)와, 새 링크를 만들며 만료 링크를 떼어 내는 길.
      const expire = async (linkId: string) => {
        const state = await adapter.readStateVersioned<{
          version: 2;
          links: Array<{ linkId: string; expiresAt: string }>;
          pendingDeletes: unknown[];
        }>("share-links.json");
        await adapter.compareAndSwapState(
          "share-links.json",
          {
            ...state.value!,
            links: state.value!.links.map((link) =>
              link.linkId === linkId ? { ...link, expiresAt: new Date(0).toISOString() } : link,
            ),
          },
          state.version,
        );
      };
      await expire(expiring.linkId);
      assert.equal((await shareLinks.cleanupExpiredShareLinks()).expired, 1);
      assert.ok(!(await ids()).includes(expiring.linkId));
      await expire(dropped.linkId);
      const fresh = await make();
      assert.ok(!(await ids()).includes(dropped.linkId), "새 링크 만들 때 떼어 낸 만료 링크");

      // 장부가 가득(400) 찬 상태: 활성 링크(fresh)가 가장 오래됐어도 새 링크가
      // 기록될 때 밀려나지 않는다 — 죽은 기록부터 버린다.
      const state = await adapter.readStateVersioned("share-link-downloads.json");
      const links: Record<string, { count: number; lastAt: string }> = {
        [fresh.linkId]: { count: 1, lastAt: "2020-01-01T00:00:00.000Z" },
      };
      for (let index = 0; index < MAX_TRACKED_LINKS - 1; index += 1) {
        links[linkIdOf(50_000 + index)] = {
          count: 1,
          lastAt: new Date(Date.parse("2021-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
        };
      }
      await adapter.compareAndSwapState(
        "share-link-downloads.json",
        { version: 1, links },
        state.version,
      );
      const newcomer = await make();
      await downloads.recordShareLinkDownload(newcomer.linkId);
      const after = await downloads.readShareLinkDownloads();
      assert.equal(Object.keys(after).length, MAX_TRACKED_LINKS);
      assert.ok(after[fresh.linkId], "활성 링크는 지킨다");
      assert.ok(after[newcomer.linkId]);
      assert.equal(after[linkIdOf(50_000)], undefined, "가장 오래된 죽은 기록이 빠진다");
    });
  });
});

test("배선: 공유 라우트·목록 API·속성 API (#17 B-7)", async () => {
  const [route, listRoute, properties, ledger, upload, audit] = await Promise.all([
    read("src/app/api/share/[linkId]/route.ts"),
    read("src/app/api/drive/share-link/route.ts"),
    read("src/app/api/drive/properties/route.ts"),
    read("src/lib/share-link-downloads.ts"),
    read("src/app/api/public-folder/[token]/upload/route.ts"),
    read("src/lib/entry-audit.ts"),
  ]);
  // 장부·항목 내력 쓰기는 프로세스 안에서 한 줄로(응답 뒤 기록이 몰려 CAS 재시도를
  // 다 쓰고 잃던 것 — 개발 서버에서 연달아 6번 받으면 5번만 남았다).
  for (const source of [ledger, audit]) {
    assert.match(source, /const writeQueue = createSerialQueue\(\);/);
    assert.match(source, /await writeQueue\(async \(\) => \{/);
  }

  // 처음부터 받는 요청만, HEAD 제외.
  assert.match(route, /range\.replace\(\/\\s\+\/g, ""\) === "bytes=0-"/);
  assert.match(route, /req\.method !== "HEAD"/);
  // 두 갈래(폴더 링크 안 파일·파일 링크) 모두 저장소가 파일을 내준 뒤 기록한다.
  const calls = [...route.matchAll(/recordShareLinkDownloadAfter\(/g)].map((m) => m.index!);
  assert.equal(calls.length, 2);
  assert.ok(route.indexOf("await adapter.download(entry.id, range)") < calls[0]);
  assert.ok(route.indexOf("await adapter.download(link.fileId, range)") < calls[1]);
  assert.match(route, /layoutKey: entry\.layoutKey/);

  // 기록 상한은 기록에만 — 상한을 넘으면 쓰지 않는다. 응답 뒤 최선 노력.
  assert.match(ledger, /if \(recordLimiter\(input\.linkId\)\) return;/);
  assert.match(ledger, /bestEffort\(/);
  assert.match(ledger, /recordEntryDownload\([^)]*\{ via: "share" \}\)/);
  // 업로드 라우트도 같은 창 카운터를 쓴다(IP당 10·전역 60).
  assert.match(upload, /createWindowLimiter\(\{[\s\S]*?perKey: 10,[\s\S]*?total: 60/);

  // 목록 API는 보이는 링크에만 횟수를 붙이고, 기록을 못 읽어도 목록은 준다.
  assert.match(listRoute, /withShareLinkDownloads\(visible, downloads\)/);
  assert.match(listRoute, /readShareLinkDownloads\(\)\.catch\(/);

  // 속성 창의 링크 경유 횟수도 내려받기 기록처럼 관리자에게만.
  assert.match(properties, /linkDownloadCount: admin \?/);
  assert.match(properties, /lastLinkDownloadAt: admin \?/);
});

test("배선: 생성된 링크 창과 속성 창이 횟수·마지막 시각을 보여 준다 (#17 B-7)", async () => {
  const [linksWindow, view, css] = await Promise.all([
    read("src/app/files/ShareLinksWindow.tsx"),
    read("src/app/files/FilesView.tsx"),
    read("src/app/files/desktop.module.css"),
  ]);

  assert.match(linksWindow, /t\("받아 감 \{count\}회 · 마지막 \{time\}", \{\s*count: link\.downloadCount,/);
  assert.match(linksWindow, /t\("아직 받아 간 기록 없음"\)/);
  assert.match(css, /\.shareLinkDownloaded \{/);

  // 속성 창: 링크 방문은 목록에 없고, "링크로 받음 n회 · 마지막 시각"만.
  assert.doesNotMatch(view, /viaShareLink|공유 링크 방문자/);
  assert.match(view, /t\("링크로 받음"\)/);
  assert.match(view, /t\("\{count\}회 · 마지막 \{time\}", \{\s*count: properties\.data\.linkDownloadCount,/);
});

test("i18n: 받아 감 문구가 네 사전에 있다 (#17 B-7)", async () => {
  const [{ EN_FILES }, { JA }, { HI }, { ZH }] = await Promise.all([
    import("../src/lib/i18n-en-files"),
    import("../src/lib/i18n-ja"),
    import("../src/lib/i18n-hi"),
    import("../src/lib/i18n-zh"),
  ]);
  for (const key of [
    "링크로 받음",
    "{count}회 · 마지막 {time}",
    "받아 감 {count}회 · 마지막 {time}",
    "아직 받아 간 기록 없음",
  ]) {
    for (const [name, dictionary] of Object.entries({ EN_FILES, JA, HI, ZH })) {
      assert.ok(key in dictionary, `${name} 사전에 없는 키 — ${key}`);
    }
  }
});
