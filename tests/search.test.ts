import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DriveAdapter } from "@/lib/storage/drive";
import { LocalAdapter } from "@/lib/storage/local";
import {
  ROOT_ID,
  StorageError,
  type Entry,
  type StorageErrorCode,
} from "@/lib/storage/types";
import { searchStorage } from "@/lib/search";

Object.assign(globalThis, { AsyncLocalStorage });

const FOLDER_MIME = "application/vnd.google-apps.folder";

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: StorageErrorCode,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof StorageError);
    assert.equal(error.code, code);
    return true;
  });
}

function entry(
  id: string,
  name: string,
  isFolder = false,
  layoutKey = `test:${id}`,
): Entry {
  return {
    id,
    layoutKey,
    name,
    isFolder,
    size: isFolder ? null : 1,
    modifiedAt: "2026-08-14T00:00:00.000Z",
    mimeType: isFolder ? FOLDER_MIME : "text/plain",
    version: `v:${id}`,
  };
}

test("검색 helper는 로컬 트리의 폴더와 파일을 대소문자 구분 없이 찾는다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-search-local-"));
  const originalRoot = process.env.LOCAL_STORAGE_ROOT;
  process.env.LOCAL_STORAGE_ROOT = root;
  try {
    await mkdir(path.join(root, "Reports", "Nested"), { recursive: true });
    await mkdir(path.join(root, "Other"), { recursive: true });
    await mkdir(path.join(root, ".sharedesk"), { recursive: true });
    await writeFile(path.join(root, "Reports", "report-current.txt"), "now");
    await writeFile(
      path.join(root, "Reports", "Nested", "REPORT-archive.txt"),
      "old",
    );
    await writeFile(path.join(root, "Other", "report-outside.txt"), "other");
    await writeFile(path.join(root, ".sharedesk", "report-state.json"), "{}");
    await writeFile(path.join(root, ".hidden-report.txt"), "hidden");

    const adapter = new LocalAdapter();
    const rootEntries = await adapter.list(ROOT_ID);
    const reports = rootEntries.find((item) => item.name === "Reports");
    assert.ok(reports?.isFolder);
    const reportEntries = await adapter.list(reports.id);
    const nested = reportEntries.find((item) => item.name === "Nested");
    assert.ok(nested?.isFolder);

    const response = await searchStorage("  RePoRt  ", reports.id, adapter);
    assert.equal(response.query, "RePoRt");
    assert.equal(response.scopeFolderId, reports.id);
    assert.equal(response.truncated, false);
    assert.deepEqual(
      response.results.map((result) => result.entry.name).sort(),
      ["REPORT-archive.txt", "Reports", "report-current.txt"].sort(),
    );
    assert.ok(
      !response.results.some((result) =>
        result.entry.name.includes("outside"),
      ),
    );

    const scopeResult = response.results.find(
      (result) => result.entry.id === reports.id,
    );
    assert.deepEqual(scopeResult, {
      entry: reports,
      parentId: ROOT_ID,
      breadcrumbs: [{ id: ROOT_ID, name: "ShareDesk" }],
      path: "/Reports",
    });

    const nestedResult = response.results.find(
      (result) => result.entry.name === "REPORT-archive.txt",
    );
    assert.ok(nestedResult);
    assert.equal(nestedResult.parentId, nested.id);
    assert.deepEqual(nestedResult.breadcrumbs, [
      { id: ROOT_ID, name: "ShareDesk" },
      { id: reports.id, name: "Reports" },
      { id: nested.id, name: "Nested" },
    ]);
    assert.equal(nestedResult.path, "/Reports/Nested/REPORT-archive.txt");

    const hidden = await searchStorage("state", ROOT_ID, adapter);
    assert.deepEqual(hidden.results, []);

    const listed: string[] = [];
    await rejectsWithCode(
      searchStorage("anything", "outside-root-id", {
        async list(folderId) {
          listed.push(folderId);
          return adapter.list(folderId);
        },
      }),
      "NOT_FOUND",
    );
    assert.ok(!listed.includes("outside-root-id"));
  } finally {
    if (originalRoot === undefined) delete process.env.LOCAL_STORAGE_ROOT;
    else process.env.LOCAL_STORAGE_ROOT = originalRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("검색 helper는 결과 수와 탐색량을 제한하고 취소 신호를 따른다", async () => {
  const files = [
    entry("one", "match-one"),
    entry("two", "match-two"),
    entry("three", "match-three"),
  ];
  const adapter = {
    async list(folderId: string) {
      assert.equal(folderId, ROOT_ID);
      return files;
    },
  };

  const resultLimited = await searchStorage("match", ROOT_ID, adapter, {
    maxResults: 2,
  });
  assert.deepEqual(
    resultLimited.results.map((result) => result.entry.id),
    ["one", "two"],
  );
  assert.equal(resultLimited.truncated, true);

  const traversalLimited = await searchStorage("missing", ROOT_ID, adapter, {
    maxTraversal: 3,
  });
  assert.equal(traversalLimited.explored, 3);
  assert.equal(traversalLimited.truncated, true);

  const controller = new AbortController();
  const reason = new Error("stop search");
  let calls = 0;
  await assert.rejects(
    searchStorage(
      "match",
      ROOT_ID,
      {
        async list() {
          calls += 1;
          controller.abort(reason);
          return [];
        },
      },
      { signal: controller.signal },
    ),
    (error: unknown) => error === reason,
  );
  assert.equal(calls, 1);

  await rejectsWithCode(searchStorage("   ", ROOT_ID, adapter), "BAD_NAME");
  await rejectsWithCode(
    searchStorage("match", "one", adapter),
    "BAD_ID",
  );
});

test("범위 탐색은 검색 예산을 쓰지 않고 큰 목록 뒤의 폴더를 찾는다", async () => {
  const scopeId = "large-scope";
  const precedingEntries = Array.from({ length: 5_001 }, (_, index) =>
    entry(`file-${index}`, `ordinary-${index}.txt`),
  );
  const target = entry(scopeId, "Target", true);
  const match = entry("inside-match", "needle.txt");
  const listed: string[] = [];

  const response = await searchStorage(
    "needle",
    scopeId,
    {
      async list(folderId: string) {
        listed.push(folderId);
        if (folderId === ROOT_ID) return [...precedingEntries, target];
        if (folderId === scopeId) return [match];
        return [];
      },
    },
    { maxTraversal: 2 },
  );

  assert.deepEqual(listed, [ROOT_ID, scopeId]);
  assert.equal(response.explored, 2);
  assert.equal(response.truncated, false);
  assert.deepEqual(response.results, [
    {
      entry: match,
      parentId: scopeId,
      breadcrumbs: [
        { id: ROOT_ID, name: "ShareDesk" },
        { id: scopeId, name: "Target" },
      ],
      path: "/Target/needle.txt",
    },
  ]);
});

test("같은 검색 순회가 DriveAdapter.list 결과에서도 경로를 보존한다", async () => {
  const original = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
    root: process.env.DRIVE_ROOT_FOLDER_ID,
    state: process.env.DRIVE_STATE_FOLDER_ID,
    fetch: globalThis.fetch,
  };
  process.env.GOOGLE_CLIENT_ID = "search-client";
  process.env.GOOGLE_CLIENT_SECRET = "search-secret";
  process.env.GOOGLE_REFRESH_TOKEN = "search-refresh";
  process.env.DRIVE_ROOT_FOLDER_ID = "drive-root";
  process.env.DRIVE_STATE_FOLDER_ID = "state-dir";

  const listedParents: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.href === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "search-token", expires_in: 3600 });
    }
    if (
      url.pathname === "/drive/v3/files/state-dir" &&
      url.searchParams.get("fields") === "id,name,mimeType,parents,trashed"
    ) {
      return Response.json({
        id: "state-dir",
        name: ".sharedesk",
        mimeType: FOLDER_MIME,
        parents: ["drive-root"],
        trashed: false,
      });
    }
    if (url.pathname.startsWith("/drive/v3/files/")) {
      const id = url.pathname.slice("/drive/v3/files/".length);
      const parents: Record<string, string> = {
        docs: "drive-root",
        archive: "docs",
      };
      return Response.json({ id, parents: [parents[id]], trashed: false });
    }
    if (url.pathname === "/drive/v2/files") {
      const query = url.searchParams.get("q") ?? "";
      const parent = /^'([^']+)' in parents/.exec(query)?.[1];
      assert.ok(parent);
      listedParents.push(parent);
      const items: Record<string, unknown[]> = {
        "drive-root": [
          {
            id: "docs",
            title: "Documents",
            mimeType: FOLDER_MIME,
            modifiedDate: "2026-08-14T00:00:00.000Z",
            etag: "docs-etag",
          },
          {
            id: "hidden",
            title: ".hidden-report",
            mimeType: FOLDER_MIME,
            modifiedDate: "2026-08-14T00:00:00.000Z",
            etag: "hidden-etag",
          },
        ],
        docs: [
          {
            id: "current",
            title: "Quarterly REPORT.pdf",
            mimeType: "application/pdf",
            fileSize: "12",
            modifiedDate: "2026-08-14T00:00:00.000Z",
            etag: "current-etag",
          },
          {
            id: "archive",
            title: "Archive",
            mimeType: FOLDER_MIME,
            modifiedDate: "2026-08-14T00:00:00.000Z",
            etag: "archive-etag",
          },
        ],
        archive: [
          {
            id: "old",
            title: "report-old.txt",
            mimeType: "text/plain",
            fileSize: "3",
            modifiedDate: "2026-08-14T00:00:00.000Z",
            etag: "old-etag",
          },
        ],
      };
      return Response.json({ items: items[parent] ?? [] });
    }
    return new Response("unexpected Drive request", { status: 500 });
  };

  try {
    const response = await searchStorage(
      "report",
      ROOT_ID,
      new DriveAdapter(),
    );
    assert.deepEqual(
      response.results.map((result) => result.entry.id),
      ["current", "old"],
    );
    assert.equal(response.results[0].parentId, "docs");
    assert.equal(
      response.results[0].path,
      "/Documents/Quarterly REPORT.pdf",
    );
    assert.deepEqual(response.results[1].breadcrumbs, [
      { id: ROOT_ID, name: "ShareDesk" },
      { id: "docs", name: "Documents" },
      { id: "archive", name: "Archive" },
    ]);
    assert.deepEqual(listedParents, ["drive-root", "docs", "archive"]);
    assert.ok(!listedParents.includes("hidden"));
  } finally {
    globalThis.fetch = original.fetch;
    for (const [name, value] of [
      ["GOOGLE_CLIENT_ID", original.clientId],
      ["GOOGLE_CLIENT_SECRET", original.clientSecret],
      ["GOOGLE_REFRESH_TOKEN", original.refreshToken],
      ["DRIVE_ROOT_FOLDER_ID", original.root],
      ["DRIVE_STATE_FOLDER_ID", original.state],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("검색 Route Handler는 세션과 빈 검색어를 검사한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-search-api-"));
  const original = {
    storageDriver: process.env.STORAGE_DRIVER,
    localRoot: process.env.LOCAL_STORAGE_ROOT,
    accessKeys: process.env.ACCESS_KEYS,
    sessionSecret: process.env.SESSION_SECRET,
  };
  const accessKey = "search-route-access-key";
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  process.env.ACCESS_KEYS = accessKey;
  process.env.SESSION_SECRET = "search-route-session-secret-at-least-32-chars";
  await writeFile(path.join(root, "API-REPORT.txt"), "route");

  try {
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
    const route = await import("@/app/api/drive/search/route");
    const token = await createKeySession(
      createHash("sha256").update(accessKey).digest("hex"),
    );

    async function call(url: string, authenticated = true): Promise<Response> {
      const headers = new Headers();
      if (authenticated) {
        headers.set("Cookie", `${COOKIE_NAME}=${token}`);
      }
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

    const unauthorized = await call(
      "http://localhost/api/drive/search?query=report",
      false,
    );
    assert.equal(unauthorized.status, 401);

    const empty = await call("http://localhost/api/drive/search?query=%20%20");
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).code, "BAD_NAME");

    const found = await call(
      "http://localhost/api/drive/search?query=report&folderId=root",
    );
    assert.equal(found.status, 200);
    const body = (await found.json()) as {
      query: string;
      scopeFolderId: string;
      results: Array<{ entry: Entry; parentId: string; path: string }>;
    };
    assert.equal(body.query, "report");
    assert.equal(body.scopeFolderId, ROOT_ID);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].entry.name, "API-REPORT.txt");
    assert.equal(body.results[0].parentId, ROOT_ID);
    assert.equal(body.results[0].path, "/API-REPORT.txt");
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
