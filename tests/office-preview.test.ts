import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  inlineContentType,
  officePreviewImport,
  previewKindOf,
} from "@/lib/preview";
import { DriveAdapter } from "@/lib/storage/drive";
import { LocalAdapter } from "@/lib/storage/local";
import { ROOT_ID } from "@/lib/storage/types";
import { createOfficePreviewFallback } from "@/lib/office-preview-fallback";

Object.assign(globalThis, { AsyncLocalStorage });

async function streamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

async function streamBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

test("Office와 OpenDocument는 PDF 미리보기, CSV는 텍스트 미리보기다", () => {
  for (const name of [
    "report.doc",
    "report.docx",
    "report.odt",
    "sheet.xls",
    "sheet.xlsx",
    "sheet.ods",
    "deck.ppt",
    "deck.pptx",
    "deck.odp",
  ]) {
    assert.equal(
      previewKindOf({ isFolder: false, name, mimeType: null }),
      "pdf",
      name,
    );
    assert.ok(officePreviewImport({ name, mimeType: null }), name);
  }

  assert.equal(
    previewKindOf({
      isFolder: false,
      name: "records.csv",
      mimeType: "application/vnd.ms-excel",
    }),
    "text",
  );
  assert.equal(
    previewKindOf({
      isFolder: false,
      name: "records.csv",
      mimeType: "application/csv",
    }),
    "text",
  );
  assert.equal(
    previewKindOf({
      isFolder: false,
      name: "records.csv",
      mimeType: "application/x-csv",
    }),
    "text",
  );
  assert.equal(
    officePreviewImport({
      name: "records.csv",
      mimeType: "application/vnd.ms-excel",
    }),
    null,
  );
  assert.equal(
    inlineContentType("application/vnd.ms-excel", "records.csv"),
    "text/plain; charset=utf-8",
  );
  assert.equal(
    inlineContentType("application/csv", "records.csv"),
    "text/plain; charset=utf-8",
  );
  assert.equal(
    inlineContentType("application/x-csv", "records.csv"),
    "text/plain; charset=utf-8",
  );
});

