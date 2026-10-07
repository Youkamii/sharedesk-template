import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  applyShareLinkDownload,
  MAX_TRACKED_LINKS,
  normalizeShareLinkDownloads,
  withShareLinkDownloads,
} from "../src/lib/share-link-downloads";

// 공유 링크 "받아 갔는지"(#17 B-7): 링크별 횟수·마지막 시각 장부(순수 함수),
// 실제 /api/share/<linkId> 핸들러를 돌려 기록이 남는지·안 남는지(범위 요청·
// HEAD·목록), 그리고 화면·API 배선.

const read = (relative: string) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

const linkIdOf = (seed: number) => seed.toString(16).padStart(48, "0");

test("장부: 받을 때마다 1씩 늘고 마지막 시각이 바뀐다 (#17 B-7)", () => {
  const empty = normalizeShareLinkDownloads(null);
  assert.deepEqual(empty, { version: 1, links: {} });

  const id = linkIdOf(1);
  const once = applyShareLinkDownload(empty, id, "2026-10-07T01:00:00.000Z");
  assert.deepEqual(once.links[id], {
    count: 1,
    lastAt: "2026-10-07T01:00:00.000Z",
  });
  const twice = applyShareLinkDownload(once, id, "2026-10-07T02:00:00.000Z");
  assert.deepEqual(twice.links[id], {
    count: 2,
    lastAt: "2026-10-07T02:00:00.000Z",
  });
  // 원본을 고치지 않는다(CAS 재시도에서 같은 입력을 다시 쓸 수 있어야 한다).
  assert.equal(once.links[id].count, 1);

  // 링크 id 꼴이 아니면 장부를 건드리지 않는다.
  assert.equal(applyShareLinkDownload(twice, "nope", "2026-10-07T03:00:00.000Z"), twice);
});

