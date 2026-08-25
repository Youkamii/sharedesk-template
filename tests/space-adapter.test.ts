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

test("스페이스 루트 생성은 기본 문맥에서만 되고 숨김 컨테이너 아래에 만든다", async () => {
  await withLocal(async ({ storage, types, space }) => {
    const adapter = storage.getAdapter();
    const rel = await adapter.createSpaceRoot("sea");
    assert.equal(rel, ".spaces/sea");
    // 같은 슬러그를 다시 만들어도 같은 곳을 준다.
    assert.equal(await adapter.createSpaceRoot("sea"), ".spaces/sea");
    // 만든 스페이스가 실제로 격리된 루트로 동작한다.
    await space.runWithSpace({ slug: "sea", folderId: rel }, async () => {
      await adapter.upload(
        types.ROOT_ID,
        "hello.txt",
        "text/plain",
        new Blob(["hi"]).stream(),
      );
      const listed = await adapter.list(types.ROOT_ID);
      assert.deepEqual(listed.map((e) => e.name), ["hello.txt"]);
    });
    // 기본 데스크 목록에는 스페이스 컨테이너가 안 보인다.
    const baseListed = await adapter.list(types.ROOT_ID);
    assert.deepEqual(baseListed.map((e) => e.name), []);
    // 스페이스 문맥에서 스페이스를 또 만들 수는 없다.
    await space.runWithSpace({ slug: "sea", folderId: rel }, async () => {
      await assert.rejects(
        adapter.createSpaceRoot("nested"),
        /기본 데스크에서만/,
      );
    });
    // 경로 조작 시도는 거부된다.
    await assert.rejects(adapter.createSpaceRoot("../evil"), /올바르지 않습니다/);
    await assert.rejects(adapter.createSpaceRoot("UPPER"), /올바르지 않습니다/);
  });
});

// 적대 리뷰(Fable) 발견: 기본 데스크 사용자가 base64url(".spaces/sea/...")를
// id로 넘겨 남의 스페이스 파일을 읽는 격리 우회. idToRel이 .sharedesk만 막고
// .spaces를 안 막았다.
test("기본 데스크에서 .spaces 컨테이너와 스페이스 파일에 파일 API로 닿을 수 없다", async () => {
  await withLocal(async ({ storage, types, space }) => {
    const adapter = storage.getAdapter();
    // sea 스페이스에 비밀 파일을 하나 만든다.
    const rel = await adapter.createSpaceRoot("sea");
    await space.runWithSpace({ slug: "sea", folderId: rel }, () =>
      adapter.upload(
        types.ROOT_ID,
        "secret.txt",
        "text/plain",
        new Blob(["top secret"]).stream(),
      ),
    );

    // 기본 데스크에서 그 파일 id를 손으로 계산한다.
    const b64 = (path: string) => Buffer.from(path, "utf8").toString("base64url");
    const spacesId = b64(".spaces");
    const spaceRootId = b64(".spaces/sea");
    const secretId = b64(".spaces/sea/secret.txt");

    // 컨테이너 목록·다운로드·삭제가 모두 막혀야 한다.
    for (const id of [spacesId, spaceRootId, secretId]) {
      await assert.rejects(adapter.list(id), /찾을 수 없습니다|없습니다/);
      await assert.rejects(adapter.download(id), /찾을 수 없습니다|없습니다/);
      await assert.rejects(adapter.getEntry(id), /찾을 수 없습니다|없습니다/);
    }
    // 컨테이너 안에 업로드도 막혀야 한다.
    await assert.rejects(
      adapter.upload(spaceRootId, "x.txt", "text/plain", new Blob(["x"]).stream()),
      /찾을 수 없습니다|없습니다/,
    );
    // 기본 데스크 목록에는 .spaces가 아예 안 보인다.
    const baseListed = await adapter.list(types.ROOT_ID);
    assert.deepEqual(baseListed.map((e) => e.name), []);
  });
});

// 발견 4: 기본 데스크 용량 집계가 .spaces 하위를 합산하면 안 된다.
test("기본 데스크 용량 집계는 스페이스가 쓴 용량을 포함하지 않는다", async () => {
  await withLocal(async ({ storage, types, space }) => {
    const adapter = storage.getAdapter();
    const rel = await adapter.createSpaceRoot("sea");
    // sea 스페이스에 큰 파일.
    await space.runWithSpace({ slug: "sea", folderId: rel }, () =>
      adapter.upload(
        types.ROOT_ID,
        "big.bin",
        "application/octet-stream",
        new Blob(["x".repeat(10000)]).stream(),
      ),
    );
    // 기본 데스크 용량은 0이어야 한다 — 스페이스 파일은 안 센다.
    const usage = await adapter.getStorageUsage();
    assert.equal(usage.deskUsedBytes, 0);
    // 스페이스 문맥에서는 자기 파일이 잡힌다.
    const spaceUsage = await space.runWithSpace(
      { slug: "sea", folderId: rel },
      () => adapter.getStorageUsage(),
    );
    assert.equal(spaceUsage.deskUsedBytes, 10000);
  });
});
