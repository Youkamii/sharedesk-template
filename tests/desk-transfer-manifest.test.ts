import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

// 받는 데스크가 실제로 읽을 응답인지 로컬 저장소로 왕복 확인한다.
// 환경변수를 세운 뒤에 동적 import해야 어댑터가 로컬 모드로 초기화된다.
async function withLocalDesk(
  run: (context: {
    adapter: Awaited<
      ReturnType<typeof import("../src/lib/storage").getAdapter>
    >;
    types: typeof import("../src/lib/storage/types");
    shareLinks: typeof import("../src/lib/share-links");
    route: typeof import("../src/app/api/share/[linkId]/route");
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "sharedesk-desk2desk-"));
  const previousDriver = process.env.STORAGE_DRIVER;
  const previousRoot = process.env.LOCAL_STORAGE_ROOT;
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  try {
    const [storage, types, shareLinks, route] = await Promise.all([
      import("../src/lib/storage"),
      import("../src/lib/storage/types"),
      import("../src/lib/share-links"),
      import("../src/app/api/share/[linkId]/route"),
    ]);
    await run({ adapter: storage.getAdapter(), types, shareLinks, route });
  } finally {
    process.env.STORAGE_DRIVER = previousDriver;
    process.env.LOCAL_STORAGE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
}

function manifestRequest(linkId: string, query = "") {
  return new NextRequest(
    `https://desk.example.com/api/share/${linkId}?format=json${query}`,
  );
}

test("파일 링크는 복사에 필요한 이름·크기·형식을 JSON으로 준다", async () => {
  await withLocalDesk(async ({ adapter, types, shareLinks, route }) => {
    const file = await adapter.upload(
      types.ROOT_ID,
      "note.txt",
      "text/plain",
      new Blob(["hello desk"]).stream(),
    );
    const link = await shareLinks.createShareLink(
      file.id,
      "note.txt",
      "Tester",
      1,
      { createdByUserId: "user-1" },
    );

    const response = await route.GET(manifestRequest(link.linkId), {
      params: Promise.resolve({ linkId: link.linkId }),
    });
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /application\/json/,
    );
    // 링크 응답은 캐시에 남으면 안 된다.
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);

    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.kind, "file");
    assert.equal(body.name, "note.txt");
    // "hello desk"는 10바이트다 — 받는 쪽이 이 값으로 용량을 예약한다.
    assert.equal(body.size, 10);
    assert.equal(typeof body.expiresAt, "string");
    assert.ok(!("entries" in body), "파일 링크에는 목록이 없어야 한다");
  });
});

test("폴더 링크는 바로 아래 항목 목록을 주고 하위 폴더는 다시 물어보게 한다", async () => {
  await withLocalDesk(async ({ adapter, types, shareLinks, route }) => {
    const folder = await adapter.createFolder(types.ROOT_ID, "묶음");
    const inner = await adapter.createFolder(folder.id, "안쪽");
    const first = await adapter.upload(
      folder.id,
      "a.txt",
      "text/plain",
      new Blob(["aaa"]).stream(),
    );
    await adapter.upload(
      inner.id,
      "deep.txt",
      "text/plain",
      new Blob(["deep"]).stream(),
    );
    const link = await shareLinks.createShareLink(
      folder.id,
      "묶음",
      "Tester",
      1,
      { kind: "folder", createdByUserId: "user-1" },
    );

    // 링크 루트 — 바로 아래 두 항목만 나온다.
    const rootResponse = await route.GET(manifestRequest(link.linkId), {
      params: Promise.resolve({ linkId: link.linkId }),
    });
    assert.equal(rootResponse.status, 200);
    const rootBody = (await rootResponse.json()) as {
      kind: string;
      entries: { id: string; name: string; isFolder: boolean; size: number | null }[];
    };
    assert.equal(rootBody.kind, "folder");
    assert.deepEqual(
      rootBody.entries.map((entry) => entry.name).sort(),
      ["a.txt", "안쪽"],
    );
    const innerEntry = rootBody.entries.find((entry) => entry.isFolder);
    const fileEntry = rootBody.entries.find((entry) => !entry.isFolder);
    assert.ok(innerEntry && fileEntry);
    assert.equal(fileEntry.size, 3);

    // 하위 폴더는 entryId로 다시 물어본다.
    const innerResponse = await route.GET(
      manifestRequest(link.linkId, `&entryId=${innerEntry.id}`),
      { params: Promise.resolve({ linkId: link.linkId }) },
    );
    assert.equal(innerResponse.status, 200);
    const innerBody = (await innerResponse.json()) as {
      kind: string;
      entries: { name: string }[];
    };
    assert.equal(innerBody.kind, "folder");
    assert.deepEqual(
      innerBody.entries.map((entry) => entry.name),
      ["deep.txt"],
    );

    // 폴더 안 파일 하나의 메타도 같은 방식으로 읽는다.
    const fileResponse = await route.GET(
      manifestRequest(link.linkId, `&entryId=${first.id}`),
      { params: Promise.resolve({ linkId: link.linkId }) },
    );
    const fileBody = (await fileResponse.json()) as Record<string, unknown>;
    assert.equal(fileBody.kind, "file");
    assert.equal(fileBody.name, "a.txt");
    assert.equal(fileBody.size, 3);
  });
});

