import assert from "node:assert/strict";
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
    assert.match(await streamText(fallback.stream), /로컬 저장소 모드/);
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
  let orphanListReads = 0;
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
      orphanListReads += 1;
      return Response.json({
        files:
          orphanListReads === 1
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
            : [],
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
      };
      assert.deepEqual(body.parents, ["state-folder"]);
      assert.match(body.mimeType ?? "", /^application\/vnd\.google-apps\./);
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
    assert.equal(deleted.includes("unrelated-state-file"), false);
    assert.equal(deleted.includes("recent-preview"), false);
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
      assert.equal(failed.mimeType, "text/plain; charset=utf-8");
      assert.match(await streamText(failed.stream), /다운로드 버튼/);
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
