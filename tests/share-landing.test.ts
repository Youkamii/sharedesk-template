import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createVisitorDownloadRunner,
  fitsInMemory,
  formatVisitorDownloadStatus,
  type VisitorDownloadIo,
} from "../src/lib/client/visitor-downloads";
import { LARGE_DOWNLOAD_BYTES } from "../src/lib/client/download-queue";
import {
  SHARE_PREVIEW_MAX_BYTES,
  acceptsHtml,
  describeShareLanding,
  formatShareRemaining,
  formatUtcExpiry,
  serverClockOffset,
  shareFileUrl,
  shareLandingPath,
  shareLandingPreviewKind,
  shareLandingPreviewPlan,
  shareLinkPath,
  shareLinkRemaining,
  wantsShareLanding,
} from "../src/lib/share-landing";

// 공유·간이 링크 받기 화면(#17 B-3): 어느 요청을 화면으로 보낼지(순수 함수와
// 실제 /api/share/<linkId> 핸들러), 남은 시간 계산, 미리보기 가드, 화면에 넘기는
// 값, 모두 받기 큐(3개씩), 페이지·화면 배선, 사전.

const read = (relative: string) =>
  readFile(new URL(`../${relative}`, import.meta.url), "utf8");

const CHROME_ACCEPT =
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7";
const LINK_ID = "a".repeat(48);

test("브라우저(Accept: text/html)만 받기 화면으로, 도구·기계 요청은 그대로 (#17 B-3)", () => {
  assert.equal(acceptsHtml(CHROME_ACCEPT), true);
  assert.equal(acceptsHtml("TEXT/HTML"), true);
  assert.equal(acceptsHtml("text/html;q=0.5"), true);
  // curl·wget·다운로드 관리자·Node fetch 기본값, 다른 데스크의 manifest 요청.
  for (const accept of [null, undefined, "", "*/*", "application/json", "text/*", "text/plain"]) {
    assert.equal(acceptsHtml(accept), false, String(accept));
  }
  assert.equal(acceptsHtml("text/html;q=0, */*"), false, "q=0은 원하지 않는다는 뜻");
  assert.equal(acceptsHtml("text/htmlx"), false);

  const params = (query: string) => new URLSearchParams(query);
  assert.equal(wantsShareLanding(CHROME_ACCEPT, params("")), true);
  assert.equal(wantsShareLanding(CHROME_ACCEPT, params("entryId=abc")), true);
  assert.equal(wantsShareLanding(CHROME_ACCEPT, params("format=json")), false);
  assert.equal(wantsShareLanding(CHROME_ACCEPT, params("download=1")), false);
  assert.equal(wantsShareLanding(CHROME_ACCEPT, params("preview=1")), false);
  assert.equal(wantsShareLanding("*/*", params("")), false);
  assert.equal(wantsShareLanding(null, params("")), false);
});

test("주소: 받기 화면은 /public/share, 파일은 링크 주소에 download·preview (#17 B-3)", () => {
  assert.equal(shareLandingPath(LINK_ID), `/public/share/${LINK_ID}`);
  assert.equal(
    shareLandingPath(LINK_ID, "a b/&?"),
    `/public/share/${LINK_ID}?entryId=a%20b%2F%26%3F`,
  );
  assert.equal(shareFileUrl(LINK_ID, null, "download"), `/api/share/${LINK_ID}?download=1`);
  // "링크 주소 복사"는 원래 링크 꼴(다른 데스크에서 받기·도구가 쓰는 주소).
  assert.equal(shareLinkPath(LINK_ID), `/api/share/${LINK_ID}`);
  assert.equal(shareLinkPath(LINK_ID, "x_y-1"), `/api/share/${LINK_ID}?entryId=x_y-1`);
  assert.equal(
    shareFileUrl(LINK_ID, "x_y-1", "preview"),
    `/api/share/${LINK_ID}?entryId=x_y-1&preview=1`,
  );
});

