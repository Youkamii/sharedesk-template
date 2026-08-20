import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("간이 링크 파일은 숨겨지고 보관하거나 만료 시 삭제할 수 있다", async () => {
  const root = await mkdtemp(join(tmpdir(), "sharedesk-share-links-"));
  const previousDriver = process.env.STORAGE_DRIVER;
  const previousRoot = process.env.LOCAL_STORAGE_ROOT;
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;

  try {
    const [{ getAdapter }, storageTypes, shareLinks] = await Promise.all([
      import("../src/lib/storage"),
      import("../src/lib/storage/types"),
      import("../src/lib/share-links"),
    ]);
    const adapter = getAdapter();

    const expiring = await adapter.uploadTemporary(
      "delete-me.txt",
      "text/plain",
      new Blob(["temporary"]).stream(),
    );
    assert.match(expiring.name, /^\.sharedesk-quick-/);
    assert.deepEqual(await adapter.list(storageTypes.ROOT_ID), []);

    const expiringLink = await shareLinks.createShareLink(
      expiring.id,
      "delete-me.txt",
      "Tester",
      1,
      {
        createdByUserId: "user-1",
        quick: true,
        deleteOnExpire: true,
      },
    );
    const state = await adapter.readStateVersioned<{
      version: 2;
      links: Array<{ linkId: string; expiresAt: string }>;
      pendingDeletes: unknown[];
    }>("share-links.json");
    assert.ok(state.value);
    await adapter.compareAndSwapState(
      "share-links.json",
      {
        ...state.value!,
        links: state.value!.links.map((link) =>
          link.linkId === expiringLink.linkId
            ? { ...link, expiresAt: new Date(0).toISOString() }
            : link,
        ),
      },
      state.version,
    );

    const cleanup = await shareLinks.cleanupExpiredShareLinks();
    assert.deepEqual(cleanup, { expired: 1, deleted: 1, failed: 0 });
    assert.equal(await shareLinks.getShareLink(expiringLink.linkId), null);
    await assert.rejects(() => adapter.getEntry(expiring.id));

    const kept = await adapter.uploadTemporary(
      "keep-me.txt",
      "text/plain",
      new Blob(["kept"]).stream(),
    );
    const keptLink = await shareLinks.createShareLink(
      kept.id,
      "keep-me.txt",
      "Tester",
      1,
      {
        createdByUserId: "user-1",
        quick: true,
        deleteOnExpire: true,
      },
    );
    assert.ok(await shareLinks.keepQuickLinkFile(keptLink.linkId));
    const promoted = await adapter.promoteTemporary(kept.id, "keep-me.txt");
    const updated = await shareLinks.updateQuickLinkTarget(
      keptLink.linkId,
      promoted,
    );
    assert.equal(updated?.deleteOnExpire, false);
    assert.equal(updated?.quick, false);
    assert.equal(updated?.fileId, promoted.id);
    assert.equal((await adapter.list(storageTypes.ROOT_ID))[0]?.name, "keep-me.txt");

    const folder = await adapter.createFolder(storageTypes.ROOT_ID, "shared");
    const child = await adapter.createFolder(folder.id, "child");
    const outside = await adapter.createFolder(storageTypes.ROOT_ID, "outside");
    assert.equal(await adapter.isWithin(child.id, folder.id), true);
    assert.equal(await adapter.isWithin(outside.id, folder.id), false);
  } finally {
    if (previousDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = previousDriver;
    if (previousRoot === undefined) delete process.env.LOCAL_STORAGE_ROOT;
    else process.env.LOCAL_STORAGE_ROOT = previousRoot;
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});
