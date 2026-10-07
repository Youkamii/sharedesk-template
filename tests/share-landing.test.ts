import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createVisitorDownloadRunner,
  type VisitorDownloadIo,
} from "../src/lib/client/visitor-downloads";
import {
  acceptsHtml,
  describeShareLanding,
  formatShareRemaining,
  formatUtcExpiry,
  shareFileUrl,
  shareLandingInlineType,
  shareLandingPath,
  shareLandingPreviewKind,
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
    shareLandingInlineType({ name, mimeType });
  assert.equal(inline("notes.txt", "text/plain"), "text/plain; charset=utf-8");
  assert.equal(inline("page", "text/html"), "text/plain; charset=utf-8");
  assert.equal(inline("간이 메모.txt", "application/octet-stream"), "text/plain; charset=utf-8");
  assert.equal(inline("photo.png", "application/octet-stream"), "image/png");
  assert.equal(inline("paper.pdf", "application/pdf"), "application/pdf");
  assert.equal(inline("bundle.zip", "application/octet-stream"), null);
  assert.equal(inline("logo.svg", "image/svg+xml"), null);
  assert.equal(inline("clip.mp4", "video/mp4"), null);
  assert.equal(inline("noext", "application/octet-stream"), null);
});

test("화면 값: 링크 장부의 fileId·만든 사람 id·루트 id는 싣지 않는다 (#17 B-3)", () => {
  const link = {
    linkId: LINK_ID,
    fileId: "cm9vdC9zZWNyZXQvcGF0aA",
    name: "보고서.pdf",
    kind: "file" as const,
    createdBy: "  홍길동 ",
    createdByUserId: "user-123",
    createdAt: "2026-10-07T00:00:00.000Z",
    expiresAt: "2026-10-08T00:00:00.000Z",
    quick: true,
    deleteOnExpire: true,
  };
  const model = describeShareLanding(
    link,
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
    sender: "홍길동",
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
  for (const secret of [link.fileId, "user-123", "secret-layout"]) {
    assert.ok(!serialized.includes(secret), `새면 안 되는 값 — ${secret}`);
  }

  const folder = describeShareLanding(
    { ...link, kind: "folder", name: "사진" },
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
});

test("모두 받기 큐: 3개씩만 동시에, 실패해도 나머지는 받고, 큰 파일은 브라우저에 맡긴다 (#17 B-3·B-6)", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fetched: string[] = [];
  const saved: string[] = [];
  const native: string[] = [];
  const releases: Array<() => void> = [];
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
  runner.enqueue([
    { id: "a", name: "a.txt", size: 3 },
    { id: "broken", name: "b.txt", size: 3 },
    { id: "c", name: "c.txt", size: null },
    { id: "huge", name: "big.iso", size: 600 * 1024 * 1024 },
    { id: "d", name: "d.txt", size: 3 },
    { id: "e", name: "e.txt", size: 3 },
  ]);
  // 처음엔 3개만 시작한다(큐의 순서대로 a·broken·c).
  assert.deepEqual(fetched, ["/dl?id=a", "/dl?id=broken", "/dl?id=c"]);
  // 하나씩 풀어 주며 끝까지 돌린다.
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  for (let guard = 0; guard < 20 && releases.length > 0; guard += 1) {
    releases.shift()!();
    await flush();
    await flush();
  }
  await flush();
  assert.ok(maxInFlight <= 3, `동시 ${maxInFlight}개`);
  assert.ok(Math.max(...snapshots) <= 3);
  assert.deepEqual(native, ["big.iso@/dl?id=huge"], "큰 파일은 fetch 없이 브라우저로");
  assert.ok(!fetched.includes("/dl?id=huge"));
  const bodySize = (id: string) => `body:/dl?id=${id}`.length;
  assert.deepEqual(
    saved.sort(),
    ["a", "c", "d", "e"].map((id) => `${id}.txt:${bodySize(id)}`),
  );
  const statuses = Object.fromEntries(
    runner.items().map((item) => [item.entryId, item.status]),
  );
  assert.deepEqual(statuses, {
    a: "done",
    broken: "failed",
    c: "done",
    huge: "done",
    d: "done",
    e: "done",
  });
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

test("API: 브라우저는 302로 받기 화면, curl·format=json·download=1은 그대로, 미리보기는 안전한 형식만·세지 않음 (#17 B-3)", async () => {
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

      // 미리보기: inline text/plain, 범위 요청 지원, 횟수에 세지 않는다.
      const preview = await call(link.linkId, "?preview=1", html);
      assert.equal(preview.status, 200);
      assert.match(preview.headers.get("content-disposition") ?? "", /^inline;/);
      assert.equal(preview.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
      assert.equal(await preview.text(), "hello landing");
      const partial = await call(link.linkId, "?preview=1", { range: "bytes=0-4" });
      assert.equal(partial.status, 206);
      assert.equal(await partial.text(), "hello");

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
      assert.equal(quickPreview.status, 200);
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
    });
  });
});