test("남은 시간: 1초 미만은 올리고, 만료 시각이 지나면 닫힘 (#17 B-3)", () => {
  const end = Date.parse("2026-10-08T12:00:00.000Z");
  const iso = new Date(end).toISOString();
  const t = (text: string, vars?: Record<string, string | number>) => {
    let out = text;
    for (const [key, value] of Object.entries(vars ?? {})) {
      out = out.replaceAll(`{${key}}`, String(value));
    }
    return out;
  };

  const twoDays = shareLinkRemaining(iso, end - (2 * 86_400 + 3 * 3_600 + 4 * 60 + 5) * 1000);
  assert.deepEqual(twoDays, {
    expired: false,
    totalSeconds: 2 * 86_400 + 3 * 3_600 + 4 * 60 + 5,
    days: 2,
    hours: 3,
    minutes: 4,
    seconds: 5,
  });
  assert.equal(formatShareRemaining(twoDays, t), "2일 03:04:05 남음");

  const underDay = shareLinkRemaining(iso, end - 59_000);
  assert.equal(formatShareRemaining(underDay, t), "00:00:59 남음");
  // 0.4초 남음 → 아직 열려 있으니 1초로 보인다(0이 되는 순간이 닫히는 순간).
  const almost = shareLinkRemaining(iso, end - 400);
  assert.equal(almost.expired, false);
  assert.equal(formatShareRemaining(almost, t), "00:00:01 남음");
  // 서버 판정(expiresAt <= now면 닫힘)과 같다.
  assert.equal(shareLinkRemaining(iso, end).expired, true);
  assert.equal(shareLinkRemaining(iso, end + 5_000).totalSeconds, 0);
  assert.equal(formatShareRemaining(shareLinkRemaining(iso, end), t), "닫혔습니다");
  // 깨진 값은 닫힌 것으로.
  assert.equal(shareLinkRemaining("어제", end).expired, true);

  assert.equal(formatUtcExpiry(iso), "2026-10-08 12:00 UTC");
  assert.equal(formatUtcExpiry("nope"), "");
});

test("시계 보정: 서버가 그린 시각과 브라우저 첫 시각의 차이로 남은 시간·닫힘을 잰다 (#17 B-3)", () => {
  const end = Date.parse("2026-10-08T12:00:00.000Z");
  const iso = new Date(end).toISOString();
  const serverNow = end - 60_000; // 서버 기준 1분 남음
  // 브라우저 시계가 5분 빠르다 — 보정 없이 재면 이미 닫힌 것으로 보인다.
  const clientNow = serverNow + 5 * 60_000;
  assert.equal(shareLinkRemaining(iso, clientNow).expired, true, "보정 전");
  const offset = serverClockOffset(serverNow, clientNow);
  assert.equal(offset, -5 * 60_000);
  const corrected = shareLinkRemaining(iso, clientNow + 1_000 + offset);
  assert.equal(corrected.expired, false, "보정 후에는 서버 시계로 잰다");
  assert.equal(corrected.totalSeconds, 59);
  // 브라우저 시계가 느린 쪽도 같다 — 서버 기준 만료가 지나면 닫힌다.
  const slowClient = serverNow - 10 * 60_000;
  const slowOffset = serverClockOffset(serverNow, slowClient);
  assert.equal(shareLinkRemaining(iso, slowClient + 61_000 + slowOffset).expired, true);
  // 값이 깨지면 보정하지 않는다.
  assert.equal(serverClockOffset(Number.NaN, clientNow), 0);
});

test("미리보기 가드: 원본이 이미지·PDF·텍스트일 때만, 오피스·영상·SVG·HTML 파일은 아님 (#17 B-3)", () => {
  const kind = (name: string, mimeType: string | null = null, isFolder = false) =>
    shareLandingPreviewKind({ name, mimeType, isFolder });
  assert.equal(kind("photo.png"), "image");
  assert.equal(kind("photo.JPG"), "image");
  assert.equal(kind("photo", "image/webp"), "image");
  assert.equal(kind("paper.pdf"), "pdf");
  assert.equal(kind("notes.txt"), "text");
  assert.equal(kind("table.csv"), "text");
  assert.equal(kind("readme.md"), "text");
  assert.equal(kind("data.json"), "text");
  // 저장소가 text/html을 줘도 inline은 text/plain 강제라 글자로만 보인다.
  assert.equal(kind("page", "text/html"), "text");

  assert.equal(kind("report.docx"), null, "오피스는 변환 미리보기라 원본 inline이 아니다");
  assert.equal(kind("doc", "application/vnd.google-apps.document"), null);
  assert.equal(kind("clip.mp4"), null, "영상·소리는 작은 미리보기에 넣지 않는다");
  assert.equal(kind("song.mp3"), null);
  assert.equal(kind("logo.svg"), null, "스크립트 실행형");
  assert.equal(kind("logo", "image/svg+xml"), null);
  assert.equal(kind("page.html"), null);
  assert.equal(kind("archive.zip"), null);
  assert.equal(kind("photos", null, true), null);

  // 라우트가 내보낼 형식: 텍스트는 text/plain 강제, 형식을 모르면(옥텟) 이름으로 보정.
  const inline = (name: string, mimeType: string | null) =>
    shareLandingPreviewPlan({ name, mimeType })?.inlineType ?? null;
  assert.equal(inline("notes.txt", "text/plain"), "text/plain; charset=utf-8");
  assert.equal(inline("page", "text/html"), "text/plain; charset=utf-8");
  assert.equal(inline("간이 메모.txt", "application/octet-stream"), "text/plain; charset=utf-8");
  assert.equal(inline("photo.png", "application/octet-stream"), "image/png");
  assert.equal(inline("paper.pdf", "application/pdf"), "application/pdf");
  assert.equal(inline("bundle.zip", "application/octet-stream"), null);
  assert.equal(inline("logo.svg", "image/svg+xml"), null);
  assert.equal(inline("clip.mp4", "video/mp4"), null);
  assert.equal(inline("noext", "application/octet-stream"), null);

  // 크기 상한: 이미지 8MB·PDF 16MB·텍스트 64KB(텍스트는 앞부분만 낸다).
  assert.deepEqual(SHARE_PREVIEW_MAX_BYTES, {
    image: 8 * 1024 * 1024,
    pdf: 16 * 1024 * 1024,
    text: 64 * 1024,
  });
  assert.equal(shareLandingPreviewPlan({ name: "a.png", mimeType: null })?.maxBytes, 8 * 1024 * 1024);
  assert.equal(shareLandingPreviewPlan({ name: "a.pdf", mimeType: null })?.maxBytes, 16 * 1024 * 1024);
  assert.equal(shareLandingPreviewPlan({ name: "a.txt", mimeType: null })?.maxBytes, 64 * 1024);
});