test("링크 밖 항목과 만료·없는 링크는 목록을 주지 않는다", async () => {
  await withLocalDesk(async ({ adapter, types, shareLinks, route }) => {
    const shared = await adapter.createFolder(types.ROOT_ID, "공유함");
    const outside = await adapter.upload(
      types.ROOT_ID,
      "secret.txt",
      "text/plain",
      new Blob(["nope"]).stream(),
    );
    const link = await shareLinks.createShareLink(
      shared.id,
      "공유함",
      "Tester",
      1,
      { kind: "folder", createdByUserId: "user-1" },
    );

    // 링크가 가리키는 폴더 밖의 파일을 entryId로 끼워 넣어도 거부된다.
    const leaked = await route.GET(
      manifestRequest(link.linkId, `&entryId=${outside.id}`),
      { params: Promise.resolve({ linkId: link.linkId }) },
    );
    assert.equal(leaked.status, 404);

    // 존재하지 않는 링크
    const unknown = "0".repeat(48);
    const missing = await route.GET(manifestRequest(unknown), {
      params: Promise.resolve({ linkId: unknown }),
    });
    assert.equal(missing.status, 404);
  });
});

// 파일 링크가 저장소 내부 id를 새로 흘리면, local 저장소에서는 base64url을
// 풀어 폴더 경로까지 드러난다. 받는 쪽은 이 값을 쓰지 않는다.
test("목록 응답은 가리키는 항목 자신의 id를 싣지 않는다", async () => {
  await withLocalDesk(async ({ adapter, types, shareLinks, route }) => {
    const file = await adapter.upload(
      types.ROOT_ID,
      "note.txt",
      "text/plain",
      new Blob(["hello"]).stream(),
    );
    const link = await shareLinks.createShareLink(
      file.id,
      "note.txt",
      "Tester",
      1,
      { createdByUserId: "user-1" },
    );
    const response = await route.GET(manifestRequest(link.linkId), {
      params: Promise.resolve({ linkId: link.linkId }),
    });
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.kind, "file");
    assert.equal(body.name, "note.txt");
    assert.ok(!("id" in body), "파일 링크 목록에 id가 있으면 안 된다");

    // 폴더 링크의 하위 항목 id는 entryId로 지목하는 데 필요해 그대로 둔다.
    const folder = await adapter.createFolder(types.ROOT_ID, "묶음");
    await adapter.upload(
      folder.id,
      "a.txt",
      "text/plain",
      new Blob(["a"]).stream(),
    );
    const folderLink = await shareLinks.createShareLink(
      folder.id,
      "묶음",
      "Tester",
      1,
      { kind: "folder", createdByUserId: "user-1" },
    );
    const folderResponse = await route.GET(manifestRequest(folderLink.linkId), {
      params: Promise.resolve({ linkId: folderLink.linkId }),
    });
    const folderBody = (await folderResponse.json()) as {
      entries: { id?: string; name: string }[];
    };
    assert.ok(!("id" in folderBody), "폴더 링크 자신의 id도 싣지 않는다");
    assert.ok(folderBody.entries[0]?.id, "하위 항목 id는 있어야 한다");
  });
});

// 원격 이름을 그대로 믿으면, 경로 구분자가 든 이름이 받는 쪽에서 경로 키를
// 뭉개 엉뚱한 폴더에 저장된다.
test("경로 구분자나 제어문자가 든 원격 이름은 목록에서 걸러진다", async () => {
  const { readManifest } = await import("../src/lib/desk-transfer-source");
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        kind: "folder",
        name: "묶음",
        size: null,
        entries: [
          { id: "ok", name: "정상 파일-이름.txt", isFolder: false, size: 1 },
          { id: "slash", name: "a/b", isFolder: true, size: null },
          { id: "back", name: "a\b", isFolder: true, size: null },
          { id: "tab", name: "a\u0009b", isFolder: false, size: 1 },
          { id: "nul", name: "a\u0000b", isFolder: false, size: 1 },
          { id: "dots", name: "..", isFolder: true, size: null },
          { id: "blank", name: "   ", isFolder: false, size: 1 },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as typeof globalThis.fetch;
  try {
    const manifest = await readManifest("https://desk.example.com/api/share/x");
    assert.ok(manifest);
    // 공백과 하이픈이 든 평범한 이름은 그대로 살아야 한다.
    assert.deepEqual(
      manifest.entries?.map((entry) => entry.name),
      ["정상 파일-이름.txt"],
    );
  } finally {
    globalThis.fetch = original;
  }
});
