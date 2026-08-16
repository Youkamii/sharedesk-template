import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

// Next의 요청 저장소는 서버 부트스트랩 때 이 전역을 넣는다. 라우트 함수를 실제
// Web Request로 직접 검증하는 테스트에서도 같은 Node 구현을 먼저 연결한다.
Object.assign(globalThis, { AsyncLocalStorage });

const SESSION_SECRET = "storage-route-test-secret-with-32-characters";
const ACCESS_KEY = "storage-route-access-key";

function stream(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body as ReadableStream<Uint8Array>;
}

function chunkedStream(
  text: string,
  chunkSize = 4_096,
): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= encoded.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, encoded.byteLength);
      controller.enqueue(encoded.slice(offset, end));
      offset = end;
    },
  });
}

function assertStorageCode(error: unknown, code: string): void {
  assert.ok(error && typeof error === "object" && "code" in error);
  assert.equal((error as { code: unknown }).code, code);
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assertStorageCode(error, code);
    return true;
  });
}

test("텍스트 저장, 폴더 메모, 루트 기준 주소 API", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-content-note-"));
  const previous = {
    driver: process.env.STORAGE_DRIVER,
    root: process.env.LOCAL_STORAGE_ROOT,
    secret: process.env.SESSION_SECRET,
    keys: process.env.ACCESS_KEYS,
  };
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.ACCESS_KEYS = ACCESS_KEY;

  const { LocalAdapter } = await import("@/lib/storage/local");
  const { ROOT_ID } = await import("@/lib/storage/types");
  const { getFolderNote, updateFolderNote, MAX_FOLDER_NOTE_BYTES } =
    await import("@/lib/folder-note");
  const { resolveFolderPath } = await import("@/lib/folder-path");
  const adapter = new LocalAdapter();
  const docs = await adapter.createFolder(ROOT_ID, "문서");
  const nested = await adapter.createFolder(docs.id, "하위");
  const editable = await adapter.upload(
    docs.id,
    "공용.txt",
    "text/plain",
    stream("처음"),
  );

  try {
    await t.test("일반 파일은 버전이 맞을 때만 안전하게 교체한다", async () => {
      assert.ok(editable.version);
      const saved = await adapter.replaceContent(
        editable.id,
        editable.version,
        "text/plain",
        stream("수정된 내용"),
      );
      assert.equal(saved.id, editable.id);
      assert.notEqual(saved.layoutKey, editable.layoutKey);
      assert.notEqual(saved.version, editable.version);
      assert.equal(await readFile(path.join(root, "문서", "공용.txt"), "utf8"), "수정된 내용");

      await rejectsWithCode(
        adapter.replaceContent(
          editable.id,
          editable.version,
          "text/plain",
          stream("오래된 저장"),
        ),
        "CONFLICT",
      );
      await rejectsWithCode(
        adapter.replaceContent(
          docs.id,
          docs.version!,
          "text/plain",
          stream("폴더 본문"),
        ),
        "BAD_ID",
      );
      await rejectsWithCode(
        adapter.replaceContent(
          ROOT_ID,
          "any-version",
          "text/plain",
          stream("루트 본문"),
        ),
        "BAD_ID",
      );
    });

    await t.test("같은 버전의 동시 저장은 하나만 성공한다", async () => {
      const race = await adapter.upload(
        docs.id,
        "동시수정.txt",
        "text/plain",
        stream("원본"),
      );
      assert.ok(race.version);
      const results = await Promise.allSettled([
        adapter.replaceContent(
          race.id,
          race.version,
          "text/plain",
          stream("첫 번째"),
        ),
        adapter.replaceContent(
          race.id,
          race.version,
          "text/plain",
          stream("두 번째"),
        ),
      ]);
      assert.equal(
        results.filter((result) => result.status === "fulfilled").length,
        1,
      );
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      assert.ok(rejected);
      assertStorageCode(rejected.reason, "CONFLICT");
      assert.match(
        await readFile(path.join(root, "문서", "동시수정.txt"), "utf8"),
        /^(첫 번째|두 번째)$/,
      );
      assert.deepEqual(
        (await readdir(path.join(root, "문서"))).filter((name) =>
          name.startsWith(".sharedesk-write-"),
        ),
        [],
      );
    });

    await t.test("본문 교체 중 rename은 같은 mutation 잠금에서 순서를 기다린다", async () => {
      const race = await adapter.upload(
        docs.id,
        "잠금.txt",
        "text/plain",
        stream("원본"),
      );
      assert.ok(race.version);

      let markStarted!: () => void;
      let releaseBody!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const bodyReleased = new Promise<void>((resolve) => {
        releaseBody = resolve;
      });
      let sent = false;
      const blockedBody = new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            if (sent) return;
            sent = true;
            markStarted();
            await bodyReleased;
            controller.enqueue(new TextEncoder().encode("교체 본문"));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );

      const replacing = adapter.replaceContent(
        race.id,
        race.version,
        "text/plain",
        blockedBody,
      );
      await started;
      const renaming = adapter.rename(
        race.id,
        "잠금-변경.txt",
        race.version,
      );
      const mutations = Promise.allSettled([replacing, renaming]);
      const early = await Promise.race([
        renaming.then(
          () => "settled",
          () => "settled",
        ),
        new Promise<"pending">((resolve) =>
          setTimeout(() => resolve("pending"), 100),
        ),
      ]);
      releaseBody();
      const results = await mutations;

      assert.equal(early, "pending");
      assert.deepEqual(
        results.map((result) => result.status),
        ["fulfilled", "rejected"],
      );
      assert.equal(
        results[1].status === "rejected" &&
          (results[1].reason as { code?: unknown }).code,
        "CONFLICT",
      );
      assert.equal(
        await readFile(path.join(root, "문서", "잠금.txt"), "utf8"),
        "교체 본문",
      );
    });

    await t.test("폴더 메모는 폴더 identity별 상태 파일과 CAS를 쓴다", async () => {
      assert.deepEqual(await getFolderNote(docs.id, adapter), {
        content: "",
        version: null,
      });
      const first = await updateFolderNote(
        docs.id,
        "함께 보는 메모",
        null,
        adapter,
      );
      assert.ok(first.version);
      assert.deepEqual(await getFolderNote(docs.id, adapter), first);
      await rejectsWithCode(
        updateFolderNote(docs.id, "오래된 첫 저장", null, adapter),
        "CONFLICT",
      );

      const raced = await Promise.allSettled([
        updateFolderNote(docs.id, "A가 저장", first.version, adapter),
        updateFolderNote(docs.id, "B가 저장", first.version, adapter),
      ]);
      assert.equal(
        raced.filter((result) => result.status === "fulfilled").length,
        1,
      );
      assert.equal(
        raced.filter((result) => result.status === "rejected").length,
        1,
      );
      assert.match((await getFolderNote(docs.id, adapter)).content, /^[AB]가 저장$/);

      await rejectsWithCode(
        updateFolderNote(
          docs.id,
          "x".repeat(MAX_FOLDER_NOTE_BYTES + 1),
          (await getFolderNote(docs.id, adapter)).version,
          adapter,
        ),
        "BAD_ID",
      );
      await rejectsWithCode(getFolderNote(editable.id, adapter), "BAD_ID");

      const stateNames = await readdir(path.join(root, ".sharedesk"));
      const noteName = stateNames.find((name) => name.startsWith("folder-note-"));
      assert.ok(noteName);
      const stored = JSON.parse(
        await readFile(path.join(root, ".sharedesk", noteName), "utf8"),
      ) as { folderKey: string };
      assert.equal(stored.folderKey, docs.layoutKey);
    });

    await t.test("주소는 ShareDesk 루트부터 실제 폴더를 따라간다", async () => {
      assert.deepEqual(await resolveFolderPath("/", adapter), {
        folderId: ROOT_ID,
        crumbs: [{ id: ROOT_ID, name: "ShareDesk" }],
      });
      assert.deepEqual(await resolveFolderPath("/문서/하위/..", adapter), {
        folderId: docs.id,
        crumbs: [
          { id: ROOT_ID, name: "ShareDesk" },
          { id: docs.id, name: "문서" },
        ],
      });
      // 정규화한 뒤 실제 경로를 확인하므로 없어지는 구간은 조회하지 않는다.
      assert.equal(
        (await resolveFolderPath("문서/없는곳/..", adapter)).folderId,
        docs.id,
      );
      assert.equal(
        (await resolveFolderPath("문서/하위", adapter)).folderId,
        nested.id,
      );
      await rejectsWithCode(resolveFolderPath("../문서", adapter), "BAD_ID");
      await rejectsWithCode(
        resolveFolderPath("문서/공용.txt", adapter),
        "BAD_ID",
      );
      await rejectsWithCode(
        resolveFolderPath("문서/없는폴더", adapter),
        "NOT_FOUND",
      );
    });

    await t.test("Route Handler는 인증, 한도, 응답 계약을 지킨다", async () => {
      const { NextRequest } = await import("next/server");
      const { createKeySession } = await import("@/lib/auth");
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
      const contentRoute = await import("@/app/api/drive/content/route");
      const folderNoteRoute = await import("@/app/api/folder-note/route");
      const pathRoute = await import("@/app/api/drive/path/route");
      const keyHash = createHash("sha256").update(ACCESS_KEY).digest("hex");
      const token = await createKeySession(keyHash);

      async function call(
        handler: (request: Request) => Promise<Response>,
        url: string,
        options: {
          method?: string;
          body?: unknown;
          rawBody?: BodyInit;
          headers?: HeadersInit;
          authenticated?: boolean;
        } = {},
      ): Promise<Response> {
        const headers = new Headers(options.headers);
        if (options.authenticated !== false) {
          headers.set("Cookie", `sharedesk_session=${token}`);
        }
        let body = options.rawBody;
        if (options.body !== undefined) {
          headers.set("Content-Type", "application/json");
          body = JSON.stringify(options.body);
        }
        const init = {
          method: options.method ?? "GET",
          headers,
          body,
        };
        const request = new NextRequest(url, {
          ...init,
          ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
        });
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
          workUnitAsyncStorage.run(requestStore, () => handler(request)),
        );
      }

      const apiFile = await adapter.upload(
        docs.id,
        "API.txt",
        "text/plain",
        stream("API 원본"),
      );
      const unauthorized = await call(
        contentRoute.PATCH,
        "http://localhost/api/drive/content",
        {
          method: "PATCH",
          body: {
            id: apiFile.id,
            expectedVersion: apiFile.version,
            mimeType: "text/plain",
            content: "거부될 저장",
          },
          authenticated: false,
        },
      );
      assert.equal(unauthorized.status, 401);

      const saved = await call(
        contentRoute.PATCH,
        "http://localhost/api/drive/content",
        {
          method: "PATCH",
          body: {
            id: apiFile.id,
            expectedVersion: apiFile.version,
            mimeType: "text/plain; charset=utf-8",
            content: "API 저장 내용",
          },
        },
      );
      assert.equal(saved.status, 200);
      const savedBody = (await saved.json()) as {
        entry: { id: string; version: string | null };
      };
      assert.equal(savedBody.entry.id, apiFile.id);
      assert.ok(savedBody.entry.version);
      assert.equal(await readFile(path.join(root, "문서", "API.txt"), "utf8"), "API 저장 내용");

      const stale = await call(
        contentRoute.PATCH,
        "http://localhost/api/drive/content",
        {
          method: "PATCH",
          body: {
            id: apiFile.id,
            expectedVersion: apiFile.version,
            mimeType: "text/plain",
            content: "늦은 저장",
          },
        },
      );
      assert.equal(stale.status, 409);
      assert.equal((await stale.json()).code, "CONFLICT");

      const oversized = await call(
        contentRoute.PATCH,
        "http://localhost/api/drive/content",
        {
          method: "PATCH",
          body: {
            id: apiFile.id,
            expectedVersion: savedBody.entry.version,
            mimeType: "text/plain",
            content: "x".repeat(1024 * 1024 + 1),
          },
        },
      );
      assert.equal(oversized.status, 400);
      assert.equal((await oversized.json()).code, "BAD_ID");

      let declaredOversizePulls = 0;
      const declaredOversize = await call(
        contentRoute.PATCH,
        "http://localhost/api/drive/content",
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(1024 * 1024 * 6 + 4_097),
          },
          rawBody: new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                declaredOversizePulls += 1;
                controller.enqueue(new TextEncoder().encode("{}"));
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
        },
      );
      assert.equal(declaredOversize.status, 400);
      assert.equal((await declaredOversize.json()).code, "BAD_ID");
      assert.equal(declaredOversizePulls, 0);

      const chunkedOversize = await call(
        contentRoute.PATCH,
        "http://localhost/api/drive/content",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          rawBody: chunkedStream(
            JSON.stringify({
              id: apiFile.id,
              expectedVersion: savedBody.entry.version,
              mimeType: "text/plain",
              content: "x".repeat(1024 * 1024 + 8 * 1024),
            }),
          ),
        },
      );
      assert.equal(chunkedOversize.status, 400);
      assert.equal((await chunkedOversize.json()).code, "BAD_ID");

      const escapedContentFile = await adapter.upload(
        docs.id,
        "escaped.txt",
        "text/plain",
        stream("before"),
      );
      const escapedContent = "\n".repeat(1024 * 1024);
      const escapedContentResponse = await call(
        contentRoute.PATCH,
        "http://localhost/api/drive/content",
        {
          method: "PATCH",
          body: {
            id: escapedContentFile.id,
            expectedVersion: escapedContentFile.version,
            mimeType: "text/plain",
            content: escapedContent,
          },
        },
      );
      assert.equal(escapedContentResponse.status, 200);
      assert.equal(
        await readFile(path.join(root, "문서", "escaped.txt"), "utf8"),
        escapedContent,
      );

      const binary = await adapter.upload(
        docs.id,
        "편집불가.bin",
        "application/octet-stream",
        stream("binary"),
      );
      const nonText = await call(
        contentRoute.PATCH,
        "http://localhost/api/drive/content",
        {
          method: "PATCH",
          body: {
            id: binary.id,
            expectedVersion: binary.version,
            mimeType: "text/plain",
            content: "확장자를 우회한 저장",
          },
        },
      );
      assert.equal(nonText.status, 400);
      assert.equal((await nonText.json()).code, "BAD_ID");

      const noteFolder = await adapter.createFolder(ROOT_ID, "API 메모");
      const noteUrl = `http://localhost/api/folder-note?folderId=${encodeURIComponent(noteFolder.id)}`;
      const emptyNote = await call(folderNoteRoute.GET, noteUrl);
      assert.equal(emptyNote.status, 200);
      assert.deepEqual(await emptyNote.json(), { content: "", version: null });
      const noteSaved = await call(
        folderNoteRoute.PATCH,
        "http://localhost/api/folder-note",
        {
          method: "PATCH",
          body: {
            folderId: noteFolder.id,
            content: "API 폴더 메모",
            expectedVersion: null,
          },
        },
      );
      assert.equal(noteSaved.status, 200);
      const noteSavedBody = (await noteSaved.json()) as {
        content: string;
        version: string | null;
      };
      assert.equal(noteSavedBody.content, "API 폴더 메모");
      assert.ok(noteSavedBody.version);
      const staleNote = await call(
        folderNoteRoute.PATCH,
        "http://localhost/api/folder-note",
        {
          method: "PATCH",
          body: {
            folderId: noteFolder.id,
            content: "늦은 메모",
            expectedVersion: null,
          },
        },
      );
      assert.equal(staleNote.status, 409);
      assert.equal((await staleNote.json()).code, "CONFLICT");

      const lyingLengthNote = await call(
        folderNoteRoute.PATCH,
        "http://localhost/api/folder-note",
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "16",
          },
          rawBody: chunkedStream(
            JSON.stringify({
              folderId: noteFolder.id,
              content: "x".repeat(100 * 1024 + 8 * 1024),
              expectedVersion: noteSavedBody.version,
            }),
          ),
        },
      );
      assert.equal(lyingLengthNote.status, 400);
      assert.equal((await lyingLengthNote.json()).code, "BAD_ID");

      const escapedNoteFolder = await adapter.createFolder(
        ROOT_ID,
        "escaped note",
      );
      const escapedNoteContent = "\n".repeat(100 * 1024);
      const escapedNote = await call(
        folderNoteRoute.PATCH,
        "http://localhost/api/folder-note",
        {
          method: "PATCH",
          body: {
            folderId: escapedNoteFolder.id,
            content: escapedNoteContent,
            expectedVersion: null,
          },
        },
      );
      assert.equal(escapedNote.status, 200);
      assert.equal((await escapedNote.json()).content, escapedNoteContent);

      const pathUrl = new URL("http://localhost/api/drive/path");
      pathUrl.searchParams.set("path", "/문서/하위/..");
      const pathResponse = await call(pathRoute.GET, pathUrl.toString());
      assert.equal(pathResponse.status, 200);
      assert.deepEqual(await pathResponse.json(), {
        folderId: docs.id,
        crumbs: [
          { id: ROOT_ID, name: "ShareDesk" },
          { id: docs.id, name: "문서" },
        ],
      });
      const escapeUrl = new URL("http://localhost/api/drive/path");
      escapeUrl.searchParams.set("path", "../문서");
      const escaped = await call(pathRoute.GET, escapeUrl.toString());
      assert.equal(escaped.status, 400);
      assert.equal((await escaped.json()).code, "BAD_ID");
    });

    await t.test("Drive 본문 교체는 v2 If-Match와 루트 경계를 쓴다", async () => {
      const originalFetch = globalThis.fetch;
      const originalGoogle = {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
        driveRoot: process.env.DRIVE_ROOT_FOLDER_ID,
        stateFolder: process.env.DRIVE_STATE_FOLDER_ID,
      };
      process.env.GOOGLE_CLIENT_ID = "test-client";
      process.env.GOOGLE_CLIENT_SECRET = "test-secret";
      process.env.GOOGLE_REFRESH_TOKEN = "test-refresh";
      process.env.DRIVE_ROOT_FOLDER_ID = "drive-root";
      process.env.DRIVE_STATE_FOLDER_ID = "state-dir";
      let uploadCount = 0;
      let uploadedText = "";
      const calls: Array<{ url: string; headers: Headers }> = [];

      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        const method = init.method ?? "GET";
        const headers = new Headers(init.headers);
        calls.push({ url, headers });
        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({ access_token: "test-token", expires_in: 3600 });
        }
        if (
          url.includes(
            "/drive/v3/files/state-dir?fields=id,name,mimeType,parents,trashed",
          )
        ) {
          return Response.json({
            id: "state-dir",
            name: ".sharedesk",
            mimeType: "application/vnd.google-apps.folder",
            parents: ["drive-root"],
            trashed: false,
          });
        }
        if (
          url.includes(
            "/drive/v3/files/drive-text?fields=id,name,mimeType,parents,trashed",
          )
        ) {
          return Response.json({
            id: "drive-text",
            name: "공용.txt",
            mimeType: "text/plain",
            parents: ["drive-root"],
            trashed: false,
          });
        }
        if (
          url.includes(
            "/drive/v3/files/drive-folder?fields=id,name,mimeType,parents,trashed",
          )
        ) {
          return Response.json({
            id: "drive-folder",
            name: "폴더",
            mimeType: "application/vnd.google-apps.folder",
            parents: ["drive-root"],
            trashed: false,
          });
        }
        if (
          url.includes("/upload/drive/v2/files/drive-text?uploadType=media") &&
          method === "PUT"
        ) {
          uploadCount++;
          assert.equal(headers.get("If-Match"), '"etag-1"');
          assert.equal(headers.get("Content-Type"), "text/plain");
          if (uploadCount > 1) return new Response(null, { status: 412 });
          uploadedText = await new Response(init.body as BodyInit).text();
          return Response.json({
            id: "drive-text",
            title: "공용.txt",
            mimeType: "text/plain",
            fileSize: String(Buffer.byteLength(uploadedText)),
            modifiedDate: "2026-08-13T00:00:00.000Z",
            etag: '"etag-2"',
          });
        }
        throw new Error(`예상하지 못한 Drive 요청: ${method} ${url}`);
      };

      try {
        const { DriveAdapter } = await import("@/lib/storage/drive");
        const drive = new DriveAdapter();
        const saved = await drive.replaceContent(
          "drive-text",
          '"etag-1"',
          "text/plain",
          stream("Drive에서 수정"),
        );
        assert.equal(uploadedText, "Drive에서 수정");
        assert.equal(saved.version, '"etag-2"');
        assert.ok(
          calls.some((call) =>
            call.url.startsWith(
              "https://www.googleapis.com/upload/drive/v2/files/drive-text",
            ),
          ),
        );
        await rejectsWithCode(
          drive.replaceContent(
            "drive-text",
            '"etag-1"',
            "text/plain",
            stream("오래된 Drive 저장"),
          ),
          "CONFLICT",
        );
        await rejectsWithCode(
          drive.replaceContent(
            "drive-folder",
            '"folder-etag"',
            "text/plain",
            stream("폴더 본문"),
          ),
          "BAD_ID",
        );
        await rejectsWithCode(
          drive.replaceContent(
            ROOT_ID,
            '"root-etag"',
            "text/plain",
            stream("루트 본문"),
          ),
          "BAD_ID",
        );
      } finally {
        globalThis.fetch = originalFetch;
        process.env.GOOGLE_CLIENT_ID = originalGoogle.clientId;
        process.env.GOOGLE_CLIENT_SECRET = originalGoogle.clientSecret;
        process.env.GOOGLE_REFRESH_TOKEN = originalGoogle.refreshToken;
        process.env.DRIVE_ROOT_FOLDER_ID = originalGoogle.driveRoot;
        process.env.DRIVE_STATE_FOLDER_ID = originalGoogle.stateFolder;
      }
    });

    await t.test("Drive TXT 이름 변경은 새 ETag를 반환하고 이름 충돌을 지킨다", async () => {
      const originalFetch = globalThis.fetch;
      const originalGoogle = {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
        driveRoot: process.env.DRIVE_ROOT_FOLDER_ID,
        stateFolder: process.env.DRIVE_STATE_FOLDER_ID,
      };
      process.env.GOOGLE_CLIENT_ID = "test-client";
      process.env.GOOGLE_CLIENT_SECRET = "test-secret";
      process.env.GOOGLE_REFRESH_TOKEN = "test-refresh";
      process.env.DRIVE_ROOT_FOLDER_ID = "drive-root";
      process.env.DRIVE_STATE_FOLDER_ID = "state-dir";
      const calls: Array<{ url: string; method: string; body: string }> = [];

      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        const method = init.method ?? "GET";
        calls.push({
          url,
          method,
          body: typeof init.body === "string" ? init.body : "",
        });
        if (url === "https://oauth2.googleapis.com/token") {
          return Response.json({ access_token: "test-token", expires_in: 3600 });
        }
        if (
          url.includes(
            "/drive/v3/files/state-dir?fields=id,name,mimeType,parents,trashed",
          )
        ) {
          return Response.json({
            id: "state-dir",
            name: ".sharedesk",
            mimeType: "application/vnd.google-apps.folder",
            parents: ["drive-root"],
            trashed: false,
          });
        }
        if (
          url.includes(
            "/drive/v3/files/drive-text?fields=id,parents,trashed",
          )
        ) {
          return Response.json({
            id: "drive-text",
            parents: ["drive-root"],
            trashed: false,
          });
        }
        if (url.includes("/drive/v3/files/drive-text?fields=id,parents")) {
          return Response.json({
            id: "drive-text",
            parents: ["drive-root"],
          });
        }
        if (url.includes("/drive/v3/files?") && method === "GET") {
          const query = new URL(url).searchParams.get("q") ?? "";
          return Response.json({
            files: query.includes("name='이미있음.txt'")
              ? [{ id: "duplicate-text" }]
              : [],
          });
        }
        if (
          url.includes(
            "/drive/v2/files/drive-text?fields=id%2Ctitle%2CmimeType%2CfileSize%2CmodifiedDate%2Cetag",
          ) &&
          method === "PATCH"
        ) {
          const expectedVersion = new Headers(init.headers).get("If-Match");
          if (expectedVersion === '"stale-etag"') {
            return new Response(null, { status: 412 });
          }
          assert.equal(expectedVersion, '"before-rename-etag"');
          assert.deepEqual(JSON.parse(String(init.body)), {
            title: "이름변경.txt",
          });
          return Response.json({
            id: "drive-text",
            title: "이름변경.txt",
            mimeType: "text/plain",
            fileSize: "4",
            modifiedDate: "2026-08-16T00:00:00.000Z",
            etag: '"renamed-etag"',
          });
        }
        throw new Error(`예상하지 못한 Drive 요청: ${method} ${url}`);
      };

      try {
        const { DriveAdapter } = await import("@/lib/storage/drive");
        const drive = new DriveAdapter();
        const renamed = await drive.rename(
          "drive-text",
          "이름변경.txt",
          '"before-rename-etag"',
        );
        assert.equal(renamed.name, "이름변경.txt");
        assert.equal(renamed.mimeType, "text/plain");
        assert.equal(renamed.version, '"renamed-etag"');

        await rejectsWithCode(
          drive.rename("drive-text", "늦은변경.txt", '"stale-etag"'),
          "CONFLICT",
        );

        await rejectsWithCode(
          drive.rename(
            "drive-text",
            "이미있음.txt",
            '"renamed-etag"',
          ),
          "CONFLICT",
        );
        assert.equal(
          calls.filter(
            (call) =>
              call.method === "PATCH" &&
              call.url.includes("/drive/v2/files/drive-text"),
          ).length,
          2,
        );
      } finally {
        globalThis.fetch = originalFetch;
        process.env.GOOGLE_CLIENT_ID = originalGoogle.clientId;
        process.env.GOOGLE_CLIENT_SECRET = originalGoogle.clientSecret;
        process.env.GOOGLE_REFRESH_TOKEN = originalGoogle.refreshToken;
        process.env.DRIVE_ROOT_FOLDER_ID = originalGoogle.driveRoot;
        process.env.DRIVE_STATE_FOLDER_ID = originalGoogle.stateFolder;
      }
    });
  } finally {
    process.env.STORAGE_DRIVER = previous.driver;
    process.env.LOCAL_STORAGE_ROOT = previous.root;
    process.env.SESSION_SECRET = previous.secret;
    process.env.ACCESS_KEYS = previous.keys;
    await rm(root, { recursive: true, force: true });
  }
});