test("화면 값: 보낸 사람은 데스크 별명만, 실명·이메일·fileId·만든 사람 id는 싣지 않는다 (#17 B-3)", () => {
  const link = {
    linkId: LINK_ID,
    fileId: "cm9vdC9zZWNyZXQvcGF0aA",
    name: "보고서.pdf",
    kind: "file" as const,
    createdBy: "홍길동 hong@example.com",
    createdByUserId: "user-123",
    createdAt: "2026-10-07T00:00:00.000Z",
    expiresAt: "2026-10-08T00:00:00.000Z",
    quick: true,
    deleteOnExpire: true,
  };
  const model = describeShareLanding(
    link,
    "  하늘별 ",
    null,
    {
      id: link.fileId,
      layoutKey: "secret-layout",
      name: link.name,
      isFolder: false,
      size: 1234,
      mimeType: "application/pdf",
    } as never,
    null,
  );
  assert.deepEqual(model, {
    linkId: LINK_ID,
    kind: "file",
    rootName: "보고서.pdf",
    sender: "하늘별",
    expiresAt: "2026-10-08T00:00:00.000Z",
    entryId: null,
    current: {
      name: "보고서.pdf",
      isFolder: false,
      size: 1234,
      mimeType: "application/pdf",
      preview: "pdf",
    },
    entries: null,
  });
  const serialized = JSON.stringify(model);
  for (const secret of [link.fileId, "user-123", "secret-layout", "홍길동", "hong@example.com"]) {
    assert.ok(!serialized.includes(secret), `새면 안 되는 값 — ${secret}`);
  }

  const folder = describeShareLanding(
    { ...link, kind: "folder", name: "사진" },
    null,
    null,
    { name: "사진", isFolder: true, size: null, mimeType: null },
    [
      { id: "child-1", name: "a.png", isFolder: false, size: 5, mimeType: "image/png", layoutKey: "k" } as never,
    ],
  );
  assert.deepEqual(folder.entries, [
    { id: "child-1", name: "a.png", isFolder: false, size: 5, mimeType: "image/png" },
  ]);
  assert.equal(folder.current.preview, null);
  // 별명이 없으면 보낸 사람은 비어(null) 화면이 줄을 감춘다 — 실명으로 대신하지 않는다.
  assert.equal(folder.sender, null);
  assert.equal(describeShareLanding(
      link,
      "   ",
      null,
      { name: "a.txt", isFolder: false, size: 1, mimeType: null },
      null,
    ).sender, null);
});

