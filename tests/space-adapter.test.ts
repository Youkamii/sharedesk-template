import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 멀티 데스크의 핵심: 스페이스 문맥이 있으면 어댑터의 모든 경로·상태가 그
// 스페이스 하위 폴더에 갇혀야 한다. 문맥 없이는 기존 단일 데스크 그대로.
async function withLocal(
  run: (mods: {
    storage: typeof import("../src/lib/storage");
    types: typeof import("../src/lib/storage/types");
    space: typeof import("../src/lib/space-store");
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "sharedesk-space-adapter-"));
  const prevDriver = process.env.STORAGE_DRIVER;
  const prevRoot = process.env.LOCAL_STORAGE_ROOT;
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  try {
    await run({
      storage: await import("../src/lib/storage"),
      types: await import("../src/lib/storage/types"),
      space: await import("../src/lib/space-store"),
    });
  } finally {
    process.env.STORAGE_DRIVER = prevDriver;
    process.env.LOCAL_STORAGE_ROOT = prevRoot;
    await rm(root, { recursive: true, force: true });
  }
}

test("스페이스 문맥이 다르면 파일과 상태가 서로 보이지 않는다", async () => {
  await withLocal(async ({ storage, types, space }) => {
    const adapter = storage.getAdapter();

    // 기본(레거시) 데스크에 파일 하나.
    await adapter.upload(
      types.ROOT_ID,
      "base.txt",
      "text/plain",
      new Blob(["base"]).stream(),
    );

    // A 스페이스 — 루트가 하위 폴더 "a".
    await space.runWithSpace({ slug: "a", folderId: ".spaces/a" }, async () => {
      const listed = await adapter.list(types.ROOT_ID);
      // A는 기본 데스크의 파일을 보면 안 된다.
      assert.deepEqual(listed.map((e) => e.name), []);
      await adapter.upload(
        types.ROOT_ID,
        "in-a.txt",
        "text/plain",
        new Blob(["aaa"]).stream(),
      );
    });

    // B 스페이스 — A의 파일도 기본 파일도 안 보인다.
    await space.runWithSpace({ slug: "b", folderId: ".spaces/b" }, async () => {
      const listed = await adapter.list(types.ROOT_ID);
      assert.deepEqual(listed.map((e) => e.name), []);
    });

    // 기본 데스크는 여전히 자기 파일만 본다 — A의 파일은 안 보인다.
    const baseListed = await adapter.list(types.ROOT_ID);
    assert.deepEqual(baseListed.map((e) => e.name), ["base.txt"]);

    // A로 다시 들어가면 A의 파일이 그대로 있다.
    await space.runWithSpace({ slug: "a", folderId: ".spaces/a" }, async () => {
      const listed = await adapter.list(types.ROOT_ID);
      assert.deepEqual(listed.map((e) => e.name), ["in-a.txt"]);
    });
  });
});

test("상태 파일도 스페이스별로 갈라진다", async () => {
  await withLocal(async ({ storage, space }) => {
    const adapter = storage.getAdapter();

    await adapter.writeState("users.json", { where: "base" });
    await space.runWithSpace({ slug: "a", folderId: ".spaces/a" }, async () => {
      // A는 기본 데스크의 상태를 못 본다.
      const read = await adapter.readStateVersioned<{ where: string }>(
        "users.json",
      );
      assert.equal(read.value, null);
      await adapter.writeState("users.json", { where: "space-a" });
    });

    // 기본 데스크 상태는 그대로.
    const baseState = await adapter.readStateVersioned<{ where: string }>(
      "users.json",
    );
    assert.deepEqual(baseState.value, { where: "base" });

    // A의 상태는 A에서만.
    await space.runWithSpace({ slug: "a", folderId: ".spaces/a" }, async () => {
      const read = await adapter.readStateVersioned<{ where: string }>(
        "users.json",
      );
      assert.deepEqual(read.value, { where: "space-a" });
    });
  });
});

test("스페이스 루트가 저장소 밖을 가리키면 거부한다", async () => {
  await withLocal(async ({ storage, types, space }) => {
    const adapter = storage.getAdapter();
    await space.runWithSpace({ slug: "evil", folderId: "../escape" }, async () => {
      await assert.rejects(
        adapter.list(types.ROOT_ID),
        /저장소 밖|스페이스 루트/,
      );
    });
  });
});