test("inline 요청은 preview 경로를 쓰고 TXT 편집 계약은 유지한다", async () => {
  const [downloadRoute, contentRoute, filesView] = await Promise.all([
    readFile(
      new URL("../src/app/api/drive/download/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/api/drive/content/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/files/FilesView.tsx", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(downloadRoute, /wantsInline\s*\? await adapter\.preview\(id, range\)/);
  assert.match(downloadRoute, /requireSession\(\{ fresh: wantsInline \}\)/);
  assert.match(
    downloadRoute,
    /inlineContentType\(file\.mimeType, file\.name\)/,
  );
  assert.match(contentRoute, /export async function PATCH/);
  assert.match(contentRoute, /adapter\.replaceContent\(/);
  assert.match(contentRoute, /value\.expectedVersion/);
  assert.match(filesView, /function isEditableTextEntry[\s\S]*?endsWith\("\.txt"\)/);
  assert.match(filesView, /async function savePreviewText/);
  assert.match(filesView, /method: "PATCH"/);
});

test("Office 실패 문서는 동적 값을 이스케이프하고 원본 다운로드 주소를 인코딩한다", async () => {
  const fallback = createOfficePreviewFallback({
    id: 'folder/id?x="&<',
    name: '"><img src=x onerror=alert(1)>&\'.docx',
    reason: '<script>alert("reason")</script>',
  });
  const html = await streamText(fallback.stream);

  assert.equal(fallback.mimeType, "text/html; charset=utf-8");
  assert.equal(fallback.generatedPreview, "office-fallback");
  assert.equal(fallback.acceptRanges, false);
  assert.equal(fallback.contentLength, new TextEncoder().encode(html).byteLength);
  assert.match(html, /font-family: "Galmuri11"/);
  assert.match(
    html,
    /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;&amp;&#39;\.docx/,
  );
  assert.match(html, /&lt;script&gt;alert\(&quot;reason&quot;\)&lt;\/script&gt;/);
  assert.match(
    html,
    /href="\/api\/drive\/download\?id=folder%2Fid%3Fx%3D%22%26%3C"/,
  );
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>alert/);
});

test("local 모드는 TXT를 실제로 저장하고 Office 한계를 미리보기 안에 설명한다", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sharedesk-office-preview-"));
  const originalRoot = process.env.LOCAL_STORAGE_ROOT;
  process.env.LOCAL_STORAGE_ROOT = root;
  try {
    const adapter = new LocalAdapter();
    const text = await adapter.upload(
      ROOT_ID,
      "memo.txt",
      "text/plain",
      new Blob(["before"]).stream(),
    );
    assert.ok(text.version);
    const saved = await adapter.replaceContent(
      text.id,
      text.version,
      "text/plain",
      new Blob(["after"]).stream(),
    );
    assert.ok(saved.version);
    assert.equal(await streamText((await adapter.preview(text.id)).stream), "after");

    const csv = await adapter.upload(
      ROOT_ID,
      "records.csv",
      "application/vnd.ms-excel",
      new Blob(["name,count\nbook,2\n"]).stream(),
    );
    const csvPreview = await adapter.preview(csv.id);
    assert.equal(csvPreview.mimeType, "text/csv");
    assert.equal(await streamText(csvPreview.stream), "name,count\nbook,2\n");

    const office = await adapter.upload(
      ROOT_ID,
      "report.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      new Blob(["fake-office"]).stream(),
    );
    const fallback = await adapter.preview(office.id, "bytes=0-3");
    assert.equal(fallback.status, 200);
    assert.equal(fallback.acceptRanges, false);
    assert.equal(fallback.mimeType, "text/html; charset=utf-8");
    assert.equal(fallback.generatedPreview, "office-fallback");
    const fallbackHtml = await streamText(fallback.stream);
    assert.match(fallbackHtml, /로컬 저장소 모드/);
    assert.match(fallbackHtml, /ShareDesk 문서 미리보기/);
    assert.match(
      fallbackHtml,
      new RegExp(
        `href="/api/drive/download\\?id=${encodeURIComponent(office.id)}"`,
      ),
    );
    assert.match(
      await streamText((await adapter.download(office.id)).stream),
      /fake-office/,
    );
  } finally {
    if (originalRoot === undefined) delete process.env.LOCAL_STORAGE_ROOT;
    else process.env.LOCAL_STORAGE_ROOT = originalRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("Office 실패 Route Handler만 안전한 HTML로 응답하고 일반 HTML은 실행하지 않는다", async () => {
  assert.equal(
    inlineContentType("text/html", "uploaded.html"),
    "text/plain; charset=utf-8",
  );
  const root = await mkdtemp(path.join(os.tmpdir(), "sharedesk-office-route-"));
  const original = {
    storageDriver: process.env.STORAGE_DRIVER,
    localRoot: process.env.LOCAL_STORAGE_ROOT,
    accessKeys: process.env.ACCESS_KEYS,
    sessionSecret: process.env.SESSION_SECRET,
  };
  const accessKey = "office-preview-route-key";
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  process.env.ACCESS_KEYS = accessKey;
  process.env.SESSION_SECRET = "office-preview-route-secret-at-least-32-chars";

  try {
    const adapter = new LocalAdapter();
    const office = await adapter.upload(
      ROOT_ID,
      "proposal.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      new Blob(["fake-office"]).stream(),
    );
    const uploadedHtml = await adapter.upload(
      ROOT_ID,
      "uploaded.html",
      "text/html",
      new Blob(['<script>document.body.textContent="실행됨"</script>']).stream(),
    );
    const uploadedMarkup = await adapter.upload(
      ROOT_ID,
      "uploaded.txt",
      "text/plain",
      new Blob(['<script>document.body.textContent="실행됨"</script>']).stream(),
    );
    const pdf = await adapter.upload(
      ROOT_ID,
      "preview.pdf",
      "application/pdf",
      new Blob(["%PDF-preview"]).stream(),
    );

    const { NextRequest } = await import("next/server");
    const { createKeySession } = await import("@/lib/auth");
    const { COOKIE_NAME } = await import("@/lib/session-token");
    const { createRequestStoreForAPI } = await import(
      "next/dist/server/async-storage/request-store.js"
    );
    const { workUnitAsyncStorage } = await import(
      "next/dist/server/app-render/work-unit-async-storage.external.js"
    );
    const { workAsyncStorage } = await import(
      "next/dist/server/app-render/work-async-storage.external.js"
    );
    type WorkStore = import(
      "next/dist/server/app-render/work-async-storage.external.js"
    ).WorkStore;
    const route = await import("@/app/api/drive/download/route");
    const token = await createKeySession(
      createHash("sha256").update(accessKey).digest("hex"),
    );

    async function call(
      id: string,
      options: { inline?: boolean; range?: string } = {},
    ): Promise<Response> {
      const query = new URLSearchParams({ id });
      if (options.inline) query.set("disposition", "inline");
      const url = `http://localhost/api/drive/download?${query}`;
      const headers = new Headers({
        Cookie: `${COOKIE_NAME}=${token}`,
      });
      if (options.range) headers.set("Range", options.range);
      const request = new NextRequest(url, { headers });
      const parsed = new URL(url);
      const requestStore = createRequestStoreForAPI(
        request,
        { pathname: parsed.pathname, search: parsed.search },
        { tags: [], expirationsByCacheKind: new Map() },
        undefined,
        undefined,
        undefined,
      );
      const workStore = {
        route: parsed.pathname,
        forceStatic: false,
      } as unknown as WorkStore;
      return workAsyncStorage.run(workStore, () =>
        workUnitAsyncStorage.run(requestStore, () => route.GET(request)),
      );
    }

    const fallback = await call(office.id, { inline: true, range: "bytes=0-3" });
    assert.equal(fallback.status, 200);
    assert.equal(fallback.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.match(fallback.headers.get("Content-Disposition") ?? "", /^inline;/);
    assert.equal(fallback.headers.get("Cache-Control"), "private, no-store");
    assert.equal(fallback.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(fallback.headers.get("X-Frame-Options"), "SAMEORIGIN");
    assert.equal(fallback.headers.get("Accept-Ranges"), null);
    const csp = fallback.headers.get("Content-Security-Policy") ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'none'/);
    assert.match(csp, /style-src 'unsafe-inline'/);
    assert.match(csp, /font-src 'self'/);
    assert.match(csp, /frame-ancestors 'self'/);
    const fallbackBody = await fallback.text();
    assert.equal(
      fallback.headers.get("Content-Length"),
      String(new TextEncoder().encode(fallbackBody).byteLength),
    );
    assert.match(fallbackBody, /ShareDesk 문서 미리보기/);
    assert.match(
      fallbackBody,
      new RegExp(
        `href="/api/drive/download\\?id=${encodeURIComponent(office.id)}"`,
      ),
    );

    const unsafe = await call(uploadedHtml.id, { inline: true });
    assert.equal(unsafe.status, 200);
    assert.equal(unsafe.headers.get("Content-Type"), "application/octet-stream");
    assert.match(unsafe.headers.get("Content-Disposition") ?? "", /^attachment;/);
    assert.equal(unsafe.headers.get("Content-Security-Policy"), null);
    assert.match(await unsafe.text(), /<script>/);

    const markup = await call(uploadedMarkup.id, { inline: true });
    assert.equal(markup.status, 200);
    assert.equal(markup.headers.get("Content-Type"), "text/plain; charset=utf-8");
    assert.match(markup.headers.get("Content-Disposition") ?? "", /^inline;/);
    assert.equal(markup.headers.get("Content-Security-Policy"), null);
    assert.match(await markup.text(), /<script>/);

    const pdfPreview = await call(pdf.id, {
      inline: true,
      range: "bytes=0-3",
    });
    assert.equal(pdfPreview.status, 206);
    assert.equal(pdfPreview.headers.get("Content-Type"), "application/pdf");
    assert.equal(pdfPreview.headers.get("Content-Range"), "bytes 0-3/12");
    assert.match(pdfPreview.headers.get("Content-Disposition") ?? "", /^inline;/);
    assert.equal(await pdfPreview.text(), "%PDF");

    const originalOffice = await call(office.id, { range: "bytes=0-3" });
    assert.equal(originalOffice.status, 206);
    assert.equal(originalOffice.headers.get("Content-Range"), "bytes 0-3/11");
    assert.match(
      originalOffice.headers.get("Content-Disposition") ?? "",
      /^attachment;/,
    );
    assert.equal(await originalOffice.text(), "fake");
  } finally {
    for (const [name, value] of [
      ["STORAGE_DRIVER", original.storageDriver],
      ["LOCAL_STORAGE_ROOT", original.localRoot],
      ["ACCESS_KEYS", original.accessKeys],
      ["SESSION_SECRET", original.sessionSecret],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Drive Office 미리보기는 호스트 권한으로 변환하고 매번 임시 파일을 지운다", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    rootId: process.env.DRIVE_ROOT_FOLDER_ID,
    stateId: process.env.DRIVE_STATE_FOLDER_ID,
  };
  process.env.GOOGLE_CLIENT_ID = "preview-client";
  process.env.GOOGLE_CLIENT_SECRET = "preview-secret";
  process.env.GOOGLE_REFRESH_TOKEN = "preview-refresh";
  process.env.DRIVE_ROOT_FOLDER_ID = "root-folder";
  process.env.DRIVE_STATE_FOLDER_ID = "state-folder";

  const calls: Array<{
    url: string;
    method: string;
    range: string | null;
    authorization: string | null;
    body: string;
  }> = [];
  let uploadNumber = 0;
  let currentSourceId = "";
  const sessionSource = new Map<string, string>();
  const deleted: string[] = [];
  const deleteAttempts = new Map<string, number>();
  const orphanQueries: string[] = [];
  let failBrokenCleanup = true;
  const metadata = new Map([
    [
      "office-file",
      {
        id: "office-file",
        name: "report.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: "12",
        parents: ["root-folder"],
        trashed: false,
      },
    ],
    [
      "large-office",
      {
        id: "large-office",
        name: "large.pptx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        size: String(25 * 1024 * 1024 + 1),
        parents: ["root-folder"],
        trashed: false,
      },
    ],
    [
      "broken-office",
      {
        id: "broken-office",
        name: "broken.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        size: "10",
        parents: ["root-folder"],
        trashed: false,
      },
    ],
  ]);

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const method = init.method ?? "GET";
    calls.push({
      url,
      method,
      range: headers.get("range"),
      authorization: headers.get("authorization"),
      body: typeof init.body === "string" ? init.body : "",
    });

    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "host-token", expires_in: 3600 });
    }
    if (url.includes("/files/state-folder?fields=id,name,mimeType,parents,trashed")) {
      return Response.json({
        id: "state-folder",
        name: ".sharedesk",
        mimeType: "application/vnd.google-apps.folder",
        parents: ["root-folder"],
        trashed: false,
      });
    }
    if (
      url.includes("/files?") &&
      new URL(url).searchParams
        .get("q")
        ?.includes("name contains '.sharedesk-preview-'")
    ) {
      const query = new URL(url).searchParams.get("q") ?? "";
      orphanQueries.push(query);
      assert.match(
        query,
        /^'state-folder' in parents and name contains '\.sharedesk-preview-' and trashed=(true|false)$/,
      );
      return Response.json({
        files: query.includes("trashed=true")
          ? [
              {
                id: "orphan-preview",
                name: ".sharedesk-preview-orphan",
                createdTime: "2020-01-01T00:00:00.000Z",
              },
              {
                id: "unrelated-state-file",
                name: "users.json",
                createdTime: "2020-01-01T00:00:00.000Z",
              },
              {
                id: "recent-preview",
                name: ".sharedesk-preview-recent",
                createdTime: new Date().toISOString(),
              },
              {
                id: "invalid-date-preview",
                name: ".sharedesk-preview-unknown",
                createdTime: "not-a-date",
              },
            ]
          : [
              {
                id: "active-orphan-preview",
                name: ".sharedesk-preview-active-orphan",
                createdTime: "2020-01-01T00:00:00.000Z",
              },
              {
                id: "recent-active-preview",
                name: ".sharedesk-preview-recent-active",
                createdTime: new Date().toISOString(),
              },
            ],
      });
    }
    const metadataId = [...metadata.keys()].find((id) =>
      url.includes(`/files/${id}?fields=id,name,mimeType,size,modifiedTime,parents,trashed`),
    );
    if (metadataId) return Response.json(metadata.get(metadataId));

    const sourceId = [...metadata.keys()].find((id) =>
      url.includes(`/files/${id}?alt=media`),
    );
    if (sourceId) {
      currentSourceId = sourceId;
      if (headers.get("range")) {
        return new Response("orig", {
          status: 206,
          headers: {
            "Content-Type": metadata.get(sourceId)?.mimeType ?? "application/octet-stream",
            "Content-Length": "4",
            "Content-Range": "bytes 0-3/12",
          },
        });
      }
      return new Response("office-data", {
        headers: { "Content-Length": sourceId === "broken-office" ? "10" : "12" },
      });
    }
    if (
      url.includes("/upload/drive/v3/files?uploadType=resumable") &&
      method === "POST"
    ) {
      uploadNumber += 1;
      const session = `https://www.googleapis.com/upload-session/${uploadNumber}`;
      sessionSource.set(session, currentSourceId);
      const body = JSON.parse(String(init.body)) as {
        mimeType?: string;
        parents?: string[];
        trashed?: boolean;
      };
      assert.deepEqual(body.parents, ["state-folder"]);
      assert.match(body.mimeType ?? "", /^application\/vnd\.google-apps\./);
      assert.equal(body.trashed, true);
      return new Response(null, { headers: { Location: session } });
    }
    if (url.includes("/upload-session/") && method === "PUT") {
      const source = sessionSource.get(url);
      const suffix = url.slice(url.lastIndexOf("/") + 1);
      return Response.json({
        id: `temporary-${source}-${suffix}`,
        mimeType:
          source === "broken-office"
            ? "application/vnd.google-apps.spreadsheet"
            : "application/vnd.google-apps.document",
        trashed: true,
      });
    }
    if (url.includes("/export?mimeType=application%2Fpdf")) {
      if (url.includes("temporary-broken-office")) {
        return new Response("conversion failed", { status: 500 });
      }
      return new Response("%PDF-preview", {
        headers: { "Content-Length": "12", "Content-Type": "application/pdf" },
      });
    }
    if (url.includes("/files/temporary-") && method === "DELETE") {
      const id = url.slice(url.lastIndexOf("/") + 1);
      const attempt = (deleteAttempts.get(id) ?? 0) + 1;
      deleteAttempts.set(id, attempt);
      if (id === "temporary-office-file-1" && attempt < 3) {
        return new Response("retry cleanup", { status: 503 });
      }
      if (id.startsWith("temporary-broken-office-") && failBrokenCleanup) {
        return new Response("retry later", { status: 503 });
      }
      deleted.push(id);
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/files/orphan-preview") && method === "DELETE") {
      deleted.push("orphan-preview");
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/files/active-orphan-preview") && method === "DELETE") {
      deleted.push("active-orphan-preview");
      return new Response(null, { status: 204 });
    }
    throw new Error(`예상하지 못한 요청: ${method} ${url}`);
  };

  try {
    const adapter = new DriveAdapter();
    for (let index = 0; index < 2; index++) {
      const preview = await adapter.preview("office-file", "bytes=0-99");
      assert.equal(preview.status, 200);
      assert.equal(preview.mimeType, "application/pdf");
      assert.equal(preview.acceptRanges, false);
      assert.equal(
        new TextDecoder().decode(await streamBytes(preview.stream)),
        "%PDF-preview",
      );
    }
    assert.equal(
      calls.filter((call) => call.url.includes("/files/office-file?alt=media"))
        .some((call) => call.range !== null),
      false,
      "Office 변환에는 부분 Range를 전달하지 않고 완전한 문서를 사용한다",
    );
    assert.equal(deleteAttempts.get("temporary-office-file-1"), 3);
    assert.ok(deleted.includes("temporary-office-file-1"));
    assert.ok(deleted.includes("temporary-office-file-2"));
    assert.ok(deleted.includes("orphan-preview"));
    assert.ok(deleted.includes("active-orphan-preview"));
    assert.ok(orphanQueries.some((query) => query.endsWith("trashed=true")));
    assert.ok(orphanQueries.some((query) => query.endsWith("trashed=false")));
    assert.equal(deleted.includes("unrelated-state-file"), false);
    assert.equal(deleted.includes("recent-preview"), false);
    assert.equal(
      calls.some((call) => call.url.endsWith("/files/recent-active-preview")),
      false,
    );
    assert.equal(deleted.includes("invalid-date-preview"), false);

    const original = await adapter.download("office-file", "bytes=0-3");
    assert.equal(original.status, 206);
    assert.equal(new TextDecoder().decode(await streamBytes(original.stream)), "orig");
    assert.ok(
      calls.some(
        (call) =>
          call.url.includes("/files/office-file?alt=media") &&
          call.range === "bytes=0-3",
      ),
      "원본 다운로드 경로는 Range를 그대로 보존한다",
    );

    const largeFallback = await adapter.preview("large-office");
    assert.match(await streamText(largeFallback.stream), /25 MiB/);
    assert.equal(
      calls.some((call) => call.url.includes("/files/large-office?alt=media")),
      false,
      "크기 한도를 넘으면 원본 전송과 임시 변환을 시작하지 않는다",
    );

    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const failed = await adapter.preview("broken-office");
      assert.equal(failed.mimeType, "text/html; charset=utf-8");
      assert.equal(failed.generatedPreview, "office-fallback");
      assert.match(await streamText(failed.stream), /원본 다운로드/);
    } finally {
      console.error = originalConsoleError;
    }
    assert.equal(
      deleted.some((id) => id.startsWith("temporary-broken-office-")),
      false,
      "모든 즉시 삭제 재시도가 실패하면 다음 정리 대상으로 남긴다",
    );
    failBrokenCleanup = false;
    await adapter.preview("office-file");
    assert.ok(
      deleted.some((id) => id.startsWith("temporary-broken-office-")),
      "다음 미리보기에서 이전 임시 Google 문서를 다시 지운다",
    );
    assert.ok(
      calls
        .filter((call) => call.url.startsWith("https://www.googleapis.com"))
        .every((call) => call.authorization === "Bearer host-token"),
      "변환과 export는 참가자 권한이 아니라 서버의 호스트 토큰을 쓴다",
    );
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of [
      ["GOOGLE_CLIENT_ID", originalEnv.clientId],
      ["GOOGLE_CLIENT_SECRET", originalEnv.clientSecret],
      ["GOOGLE_REFRESH_TOKEN", originalEnv.refreshToken],
      ["DRIVE_ROOT_FOLDER_ID", originalEnv.rootId],
      ["DRIVE_STATE_FOLDER_ID", originalEnv.stateId],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