test("모두 받기 큐: 3개씩만 동시에, 실패해도 나머지는 받고, 크기를 모르거나 큰 파일은 브라우저에 맡기되 자리를 차지한다 (#17 B-3·B-6)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetched: string[] = [];
  const saved: string[] = [];
  const native: string[] = [];
  const releases: Array<() => void> = [];
  const holds: Array<() => void> = [];
  const io: VisitorDownloadIo = {
    async fetchFile(url) {
      fetched.push(url);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      if (url.includes("broken")) return new Response("nope", { status: 404 });
      return new Response(`body:${url}`);
    },
    saveBlob(blob, fileName) {
      saved.push(`${fileName}:${blob.size}`);
    },
    saveNative(url, fileName) {
      native.push(`${fileName}@${url}`);
    },
    holdNative() {
      return new Promise<void>((resolve) => holds.push(resolve));
    },
  };
  const snapshots: number[] = [];
  let next = 0;
  const runner = createVisitorDownloadRunner({
    urlFor: (entryId) => `/dl?id=${entryId}`,
    onChange: (items) =>
      snapshots.push(items.filter((item) => item.status === "downloading").length),
    io,
    makeId: () => `item-${(next += 1)}`,
  });
  assert.equal(fitsInMemory(3), true);
  assert.equal(fitsInMemory(LARGE_DOWNLOAD_BYTES), true);
  assert.equal(fitsInMemory(LARGE_DOWNLOAD_BYTES + 1), false);
  assert.equal(fitsInMemory(null), false, "크기를 모르면 메모리에 모으지 않는다");
  const big = LARGE_DOWNLOAD_BYTES + 1;
  runner.enqueue([
    { id: "huge1", name: "big1.iso", size: big },
    { id: "huge2", name: "big2.iso", size: big },
    { id: "unknown", name: "모름.bin", size: null },
    { id: "huge3", name: "big3.iso", size: big },
    { id: "a", name: "a.txt", size: 3 },
    { id: "broken", name: "b.txt", size: 3 },
    { id: "d", name: "d.txt", size: 3 },
    { id: "e", name: "e.txt", size: 3 },
  ]);
  const flush = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await flush();
  // 브라우저에 넘긴 파일도 자리를 차지한다 — 한꺼번에 시작하지 않는다.
  assert.deepEqual(native, ["big1.iso@/dl?id=huge1", "big2.iso@/dl?id=huge2", "모름.bin@/dl?id=unknown"]);
  assert.equal(fetched.length, 0, "브라우저에 넘긴 파일은 fetch하지 않는다");
  holds.shift()!();
  await flush();
  assert.equal(native.length, 4, "자리가 하나 비면 다음 하나");
  // 나머지는 하나씩 풀어 주며 끝까지 돌린다.
  for (let guard = 0; guard < 40 && (releases.length > 0 || holds.length > 0); guard += 1) {
    (releases.shift() ?? holds.shift())!();
    await flush();
  }
  await flush();
  assert.ok(maxInFlight <= 3, `동시 ${maxInFlight}개`);
  assert.ok(Math.max(...snapshots) <= 3);
  for (const id of ["huge1", "huge2", "huge3", "unknown"]) {
    assert.ok(!fetched.includes(`/dl?id=${id}`), `${id}는 fetch로 모으지 않는다`);
  }
  const bodySize = (id: string) => `body:/dl?id=${id}`.length;
  assert.deepEqual(
    saved.sort(),
    ["a", "d", "e"].map((id) => `${id}.txt:${bodySize(id)}`),
  );
  const statuses = Object.fromEntries(
    runner.items().map((item) => [item.entryId, item.status]),
  );
  assert.deepEqual(statuses, {
    huge1: "done",
    huge2: "done",
    unknown: "done",
    huge3: "done",
    a: "done",
    broken: "failed",
    d: "done",
    e: "done",
  });
  const t = (text: string, vars?: Record<string, string | number>) =>
    Object.entries(vars ?? {}).reduce(
      (out, [key, value]) => out.replaceAll(`{${key}}`, String(value)),
      text,
    );
  assert.equal(
    formatVisitorDownloadStatus({ total: 8, done: 7, failed: 1, active: 0 }, t),
    "7개 받음 · 1개 실패",
  );
  assert.equal(
    formatVisitorDownloadStatus({ total: 3, done: 1, failed: 0, active: 2 }, t),
    "내려받는 중 1/3",
  );
  assert.equal(
    formatVisitorDownloadStatus({ total: 2, done: 2, failed: 0, active: 0 }, t),
    "2개를 내려받았습니다",
  );
  assert.equal(formatVisitorDownloadStatus({ total: 0, done: 0, failed: 0, active: 0 }, t), null);
  runner.clearFinished();
  assert.deepEqual(runner.items(), []);
});

async function withLocalStorage(run: () => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "sharedesk-share-landing-"));
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

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
  throw new Error(`기다렸지만 없다 — ${label}`);
}