test("배선: 받기 화면 페이지는 링크 라우트와 같은 입구·가드, 내부 값은 넘기지 않는다 (#17 B-3)", async () => {
  const [page, view, frame, notFoundPage, css, route] = await Promise.all([
    read("src/app/public/share/[linkId]/page.tsx"),
    read("src/app/public/share/[linkId]/ShareLandingView.tsx"),
    read("src/app/public/share/[linkId]/ShareLandingFrame.tsx"),
    read("src/app/public/share/[linkId]/not-found.tsx"),
    read("src/app/public/share/[linkId]/share-landing.module.css"),
    read("src/app/api/share/[linkId]/route.ts"),
  ]);

  // 같은 입구·같은 범위 가드·기본 데스크 문맥, 없으면 notFound.
  assert.match(page, /runWithSpace\(null,/);
  assert.match(page, /resolveShareLink\(linkId\)/);
  assert.match(page, /adapter\.isWithin\(targetId, link\.fileId\)/);
  assert.match(page, /if \(!loaded\) notFound\(\);/);
  // 화면에는 describeShareLanding이 고른 값만 — 링크 객체를 통째로 넘기지 않는다.
  assert.match(page, /describeShareLanding\(link,/);
  assert.match(page, /model=\{loaded\.model\}/);
  assert.doesNotMatch(page, /link=\{|fileId=\{/);
  assert.doesNotMatch(view, /fileId|createdByUserId/);

  // 라우트: 저장소를 읽기 전에 브라우저 요청을 화면으로 보낸다.
  const redirectAt = route.indexOf("wantsShareLanding(req.headers.get(\"accept\")");
  assert.ok(redirectAt > 0);
  assert.ok(redirectAt < route.indexOf("await resolveShareLink(linkId)"));
  assert.match(route, /status: 302/);
  // 미리보기는 내려받기 기록보다 먼저 돌아간다 — 횟수에 들어가지 않는다.
  for (const target of ["entry.id", "link.fileId"]) {
    const previewAt = route.indexOf(`const preview = await adapter.download(${target}, range);`);
    const downloadAt = route.indexOf(`const file = await adapter.download(${target}, range);`);
    assert.ok(previewAt > 0 && previewAt < downloadAt, target);
  }
  assert.doesNotMatch(route, /정해진 시간이 지나면/);

  // 화면: 1초 카운트다운, 닫히면 멈춤·받기 막힘, 받기는 download=1, 모두 받기는 큐.
  assert.match(view, /window\.setInterval\(tick, 1_000\)/);
  assert.match(view, /shareLinkRemaining\(model\.expiresAt, now\)/);
  assert.match(view, /formatShareRemaining\(remaining, t\)/);
  assert.match(view, /if \(closed\) return;/);
  assert.match(view, /shareFileUrl\(model\.linkId, model\.entryId, "download"\)/);
  assert.match(view, /useVisitorDownloads\(/);
  assert.match(view, /onClick=\{\(\) => downloads\.enqueue\(files\)\}/);
  assert.match(view, /t\("모두 받기 \(\{count\}\)", \{ count: files\.length \}\)/);
  assert.match(view, /t\("이 링크는 \{time\}에 닫힙니다", \{ time: expiryText \}\)/);
  assert.match(view, /t\("이 링크는 \{time\}에 닫혔습니다", \{ time: expiryText \}\)/);
  assert.match(view, /t\("보낸 사람"\)/);
  // 미리보기: PDF는 그릴 수 있는 브라우저만, 텍스트는 앞부분만 범위 요청, HTML 주입 없음.
  assert.match(view, /pdfViewerEnabled/);
  assert.match(view, /Range: `bytes=0-\$\{TEXT_PREVIEW_BYTES - 1\}`/);
  assert.doesNotMatch(view, /dangerouslySetInnerHTML/);
  assert.match(view, /<PixelFileIcon entry=\{current\}/);

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
