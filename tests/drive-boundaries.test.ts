import assert from "node:assert/strict";
import test from "node:test";
import { runWithSpace } from "../src/lib/space-store";
import { DriveAdapter } from "../src/lib/storage/drive";
import { ROOT_ID, StorageError } from "../src/lib/storage/types";

const FOLDER_MIME = "application/vnd.google-apps.folder";

interface MockFile {
  id: string;
  name: string;
  parents: string[];
  mimeType: string;
  size: string;
  trashed: boolean;
  explicitlyTrashed: boolean;
}

test("Drive 파일 API는 현재 데스크 밖 스페이스와 내부 영역을 거부한다", async (t) => {
  const env = {
    GOOGLE_CLIENT_ID: "boundary-test-client",
    GOOGLE_CLIENT_SECRET: "boundary-test-secret",
    GOOGLE_REFRESH_TOKEN: "boundary-test-refresh",
    DRIVE_ROOT_FOLDER_ID: "base-root",
    DRIVE_STATE_FOLDER_ID: "base-state",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const files = new Map<string, MockFile>();
  const add = (id: string, name: string, parent: string, folder = false, trashed = false) => {
    files.set(id, {
      id, name, parents: [parent],
      mimeType: folder ? FOLDER_MIME : "text/plain",
      size: "7", trashed, explicitlyTrashed: trashed,
    });
  };
  add("base-root", "ShareDesk", "host-root", true);
  add("base-state", ".sharedesk", "base-root", true);
  add("base-users", "users.json", "base-state");
  add("base-file", "base.txt", "base-root");
  add("base-folder", "normal", "base-root", true);
  add("base-nested", "nested.txt", "base-folder");
  add("base-trash", "deleted.txt", "base-folder", false, true);
  add("spaces", ".spaces", "base-root", true);
  add("space-a", "alpha", "spaces", true);
  add("space-a-state", ".sharedesk", "space-a", true);
  add("space-a-users", "users.json", "space-a-state");
  add("space-a-folder", "normal", "space-a", true);
  add("space-a-file", "secret.txt", "space-a-folder");
  add("space-a-trash", "deleted.txt", "space-a-folder", false, true);
  add("space-b", "beta", "spaces", true);
  add("space-b-file", "other.txt", "space-b");
  add("nested-state", ".sharedesk", "base-folder", true);
  add("nested-users", "users.json", "nested-state");
  add("outside", "outside.txt", "host-root");

  const requests: Array<{ method: string; url: URL }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init.method ?? "GET";
    requests.push({ method, url });
    if (url.href === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "boundary-test-access", expires_in: 3600 });
    }
    assert.equal(url.origin, "https://www.googleapis.com");
    const match = url.pathname.match(/^\/drive\/(v[23])\/files(?:\/([^/]+))?$/);
    assert.ok(match, `Unexpected Drive request: ${method} ${url.pathname}`);
    const [, version, id] = match;
    const asV2 = (file: MockFile) => ({
      id: file.id, title: file.name, mimeType: file.mimeType,
      fileSize: file.size, etag: '"version-1"',
    });
    if (!id && method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      const parent = q.match(/'([^']+)' in parents/)?.[1];
      const name = q.match(/name='([^']+)'/)?.[1];
      const selected = [...files.values()].filter((file) =>
        (!parent || file.parents.includes(parent)) &&
        (!name || file.name === name) &&
        file.trashed === (q === "trashed=true"),
      );
      return Response.json(version === "v2"
        ? { items: selected.map(asV2) }
        : { files: selected });
    }
    const file = files.get(id);
    if (!file) return new Response(null, { status: 404 });
    if (method === "PATCH") {
      return Response.json(version === "v2" ? asV2(file) : file);
    }
    assert.equal(method, "GET", "Denied operation reached a Drive mutation");
    if (url.searchParams.get("alt") === "media") return new Response("content");
    const data = version === "v2" ? asV2(file) : file;
    const fields = url.searchParams.get("fields")?.split(",");
    // Honor field selection so a caller that forgets to request name cannot
    // accidentally pass the guard using richer mock data than Drive provides.
    return Response.json(fields
      ? Object.fromEntries(Object.entries(data).filter(([key]) => fields.includes(key)))
      : data);
  });

  const adapter = new DriveAdapter();
  const denied = (work: Promise<unknown>) => assert.rejects(work,
    (error: unknown) => error instanceof StorageError && error.code === "NOT_FOUND");

  await t.test("기본 데스크는 알려진 다른 스페이스 ID로 읽거나 쓸 수 없다", async () => {
    await runWithSpace(null, async () => {
      for (const id of ["spaces", "space-a", "space-a-folder", "space-a-file", "space-a-state", "space-a-users", "base-state", "base-users", "nested-state", "nested-users", "outside"]) {
        await denied(adapter.getEntry(id));
        await denied(adapter.list(id));
        await denied(adapter.download(id));
        await denied(adapter.remove(id));
        await denied(adapter.rename(id, "changed.txt", '"version-1"'));
        await denied(adapter.isWithin(id, ROOT_ID));
        await denied(adapter.isDirectChild(id, ROOT_ID));
        await denied(adapter.createFolder(id, "new-folder"));
        await denied(adapter.createUploadSession(id, "upload.txt", "text/plain", 7, "https://desk.example"));
        await denied(adapter.createPermission(id, "member@example.com", "reader"));
      }
    });
    assert.equal(requests.filter(({ method, url }) => method !== "GET" && url.hostname !== "oauth2.googleapis.com").length, 0);
    assert.equal(requests.filter(({ url }) => url.searchParams.get("alt") === "media").length, 0);
  });

  await t.test("이동은 출발지와 도착지의 내부 영역을 모두 거부한다", async () => {
    await runWithSpace(null, async () => {
      for (const id of ["spaces", "space-a", "space-a-state", "nested-state"]) {
        await denied(adapter.move("base-file", id, '"version-1"'));
        await denied(adapter.move(id, "base-folder", '"version-1"'));
      }
    });
    assert.equal(requests.some(({ method }) => method === "PATCH"), false);
  });

  await t.test("휴지통 목록·복원·완전삭제도 같은 스페이스 경계를 따른다", async () => {
    await runWithSpace(null, async () => {
      assert.deepEqual((await adapter.listTrash()).map((entry) => entry.id), ["base-trash"]);
      await denied(adapter.restore("space-a-trash"));
      await denied(adapter.purge("space-a-trash", '"version-1"'));
      const result = await adapter.emptyTrash([{ id: "space-a-trash", version: '"version-1"' }]);
      assert.deepEqual(result.fileIds, []);
    });
    assert.equal(requests.some(({ method }) => method === "PATCH" || method === "DELETE"), false);
  });

  await t.test("정상 파일과 자기 스페이스는 유지하고 기본·다른 스페이스는 격리한다", async () => {
    await runWithSpace(null, async () => {
      assert.deepEqual((await adapter.list(ROOT_ID)).map((entry) => entry.id), ["base-folder", "base-file"]);
      assert.equal(await adapter.isWithin("base-nested", "base-folder"), true);
      assert.equal(await adapter.isWithin("base-file", "base-folder"), false);
      assert.equal(await adapter.isDirectChild("base-nested", "base-folder"), true);
      const download = await adapter.download("base-nested");
      assert.equal(await new Response(download.stream).text(), "content");
    });
    await runWithSpace({ slug: "alpha", folderId: "space-a" }, async () => {
      assert.deepEqual((await adapter.list(ROOT_ID)).map((entry) => entry.id), ["space-a-folder"]);
      assert.equal((await adapter.getEntry("space-a-file")).name, "secret.txt");
      assert.equal(await adapter.isWithin("space-a-file", ROOT_ID), true);
      assert.deepEqual((await adapter.listTrash()).map((entry) => entry.id), ["space-a-trash"]);
      for (const id of ["base-file", "space-b-file", "space-a-state", "space-a-users"]) {
        await denied(adapter.getEntry(id));
        await denied(adapter.download(id));
      }
      // Legitimate edits stay available in the authorized space.
      await adapter.remove("space-a-file");
    });
    assert.equal(requests.filter(({ method }) => method === "PATCH").length, 1);
  });
});