test("API: 브라우저는 302로 받기 화면, curl·format=json·download=1은 그대로, 미리보기는 안전한 형식·크기 상한·세지 않음 (#17 B-3)", async () => {
  await withLocalStorage(async () => {
    const [storage, types, shareLinks, downloads, server, route, space] =
      await Promise.all([
        import("../src/lib/storage"),
        import("../src/lib/storage/types"),
        import("../src/lib/share-links"),
        import("../src/lib/share-link-downloads"),
        import("next/server"),
        import("../src/app/api/share/[linkId]/route"),
        import("../src/lib/space-store"),
      ]);
    const adapter = storage.getAdapter();
    const call = (linkId: string, query = "", headers: Record<string, string> = {}) =>
      route.GET(
        new server.NextRequest(`http://localhost/api/share/${linkId}${query}`, { headers }),
        { params: Promise.resolve({ linkId }) },
      );
    const countOf = async (linkId: string) =>
      (await downloads.readShareLinkDownloads())[linkId]?.count ?? 0;
    const html = { accept: CHROME_ACCEPT };

    await space.runWithSpace(null, async () => {
      const file = await adapter.upload(
        types.ROOT_ID,
        "notes.txt",
        "text/plain",
        new Blob(["hello landing"]).stream(),
      );
      const link = await shareLinks.createShareLink(file.id, "notes.txt", "보낸이", 2, {
        createdByUserId: "u-1",
      });

      // 브라우저: 저장소를 읽지 않고 받기 화면으로(상대 Location).
      const redirected = await call(link.linkId, "", html);
      assert.equal(redirected.status, 302);
      assert.equal(redirected.headers.get("location"), `/public/share/${link.linkId}`);
      assert.match(redirected.headers.get("vary") ?? "", /Accept/);
      assert.match(redirected.headers.get("cache-control") ?? "", /no-store/);
      const withEntry = await call(link.linkId, "?entryId=abc", html);
      assert.equal(withEntry.headers.get("location"), `/public/share/${link.linkId}?entryId=abc`);
      // 없는 링크도 화면이 닫힘 안내를 그린다. 형태가 틀린 id는 그대로 404.
      assert.equal((await call("b".repeat(48), "", html)).status, 302);
      assert.equal((await call("not-a-link", "", html)).status, 404);

      // curl(*/*)·헤더 없는 요청은 지금처럼 바로 파일.
      const toolHeaders: Array<Record<string, string>> = [{ accept: "*/*" }, {}];
      for (const headers of toolHeaders) {
        const direct = await call(link.linkId, "", headers);
        assert.equal(direct.status, 200);
        assert.match(direct.headers.get("content-disposition") ?? "", /^attachment;/);
        assert.equal(await direct.text(), "hello landing");
      }
      await eventually(async () => (await countOf(link.linkId)) === 2, "도구 내려받기 2회");

      // format=json은 브라우저가 열어도 형식 그대로.
      const manifest = await call(link.linkId, "?format=json", html);
      assert.equal(manifest.status, 200);
      const body = await manifest.json();
      assert.deepEqual(Object.keys(body).sort(), [
        "expiresAt",
        "isFolder",
        "kind",
        "mimeType",
        "name",
        "size",
      ]);
      assert.equal(body.kind, "file");
      assert.equal(body.name, "notes.txt");

      // 미리보기: inline text/plain, 횟수에 세지 않는다.
      const preview = await call(link.linkId, "?preview=1", html);
      assert.equal(preview.status, 200);
      assert.equal(preview.headers.get("content-length"), "13");
      assert.match(preview.headers.get("content-disposition") ?? "", /^inline;/);
      assert.equal(preview.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
      assert.equal(await preview.text(), "hello landing");

      // 큰 텍스트는 Range가 없어도(또는 다른 범위를 달라 해도) 서버가 앞 64KB만 낸다.
      const longText = "가나다라마바사아".repeat(20_000); // 약 480KB
      const big = await adapter.upload(
        types.ROOT_ID,
        "long.log",
        "text/plain",
        new Blob([longText]).stream(),
      );
      const bigLink = await shareLinks.createShareLink(big.id, "long.log", "보낸이", 1, {
        createdByUserId: "u-1",
      });
      for (const headers of [html, { range: "bytes=300000-" }]) {
        const cut = await call(bigLink.linkId, "?preview=1", headers);
        assert.equal(cut.status, 200);
        assert.equal(cut.headers.get("content-range"), null);
        assert.equal(cut.headers.get("accept-ranges"), null);
        assert.equal(cut.headers.get("content-length"), String(SHARE_PREVIEW_MAX_BYTES.text));
        const bytes = new Uint8Array(await cut.arrayBuffer());
        assert.equal(bytes.byteLength, SHARE_PREVIEW_MAX_BYTES.text);
        assert.deepEqual(bytes, new TextEncoder().encode(longText).subarray(0, bytes.byteLength));
      }

      // 이미지 8MB·PDF 16MB를 넘으면 미리보기로 내주지 않는다(415). 상한 이하는 낸다.
      const uploadSized = async (name: string, mime: string, size: number) => {
        const entry = await adapter.upload(
          types.ROOT_ID,
          name,
          mime,
          new Blob([new Uint8Array(size)]).stream(),
        );
        return (
          await shareLinks.createShareLink(entry.id, name, "보낸이", 1, {
            createdByUserId: "u-1",
          })
        ).linkId;
      };
      const okImage = await uploadSized("ok.png", "image/png", 1024);
      const hugeImage = await uploadSized("huge.png", "image/png", SHARE_PREVIEW_MAX_BYTES.image + 1);
      const hugePdf = await uploadSized("huge.pdf", "application/pdf", SHARE_PREVIEW_MAX_BYTES.pdf + 1);
      const okImageResponse = await call(okImage, "?preview=1", html);
      assert.equal(okImageResponse.status, 200);
      assert.equal(okImageResponse.headers.get("content-type"), "image/png");
      await okImageResponse.arrayBuffer();
      for (const linkId of [hugeImage, hugePdf]) {
        const refusedLarge = await call(linkId, "?preview=1", html);
        assert.equal(refusedLarge.status, 415);
        assert.match(refusedLarge.headers.get("content-type") ?? "", /application\/json/);
      }

      // 받기 단추(download=1)는 브라우저가 눌러도 바로 파일이고 센다.
      const button = await call(link.linkId, "?download=1", html);
      assert.equal(button.status, 200);
      assert.match(button.headers.get("content-disposition") ?? "", /^attachment;/);
      assert.equal(await button.text(), "hello landing");
      await eventually(async () => (await countOf(link.linkId)) === 3, "받기 단추 1회 더");
      await settle();
      assert.equal(await countOf(link.linkId), 3, "미리보기·화면 이동·목록은 세지 않는다");

      // 미리보기가 안 되는 형식은 내주지 않는다(세지 않는 내려받기 통로 차단).
      const zip = await adapter.upload(
        types.ROOT_ID,
        "bundle.zip",
        "application/zip",
        new Blob(["PK"]).stream(),
      );
      const zipLink = await shareLinks.createShareLink(zip.id, "bundle.zip", "보낸이", 1, {
        createdByUserId: "u-1",
      });
      const refused = await call(zipLink.linkId, "?preview=1");
      assert.equal(refused.status, 415);
      await settle();
      assert.equal(await countOf(zipLink.linkId), 0);

      // 간이 링크(숨김 임시 파일 — 저장 이름에 확장자가 없다)도 링크 이름으로 미리본다.
      const temporary = await adapter.uploadTemporary(
        "간이 메모.txt",
        "text/plain",
        new Blob(["quick note"]).stream(),
      );
      const quickLink = await shareLinks.createShareLink(temporary.id, "간이 메모.txt", "보낸이", 1, {
        createdByUserId: "u-1",
        quick: true,
        deleteOnExpire: true,
      });
      const quickPreview = await call(quickLink.linkId, "?preview=1", html);
      assert.ok(quickPreview.ok);
      assert.equal(quickPreview.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(await quickPreview.text(), "quick note");

      // ── 폴더 링크 ──
      const folder = await adapter.createFolder(types.ROOT_ID, "shared");
      const child = await adapter.upload(
        folder.id,
        "inside.txt",
        "text/plain",
        new Blob(["inside"]).stream(),
      );
      const folderLink = await shareLinks.createShareLink(folder.id, "shared", "보낸이", 1, {
        kind: "folder",
        createdByUserId: "u-1",
      });
      const folderRedirect = await call(folderLink.linkId, "", html);
      assert.equal(folderRedirect.status, 302);
      assert.equal(folderRedirect.headers.get("location"), `/public/share/${folderLink.linkId}`);
      // 브라우저가 아닌 도구에는 옛 목록 HTML — 꼬리말은 실제 만료 시각(UTC).
      const legacy = await call(folderLink.linkId);
      const legacyHtml = await legacy.text();
      assert.match(legacyHtml, /inside\.txt/);
      assert.ok(
        legacyHtml.includes(`이 링크는 ${formatUtcExpiry(folderLink.expiresAt)}에 닫힙니다.`),
      );
      assert.doesNotMatch(legacyHtml, /정해진 시간이 지나면/);
      // 폴더 manifest 형식 그대로.
      const folderManifest = await (await call(folderLink.linkId, "?format=json", html)).json();
      assert.equal(folderManifest.kind, "folder");
      assert.equal(folderManifest.entries.length, 1);
      assert.deepEqual(Object.keys(folderManifest.entries[0]).sort(), [
        "id",
        "isFolder",
        "mimeType",
        "name",
        "size",
      ]);
      assert.equal(folderManifest.entries[0].id, child.id);
      assert.equal(folderManifest.entries[0].name, "inside.txt");
      // 폴더 안 파일의 미리보기·받기는 같은 범위 가드(isWithin) 아래.
      const inside = `?entryId=${encodeURIComponent(child.id)}`;
      const childPreview = await call(folderLink.linkId, `${inside}&preview=1`, html);
      assert.match(childPreview.headers.get("content-disposition") ?? "", /^inline;/);
      assert.equal(await childPreview.text(), "inside");
      const outsideId = file.id;
      assert.equal(
        (await call(folderLink.linkId, `?entryId=${encodeURIComponent(outsideId)}&preview=1`)).status,
        404,
        "폴더 밖 항목은 미리보기도 막힌다",
      );
      await settle();
      assert.equal(await countOf(folderLink.linkId), 0);
      const childDownload = await call(folderLink.linkId, `${inside}&download=1`, html);
      assert.equal(await childDownload.text(), "inside");
      await eventually(async () => (await countOf(folderLink.linkId)) === 1, "폴더 안 받기 1회");

      // 없는 링크는 도구에게 404 JSON 그대로.
      assert.equal((await call("c".repeat(48))).status, 404);
      // 큰 미리보기 요청들도 횟수에 들어가지 않았다.
      for (const linkId of [bigLink.linkId, okImage, hugeImage, hugePdf]) {
        assert.equal(await countOf(linkId), 0);
      }
    });
  });
});

test("화면 값(서버): 보낸 사람은 데스크 별명이 있는 멤버만, 실명·이메일은 내보내지 않는다 (#17 B-3)", async () => {
  await withLocalStorage(async () => {
    const root = process.env.LOCAL_STORAGE_ROOT!;
    await mkdir(join(root, ".sharedesk"), { recursive: true });
    const base = {
      status: "approved",
      isAdmin: false,
      createdAt: "2026-08-01T00:00:00.000Z",
      sessionsValidFrom: 0,
    };
    await writeFile(
      join(root, ".sharedesk", "users.json"),
      JSON.stringify({
        version: 2,
        rev: 1,
        users: [
          {
            ...base,
            id: "nick-sub",
            email: "hong@example.com",
            name: "홍길동",
            nickname: "하늘별",
            nicknameHistory: [],
          },
          { ...base, id: "plain-sub", email: "kim@example.com", name: "김철수" },
        ],
        invitations: [],
      }),
      "utf8",
    );
    const [storage, types, shareLinks, space, loader] = await Promise.all([
      import("../src/lib/storage"),
      import("../src/lib/storage/types"),
      import("../src/lib/share-links"),
      import("../src/lib/space-store"),
      import("../src/lib/share-landing-load"),
    ]);
    const adapter = storage.getAdapter();
    const ids = await space.runWithSpace(null, async () => {
      const file = await adapter.upload(
        types.ROOT_ID,
        "memo.txt",
        "text/plain",
        new Blob(["memo"]).stream(),
      );
      // 링크 장부의 createdBy에는 세션 이름(구글 실명, 없으면 이메일)이 들어간다.
      const make = (createdBy: string, createdByUserId: string) =>
        shareLinks
          .createShareLink(file.id, "memo.txt", createdBy, 1, { createdByUserId })
          .then((link) => link.linkId);
      return {
        withNick: await make("홍길동", "nick-sub"),
        noNick: await make("kim@example.com", "plain-sub"),
        guest: await make("손님", "guest:abc"),
      };
    });

    const withNick = await loader.loadShareLanding(ids.withNick, null);
    assert.equal(withNick?.model.sender, "하늘별");
    assert.ok(withNick && withNick.renderedAt > 0);
    const noNick = await loader.loadShareLanding(ids.noNick, null);
    assert.equal(noNick?.model.sender, null, "별명이 없으면 줄을 감춘다");
    const guest = await loader.loadShareLanding(ids.guest, null);
    assert.equal(guest?.model.sender, null, "명단에 없는 사람(손님)도 감춘다");
    for (const loaded of [withNick, noNick, guest]) {
      const serialized = JSON.stringify(loaded);
      for (const secret of ["홍길동", "hong@example.com", "김철수", "kim@example.com", "nick-sub", "plain-sub"]) {
        assert.ok(!serialized.includes(secret), `새면 안 되는 값 — ${secret}`);
      }
    }
    assert.equal(await loader.loadShareLanding("d".repeat(48), null), null);
  });
});

test("배선: 받기 화면 페이지는 링크 라우트와 같은 입구·가드, 내부 값은 넘기지 않는다 (#17 B-3)", async () => {
  const [page, loader, nextConfig, view, frame, notFoundPage, css, route] = await Promise.all([
    read("src/app/public/share/[linkId]/page.tsx"),
    read("src/lib/share-landing-load.ts"),
    read("next.config.ts"),
    read("src/app/public/share/[linkId]/ShareLandingView.tsx"),
    read("src/app/public/share/[linkId]/ShareLandingFrame.tsx"),
    read("src/app/public/share/[linkId]/not-found.tsx"),
    read("src/app/public/share/[linkId]/share-landing.module.css"),
    read("src/app/api/share/[linkId]/route.ts"),
  ]);

  // 같은 입구·같은 범위 가드·기본 데스크 문맥(불러오기 모듈), 없으면 notFound.
  assert.match(loader, /runWithSpace\(null,/);
  assert.match(loader, /resolveShareLink\(/);
  assert.match(loader, /isWithin\(/);
  assert.match(page, /loadShareLanding\(/);
  assert.match(page, /notFound\(\)/);
  // 화면에는 describeShareLanding이 고른 값만 — 링크 객체·실명(createdBy)은 넘기지 않는다.
  assert.match(loader, /describeShareLanding\(/);
  assert.match(loader, /findUserById\(/);
  assert.doesNotMatch(loader, /\.createdBy/);
  assert.doesNotMatch(page, /link=\{|fileId=\{/);
  assert.doesNotMatch(view, /fileId|createdByUserId|createdBy/);
  // 다른 사이트의 틀 안에서 열리지 않는다.
  assert.match(nextConfig, /source: "\/public\/share\/:linkId"/);
  assert.match(nextConfig, /frame-ancestors 'none'/);

  // 라우트: 저장소를 읽기 전에 브라우저 요청을 화면으로 보낸다.
  const redirectAt = route.indexOf("wantsShareLanding(req.headers.get(\"accept\")");
  assert.ok(redirectAt > 0);
  assert.ok(redirectAt < route.indexOf("await resolveShareLink(linkId)"));
  assert.match(route, /status: 302/);
  // 미리보기는 두 갈래(폴더 안 파일·파일 링크) 모두 내려받기 기록보다 먼저 돌아간다.
  const previewCalls = [...route.matchAll(/return previewResponse\(/g)].map((m) => m.index!);
  const recordCalls = [...route.matchAll(/recordShareLinkDownloadAfter\(/g)].map((m) => m.index!);
  assert.equal(previewCalls.length, 2);
  assert.ok(previewCalls[0] < recordCalls[0] && previewCalls[1] < recordCalls[1]);
  assert.match(route, /shareLandingPreviewPlan\(/);
  assert.match(route, /limitDownload\(/);
  assert.doesNotMatch(route, /정해진 시간이 지나면/);

  // 화면: 1초 카운트다운(서버 시계 보정), 닫히면 멈춤, 받기는 download=1, 모두 받기는 큐.
  assert.match(view, /setInterval\(/);
  assert.match(view, /serverClockOffset\(/);
  assert.match(view, /shareLinkRemaining\(/);
  assert.match(view, /formatShareRemaining\(/);
  assert.match(view, /shareFileUrl\([^)]*"download"\)/);
  assert.match(view, /useVisitorDownloads\(/);
  assert.match(view, /\.enqueue\(/);
  assert.match(view, /formatVisitorDownloadStatus\(/);
  assert.match(view, /"모두 받기 \(\{count\}\)"/);
  assert.match(view, /"이 링크는 \{time\}에 닫힙니다"/);
  assert.match(view, /"이 링크는 \{time\}에 닫혔습니다"/);
  assert.match(view, /"보낸 사람"/);
  // 링크 주소 복사 — 원래 링크 꼴(shareLinkPath).
  assert.match(view, /shareLinkPath\(/);
  assert.match(view, /navigator\.clipboard\.writeText\(/);
  assert.match(view, /"링크 주소 복사"/);
  // 미리보기: PDF는 그릴 수 있는 브라우저만, HTML 주입 없음.
  assert.match(view, /pdfViewerEnabled/);
  assert.doesNotMatch(view, /dangerouslySetInnerHTML/);
  assert.match(view, /<PixelFileIcon/);

  // 같은 틀(밤 배경·크림 창·청록 제목줄)을 닫힘 안내도 쓴다.
  assert.match(frame, /styles\.titleBar/);
  assert.match(notFoundPage, /<ShareLandingFrame/);
  assert.match(notFoundPage, /t\("이 링크는 닫혔습니다"\)/);
  assert.match(css, /\.window \{[^}]*background: #f4e7c5;/);
  assert.match(css, /\.titleBar \{[^}]*background: #2d5c5b;/);
  assert.match(css, /\.primary \{[^}]*background: var\(--peach\);/);
});

test("배선: 받기 화면은 /public 아래라 새 최상위 경로(스페이스 예약어)를 만들지 않는다 (#17 B-3)", async () => {
  const { RESERVED_SLUGS } = await import("../src/lib/space-slug");
  assert.ok(RESERVED_SLUGS.has("public"));
  assert.ok(!RESERVED_SLUGS.has("share"), "share 스페이스가 있던 데스크를 깨지 않는다");
  // proxy 서명 거름망 밖(공개 폴더 화면과 같다).
  const proxy = await read("src/proxy.ts");
  assert.doesNotMatch(proxy, /"\/public/);
});

test("i18n: 받기 화면 문구가 네 사전에 있다 (#17 B-3)", async () => {
  const [{ englishDictionary }, { JA }, { HI }, { ZH }] = await Promise.all([
    import("../src/lib/i18n"),
    import("../src/lib/i18n-ja"),
    import("../src/lib/i18n-hi"),
    import("../src/lib/i18n-zh"),
  ]);
  const EN = englishDictionary();
  for (const key of [
    "미리보기",
    "앞부분만 보여 줍니다",
    "위치",
    "공유 폴더",
    "공유 파일",
    "공유 링크",
    "이 링크는 {time}에 닫힙니다",
    "이 링크는 {time}에 닫혔습니다",
    "링크 주소 복사",
    "공유 링크를 복사했습니다.",
    "아래 주소를 직접 선택해 복사해 주세요",
    "파일 {count}개",
    "보낸 사람",
    "남은 시간",
    "이 링크는 닫혔습니다",
    "받기",
    "{name} 받기",
    "빈 폴더입니다",
    "모두 받기 ({count})",
    "내려받는 중 {done}/{total}",
    "{count}개를 내려받았습니다",
    "{done}개 받음 · {failed}개 실패",
    "링크가 만료되었거나 존재하지 않습니다",
    "닫혔습니다",
    "{days}일 {time} 남음",
    "{time} 남음",
  ]) {
    for (const [name, dictionary] of Object.entries({ EN, JA, HI, ZH })) {
      assert.ok(key in dictionary, `${name} 사전에 없는 키 — ${key}`);
    }
  }
});