test("장부: 상한을 넘으면 마지막으로 받은 시각이 오래된 링크부터 버린다", () => {
  let file = normalizeShareLinkDownloads(null);
  const base = Date.parse("2026-01-01T00:00:00.000Z");
  for (let index = 0; index < MAX_TRACKED_LINKS; index += 1) {
    file = applyShareLinkDownload(
      file,
      linkIdOf(index + 1),
      new Date(base + index * 60_000).toISOString(),
    );
  }
  assert.equal(Object.keys(file.links).length, MAX_TRACKED_LINKS);
  const newcomer = linkIdOf(MAX_TRACKED_LINKS + 1);
  file = applyShareLinkDownload(file, newcomer, "2026-10-07T00:00:00.000Z");
  assert.equal(Object.keys(file.links).length, MAX_TRACKED_LINKS);
  assert.equal(file.links[linkIdOf(1)], undefined, "가장 오래된 것이 빠진다");
  assert.equal(file.links[newcomer].count, 1);
  assert.ok(file.links[linkIdOf(2)]);
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
  const unseen = linkIdOf(12);
  const merged = withShareLinkDownloads(
    [
      { linkId: seen, name: "a.txt" },
      { linkId: unseen, name: "b.txt" },
      // 프로토타입 키 이름과 겹쳐도 남의 값을 읽지 않는다.
      { linkId: "constructor", name: "c.txt" },
    ],
    { [seen]: { count: 4, lastAt: "2026-10-07T05:00:00.000Z" } },
  );
  assert.deepEqual(
    merged.map(({ downloadCount, lastDownloadAt }) => ({
      downloadCount,
      lastDownloadAt,
    })),
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
  probe: () => Promise<T | null | undefined>,
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

test("API: 공유 링크로 받으면 링크 횟수·파일 내력이 남고, 범위·HEAD·목록은 세지 않는다 (#17 B-7)", async () => {
  await withLocalStorage(async () => {
    const [
      { getAdapter },
      { ROOT_ID },
      shareLinks,
      downloads,
      audit,
      { NextRequest },
      route,
    ] = await Promise.all([
      import("../src/lib/storage"),
      import("../src/lib/storage/types"),
      import("../src/lib/share-links"),
      import("../src/lib/share-link-downloads"),
      import("../src/lib/entry-audit"),
      import("next/server"),
      import("../src/app/api/share/[linkId]/route"),
    ]);
    const adapter = getAdapter();
    const call = (
      linkId: string,
      query = "",
      init?: { method?: string; headers?: Record<string, string> },
    ) =>
      route.GET(
        new NextRequest(`http://localhost/api/share/${linkId}${query}`, init),
        { params: Promise.resolve({ linkId }) },
      );

    // ── 파일 링크 ──
    const file = await adapter.upload(
      ROOT_ID,
      "report.txt",
      "text/plain",
      new Blob(["hello world"]).stream(),
    );
    const fileLink = await shareLinks.createShareLink(
      file.id,
      "report.txt",
      "Tester",
      1,
      { createdByUserId: "u-1" },
    );

    // 세지 않는 요청: 범위 요청·HEAD·manifest.
    const ranged = await call(fileLink.linkId, "", {
      headers: { range: "bytes=0-1" },
    });
    assert.ok(ranged.ok);
    await ranged.arrayBuffer();
    const head = await call(fileLink.linkId, "", { method: "HEAD" });
    assert.ok(head.ok);
    await head.body?.cancel();
    const manifest = await call(fileLink.linkId, "?format=json");
    assert.equal((await manifest.json()).kind, "file");
    await settle();
    assert.deepEqual(await downloads.readShareLinkDownloads(), {});
    assert.equal(await audit.getEntryAudit(file.layoutKey), null);

    // 통짜 내려받기는 센다.
    const full = await call(fileLink.linkId);
    assert.equal(await full.text(), "hello world");
    const stat = await eventually(
      async () => (await downloads.readShareLinkDownloads())[fileLink.linkId],
      "파일 링크 횟수",
    );
    assert.equal(stat.count, 1);
    assert.ok(Number.isFinite(Date.parse(stat.lastAt)));
    const fileAudit = await eventually(
      async () => await audit.getEntryAudit(file.layoutKey),
      "파일 내력",
    );
    assert.equal(fileAudit.downloadCount, 1);
    assert.equal(fileAudit.linkDownloadCount, 1);
    assert.ok(fileAudit.lastLinkDownloadAt);
    assert.deepEqual(
      fileAudit.downloads?.map(({ by, viaShareLink, viaPublicLink }) => ({
        by,
        viaShareLink,
        viaPublicLink,
      })),
      [{ by: "report.txt", viaShareLink: true, viaPublicLink: undefined }],
    );

    // 멤버가 데스크에서 받은 것은 링크 횟수에 섞이지 않는다.
    await audit.recordEntryDownload(file.layoutKey, "멤버");
    const afterMember = await audit.getEntryAudit(file.layoutKey);
    assert.equal(afterMember?.downloadCount, 2);
    assert.equal(afterMember?.linkDownloadCount, 1);

    // ── 폴더 링크: 목록 화면은 세지 않고, 안의 파일을 받으면 센다 ──
    const folder = await adapter.createFolder(ROOT_ID, "shared");
    const child = await adapter.upload(
      folder.id,
      "inside.txt",
      "text/plain",
      new Blob(["inside"]).stream(),
    );
    const folderLink = await shareLinks.createShareLink(
      folder.id,
      "shared",
      "Tester",
      1,
      { kind: "folder", createdByUserId: "u-1" },
    );
    const page = await call(folderLink.linkId);
    assert.match(await page.text(), /inside\.txt/);
    const folderManifest = await call(folderLink.linkId, "?format=json");
    assert.equal((await folderManifest.json()).kind, "folder");
    await settle();
    assert.equal(
      (await downloads.readShareLinkDownloads())[folderLink.linkId],
      undefined,
    );

    const inside = await call(
      folderLink.linkId,
      `?entryId=${encodeURIComponent(child.id)}`,
    );
    assert.equal(await inside.text(), "inside");
    const folderStat = await eventually(
      async () => (await downloads.readShareLinkDownloads())[folderLink.linkId],
      "폴더 링크 횟수",
    );
    assert.equal(folderStat.count, 1);
    const childAudit = await eventually(
      async () => await audit.getEntryAudit(child.layoutKey),
      "폴더 안 파일 내력",
    );
    assert.equal(childAudit.linkDownloadCount, 1);
    assert.equal(childAudit.downloads?.[0]?.viaShareLink, true);
    assert.equal(childAudit.downloads?.[0]?.by, "shared");
    // 파일 링크 기록은 그대로다(링크마다 따로 센다).
    assert.equal(
      (await downloads.readShareLinkDownloads())[fileLink.linkId].count,
      1,
    );

    // ── 간이 링크(숨김 임시 파일)도 같은 경로로 센다 ──
    const temporary = await adapter.uploadTemporary(
      "quick.txt",
      "text/plain",
      new Blob(["quick"]).stream(),
    );
    const quickLink = await shareLinks.createShareLink(
      temporary.id,
      "quick.txt",
      "Tester",
      1,
      { createdByUserId: "u-1", quick: true, deleteOnExpire: true },
    );
    const quick = await call(quickLink.linkId);
    assert.equal(await quick.text(), "quick");
    const quickStat = await eventually(
      async () => (await downloads.readShareLinkDownloads())[quickLink.linkId],
      "간이 링크 횟수",
    );
    assert.equal(quickStat.count, 1);

    // 없는 링크는 404다.
    const missing = await call(linkIdOf(999));
    assert.equal(missing.status, 404);
  });
});

test("배선: 공유 라우트·목록 API·속성 API가 기록을 남기고 보여 준다 (#17 B-7)", async () => {
  const [route, listRoute, properties, ledger] = await Promise.all([
    read("src/app/api/share/[linkId]/route.ts"),
    read("src/app/api/drive/share-link/route.ts"),
    read("src/app/api/drive/properties/route.ts"),
    read("src/lib/share-link-downloads.ts"),
  ]);

  assert.match(route, /const countsAsDownload = !range && req\.method !== "HEAD";/);
  // 폴더 링크 안 파일은 이미 읽은 entry의 layoutKey를, 파일 링크는 응답 뒤에 찾는다.
  assert.match(
    route,
    /if \(countsAsDownload\) \{\s*recordShareLinkDownloadAfter\(\{\s*linkId: link\.linkId,\s*linkName: link\.name,\s*fileId: entry\.id,\s*layoutKey: entry\.layoutKey,/,
  );
  assert.match(
    route,
    /if \(countsAsDownload\) \{\s*recordShareLinkDownloadAfter\(\{\s*linkId: link\.linkId,\s*linkName: link\.name,\s*fileId: link\.fileId,\s*\}\);/,
  );
  // 기록은 저장소가 파일을 내준 뒤에만 — download가 던지면 404로 접힌다.
  assert.match(
    route,
    /const file = await adapter\.download\(link\.fileId, range\);\s*\/\/[^\n]*\n\s*if \(countsAsDownload\)/,
  );
  // 최선 노력: after()로 응답 뒤에, 실패는 삼킨다.
  assert.match(ledger, /after\(safe\)/);
  assert.match(ledger, /run\(\)\.catch\(\(\) => undefined\)/);
  assert.match(ledger, /Promise\.allSettled\(/);

  // 목록 API는 자기 링크(관리자는 전부)에만 횟수를 붙이고, 기록을 못 읽어도 목록은 준다.
  assert.match(listRoute, /withShareLinkDownloads\(visible, downloads\)/);
  assert.match(listRoute, /readShareLinkDownloads\(\)\.catch\(\(\) => \(\{\}\)\)/);

  // 속성 창의 링크 경유 횟수도 내려받기 기록처럼 관리자에게만.
  assert.match(
    properties,
    /linkDownloadCount: admin \? \(audit\?\.linkDownloadCount \?\? 0\) : null/,
  );
  assert.match(
    properties,
    /lastLinkDownloadAt: admin \? \(audit\?\.lastLinkDownloadAt \?\? null\) : null/,
  );
});

test("배선: 생성된 링크 창과 속성 창이 횟수·마지막 시각을 보여 준다 (#17 B-7)", async () => {
  const [linksWindow, view, css] = await Promise.all([
    read("src/app/files/ShareLinksWindow.tsx"),
    read("src/app/files/FilesView.tsx"),
    read("src/app/files/desktop.module.css"),
  ]);

  assert.match(linksWindow, /body\.links\.filter\(isShareLink\)\.map\(toListedShareLink\)/);
  assert.match(
    linksWindow,
    /link\.downloadCount > 0 && link\.lastDownloadAt \?[\s\S]*?t\("받아 감 \{count\}회 · 마지막 \{time\}", \{\s*count: link\.downloadCount,\s*time: formatDate\(link\.lastDownloadAt\),/,
  );
  assert.match(linksWindow, /t\("아직 받아 간 기록 없음"\)/);
  assert.match(css, /\.shareLinksBody li small\.shareLinkDownloaded \{/);

  // 속성 창: 링크 방문자 표시와 링크 경유 "n회 · 마지막 시각".
  assert.match(
    view,
    /record\.viaShareLink\s*\?\s*t\("공유 링크 방문자"\)/,
  );
  assert.match(view, /<dt>\{t\("링크로 받음"\)\}<\/dt>/);
  assert.match(
    view,
    /t\("\{count\}회 · 마지막 \{time\}", \{\s*count: properties\.data\.linkDownloadCount,/,
  );
});

test("i18n: 받아 감 문구가 네 사전에 있다 (#17 B-7)", async () => {
  const [{ EN_FILES }, { JA }, { HI }, { ZH }] = await Promise.all([
    import("../src/lib/i18n-en-files"),
    import("../src/lib/i18n-ja"),
    import("../src/lib/i18n-hi"),
    import("../src/lib/i18n-zh"),
  ]);
  for (const key of [
    "공유 링크 방문자",
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
