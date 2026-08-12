import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ROOT_ID,
  StorageError,
  type Entry,
  type StorageErrorCode,
} from "@/lib/storage/types";

type StoredLayoutState = {
  version: 2;
  folderKey: string;
  rev: number;
  items: Record<
    string,
    {
      x: number;
      y: number;
      version: number;
      updatedAt: string;
      updatedBy: string;
    }
  >;
};

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

test("데스크톱 레이아웃 소속 검증과 동시성", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-layout-"));
  const originalDriver = process.env.STORAGE_DRIVER;
  const originalRoot = process.env.LOCAL_STORAGE_ROOT;
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;

  const { getAdapter } = await import("@/lib/storage");
  const {
    getFolderListingWithLayout,
    getLayoutSnapshot,
    getLayoutSnapshotForEntries: getLayoutSnapshotForVerifiedEntries,
    updateLayout,
  } = await import("@/lib/desktop-layout");
  const adapter = getAdapter();

  async function getLayoutSnapshotForEntries(
    folderId: string,
    entries: Entry[],
  ) {
    const folder = await adapter.getEntry(folderId);
    return getLayoutSnapshotForVerifiedEntries(
      folderId,
      entries,
      folder.layoutKey,
    );
  }

  async function makeFolder(
    label: string,
    fileNames: string[],
  ): Promise<{ folder: Entry; entries: Entry[] }> {
    const name = `${label}-${randomUUID()}`;
    const folder = await adapter.createFolder(ROOT_ID, name);
    await Promise.all(
      fileNames.map((fileName) =>
        writeFile(path.join(root, name, fileName), fileName, "utf8"),
      ),
    );
    return { folder, entries: await adapter.list(folder.id) };
  }

  try {
    await t.test("내부 상태 폴더는 실제 경로 별칭으로도 열 수 없다", async () => {
      await adapter.writeState("boundary-secret.json", { private: true });
      const aliasName = `state-alias-${randomUUID()}`;
      await symlink(
        path.join(root, ".sharedesk"),
        path.join(root, aliasName),
        process.platform === "win32" ? "junction" : "dir",
      );
      const aliasId = Buffer.from(aliasName, "utf8").toString("base64url");
      const secretId = Buffer.from(
        `${aliasName}/boundary-secret.json`,
        "utf8",
      ).toString("base64url");

      await rejectsWithCode(adapter.list(aliasId), "NOT_FOUND");
      await rejectsWithCode(adapter.download(secretId), "NOT_FOUND");
      await rejectsWithCode(
        adapter.createFolder(aliasId, "should-not-exist"),
        "NOT_FOUND",
      );
    });

    await t.test("초기 배치는 한 번만 저장되고 안정된 좌표를 돌려준다", async () => {
      const { folder, entries } = await makeFolder("stable", ["a.txt", "b.txt"]);
      const first = await getLayoutSnapshotForEntries(folder.id, entries);
      const second = await getLayoutSnapshotForEntries(folder.id, entries);

      assert.equal(first.folderIdentity, folder.layoutKey);
      assert.equal(first.revision, 1);
      assert.deepEqual(second, first);
      assert.equal(first.positions[entries[0].layoutKey].version, 1);
      assert.equal(first.positions[entries[1].layoutKey].version, 1);
      assert.notDeepEqual(
        first.positions[entries[0].layoutKey],
        first.positions[entries[1].layoutKey],
      );
    });

    await t.test("현재 폴더의 직속 항목만 한 번의 목록 조회로 변경한다", async () => {
      const current = await makeFolder("membership-current", ["inside.txt"]);
      const other = await makeFolder("membership-other", ["outside.txt"]);
      const initial = await getLayoutSnapshotForEntries(
        current.folder.id,
        current.entries,
      );
      const inside = current.entries[0];
      const outside = other.entries[0];
      const originalList = adapter.list.bind(adapter);
      let listCalls = 0;
      adapter.list = async (folderId) => {
        listCalls++;
        return originalList(folderId);
      };

      try {
        const saved = await updateLayout(
          current.folder.id,
          [
            {
              entryId: inside.id,
              expectedVersion: initial.positions[inside.layoutKey].version,
              x: 310,
              y: 220,
            },
          ],
          "member-a",
          initial.folderIdentity,
        );
        assert.equal(listCalls, 1);
        assert.deepEqual(saved.positions[inside.layoutKey], {
          x: 310,
          y: 220,
          version: 2,
        });

        for (const entryId of [
          outside.id,
          Buffer.from("missing.txt", "utf8").toString("base64url"),
          ROOT_ID,
          Buffer.from(".sharedesk/users.json", "utf8").toString("base64url"),
        ]) {
          const callsBeforeInvalidUpdate: number = listCalls;
          await rejectsWithCode(
            updateLayout(
              current.folder.id,
              [{ entryId, expectedVersion: 0, x: 1, y: 1 }],
              "member-a",
              initial.folderIdentity,
            ),
            "NOT_FOUND",
          );
          assert.equal(listCalls, callsBeforeInvalidUpdate + 1);
        }
      } finally {
        adapter.list = originalList;
      }

      const after = await getLayoutSnapshot(current.folder.id);
      assert.equal(after.revision, 2);
      assert.deepEqual(after.positions[inside.layoutKey], {
        x: 310,
        y: 220,
        version: 2,
      });
      assert.equal(after.positions[outside.layoutKey], undefined);
    });

    await t.test("큐를 기다리는 동안 다른 폴더로 이동한 항목은 저장하지 않는다", async () => {
      const current = await makeFolder("membership-queued", ["a.txt", "b.txt"]);
      const target = await makeFolder("membership-queued-target", []);
      const [leadingEntry, movingEntry] = current.entries;
      const initial = await getLayoutSnapshotForEntries(
        current.folder.id,
        current.entries,
      );
      assert.ok(movingEntry.version);

      const originalList = adapter.list.bind(adapter);
      const originalCompareAndSwap = adapter.compareAndSwapState.bind(adapter);
      let queuedRequestStarted = false;
      let itemMoved = false;
      let releaseLeadingWrite!: () => void;
      let leadingWriteReached!: () => void;
      const leadingWriteBlocked = new Promise<void>((resolve) => {
        leadingWriteReached = resolve;
      });
      const leadingWriteRelease = new Promise<void>((resolve) => {
        releaseLeadingWrite = resolve;
      });
      let blocked = false;

      adapter.list = async (folderId) => {
        if (
          folderId === current.folder.id &&
          queuedRequestStarted &&
          !itemMoved
        ) {
          return current.entries;
        }
        return originalList(folderId);
      };
      adapter.compareAndSwapState = async (name, value, expectedVersion) => {
        if (!blocked) {
          blocked = true;
          leadingWriteReached();
          await leadingWriteRelease;
        }
        return originalCompareAndSwap(name, value, expectedVersion);
      };

      try {
        const leading = updateLayout(
          current.folder.id,
          [
            {
              entryId: leadingEntry.id,
              expectedVersion: initial.positions[leadingEntry.layoutKey].version,
              x: 320,
              y: 330,
            },
          ],
          "member-leading",
          initial.folderIdentity,
        );
        await leadingWriteBlocked;

        queuedRequestStarted = true;
        const queued = updateLayout(
          current.folder.id,
          [
            {
              entryId: movingEntry.id,
              expectedVersion: initial.positions[movingEntry.layoutKey].version,
              x: 420,
              y: 430,
            },
          ],
          "member-queued",
          initial.folderIdentity,
        );
        await Promise.resolve();
        itemMoved = true;
        await adapter.move(
          movingEntry.id,
          target.folder.id,
          movingEntry.version,
        );
        releaseLeadingWrite();

        await leading;
        await rejectsWithCode(queued, "NOT_FOUND");
      } finally {
        releaseLeadingWrite();
        adapter.list = originalList;
        adapter.compareAndSwapState = originalCompareAndSwap;
      }

      const stored = await getLayoutSnapshot(current.folder.id);
      assert.equal(stored.revision, 2);
      assert.equal(stored.positions[movingEntry.layoutKey].version, 1);
    });

    await t.test("CAS 재시도 전에 다른 폴더로 이동한 항목은 다시 검증한다", async () => {
      const current = await makeFolder("membership-retry", ["item.txt"]);
      const target = await makeFolder("membership-retry-target", []);
      const entry = current.entries[0];
      const initial = await getLayoutSnapshotForEntries(
        current.folder.id,
        current.entries,
      );
      assert.ok(entry.version);

      const originalCompareAndSwap = adapter.compareAndSwapState.bind(adapter);
      let injected = false;
      adapter.compareAndSwapState = async (name, value, expectedVersion) => {
        if (!injected) {
          injected = true;
          await adapter.move(entry.id, target.folder.id, entry.version!);
          throw new StorageError("CONFLICT", "forced retry after move");
        }
        return originalCompareAndSwap(name, value, expectedVersion);
      };

      try {
        await rejectsWithCode(
          updateLayout(
            current.folder.id,
            [
              {
                entryId: entry.id,
                expectedVersion: initial.positions[entry.layoutKey].version,
                x: 520,
                y: 530,
              },
            ],
            "member-retry",
            initial.folderIdentity,
          ),
          "NOT_FOUND",
        );
      } finally {
        adapter.compareAndSwapState = originalCompareAndSwap;
      }

      assert.equal((await getLayoutSnapshot(current.folder.id)).revision, 1);
    });

    await t.test("큐 대기 중 같은 local 경로에 새 폴더가 생기면 옛 상태에 쓰지 않는다", async () => {
      const current = await makeFolder("folder-replaced-queued", ["a.txt", "b.txt"]);
      const [leadingEntry, replacedEntry] = current.entries;
      const initial = await getLayoutSnapshotForEntries(
        current.folder.id,
        current.entries,
      );

      const originalGetEntry = adapter.getEntry.bind(adapter);
      const originalCompareAndSwap = adapter.compareAndSwapState.bind(adapter);
      let releaseLeadingWrite!: () => void;
      let leadingWriteReached!: () => void;
      const leadingWriteBlocked = new Promise<void>((resolve) => {
        leadingWriteReached = resolve;
      });
      const leadingWriteRelease = new Promise<void>((resolve) => {
        releaseLeadingWrite = resolve;
      });
      let blocked = false;
      let watchQueuedFolderLookup = false;
      let queuedFolderCaptured!: () => void;
      const queuedFolderCapture = new Promise<void>((resolve) => {
        queuedFolderCaptured = resolve;
      });

      adapter.getEntry = async (id) => {
        const result = await originalGetEntry(id);
        if (watchQueuedFolderLookup && id === current.folder.id) {
          watchQueuedFolderLookup = false;
          queuedFolderCaptured();
        }
        return result;
      };
      adapter.compareAndSwapState = async (name, value, expectedVersion) => {
        if (!blocked) {
          blocked = true;
          leadingWriteReached();
          await leadingWriteRelease;
        }
        return originalCompareAndSwap(name, value, expectedVersion);
      };

      try {
        const leading = updateLayout(
          current.folder.id,
          [
            {
              entryId: leadingEntry.id,
              expectedVersion: initial.positions[leadingEntry.layoutKey].version,
              x: 540,
              y: 550,
            },
          ],
          "member-leading-folder",
          initial.folderIdentity,
        );
        await leadingWriteBlocked;

        watchQueuedFolderLookup = true;
        const queued = updateLayout(
          current.folder.id,
          [
            {
              entryId: replacedEntry.id,
              expectedVersion: 0,
              x: 640,
              y: 650,
            },
          ],
          "member-replaced-folder",
          initial.folderIdentity,
        );
        await queuedFolderCapture;

        await adapter.remove(current.folder.id);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const replacement = await adapter.createFolder(ROOT_ID, current.folder.name);
        await writeFile(
          path.join(root, replacement.name, replacedEntry.name),
          replacedEntry.name,
          "utf8",
        );
        assert.equal(replacement.id, current.folder.id);
        assert.notEqual(replacement.layoutKey, current.folder.layoutKey);

        releaseLeadingWrite();
        await leading;
        await rejectsWithCode(queued, "CONFLICT");
      } finally {
        releaseLeadingWrite();
        adapter.getEntry = originalGetEntry;
        adapter.compareAndSwapState = originalCompareAndSwap;
      }

      const oldState = await getLayoutSnapshotForEntries(
        current.folder.id,
        await adapter.list(current.folder.id),
      );
      assert.equal(oldState.revision, 1);
    });

    await t.test("같은 경로와 좌표 버전을 재사용해도 옛 창의 폴더 식별값은 거부한다", async () => {
      const current = await makeFolder("stale-window", ["item.txt"]);
      const initial = await getLayoutSnapshotForEntries(
        current.folder.id,
        current.entries,
      );

      await adapter.remove(current.folder.id);
      const replacement = await adapter.createFolder(
        ROOT_ID,
        current.folder.name,
      );
      await writeFile(
        path.join(root, replacement.name, "item.txt"),
        "item.txt",
        "utf8",
      );
      const replacementEntries = await adapter.list(replacement.id);
      const replacementEntry = replacementEntries[0];
      const replacementSnapshot = await getLayoutSnapshotForEntries(
        replacement.id,
        replacementEntries,
      );

      assert.equal(replacement.id, current.folder.id);
      assert.equal(replacementEntry.id, current.entries[0].id);
      assert.equal(
        replacementSnapshot.positions[replacementEntry.layoutKey].version,
        initial.positions[current.entries[0].layoutKey].version,
      );
      assert.notEqual(replacementSnapshot.folderIdentity, initial.folderIdentity);

      await rejectsWithCode(
        updateLayout(
          replacement.id,
          [
            {
              entryId: replacementEntry.id,
              expectedVersion:
                replacementSnapshot.positions[replacementEntry.layoutKey].version,
              x: 777,
              y: 778,
            },
          ],
          "member-stale-window",
          initial.folderIdentity,
        ),
        "CONFLICT",
      );

      assert.deepEqual(
        await getLayoutSnapshot(replacement.id),
        replacementSnapshot,
      );
    });

    await t.test("목록 확인 직후 폴더가 교체되어도 쓰기 직전 다시 거부한다", async () => {
      const current = await makeFolder("replaced-after-list", ["item.txt"]);
      const entry = current.entries[0];
      const initial = await getLayoutSnapshotForEntries(
        current.folder.id,
        current.entries,
      );
      const originalList = adapter.list.bind(adapter);
      let replaced = false;

      adapter.list = async (folderId) => {
        const listed = await originalList(folderId);
        if (folderId === current.folder.id && !replaced) {
          replaced = true;
          await adapter.remove(current.folder.id);
          await adapter.createFolder(ROOT_ID, current.folder.name);
          await writeFile(
            path.join(root, current.folder.name, entry.name),
            entry.name,
            "utf8",
          );
        }
        return listed;
      };

      try {
        await rejectsWithCode(
          updateLayout(
            current.folder.id,
            [
              {
                entryId: entry.id,
                expectedVersion: initial.positions[entry.layoutKey].version,
                x: 779,
                y: 780,
              },
            ],
            "member-replaced-after-list",
            initial.folderIdentity,
          ),
          "CONFLICT",
        );
      } finally {
        adapter.list = originalList;
      }

      assert.equal(replaced, true);
      const replacement = await adapter.getEntry(current.folder.id);
      assert.notEqual(replacement.layoutKey, initial.folderIdentity);
      assert.equal((await getLayoutSnapshot(replacement.id)).revision, 0);
    });

    await t.test("목록 조회 중 같은 local 경로가 교체되면 옛 항목을 버리고 전체 조회한다", async () => {
      const current = await makeFolder("listing-replaced", ["item.txt"]);
      const oldEntry = current.entries[0];
      const originalList = adapter.list.bind(adapter);
      let listCalls = 0;
      let replaced = false;

      adapter.list = async (folderId) => {
        const listed = await originalList(folderId);
        if (folderId !== current.folder.id) return listed;
        listCalls++;
        if (!replaced) {
          replaced = true;
          await adapter.remove(current.folder.id);
          await adapter.createFolder(ROOT_ID, current.folder.name);
          await writeFile(
            path.join(root, current.folder.name, oldEntry.name),
            "new contents",
            "utf8",
          );
        }
        return listed;
      };

      let listing!: Awaited<ReturnType<typeof getFolderListingWithLayout>>;
      try {
        listing = await getFolderListingWithLayout(current.folder.id);
      } finally {
        adapter.list = originalList;
      }

      const replacement = await adapter.getEntry(current.folder.id);
      const newEntry = listing.entries[0];
      assert.equal(listCalls, 2);
      assert.notEqual(replacement.layoutKey, current.folder.layoutKey);
      assert.notEqual(newEntry.layoutKey, oldEntry.layoutKey);
      assert.ok(listing.layout);
      assert.equal(listing.layout.folderIdentity, replacement.layoutKey);
      assert.equal(listing.layout.positions[oldEntry.layoutKey], undefined);
      assert.equal(listing.layout.positions[newEntry.layoutKey].version, 1);
      assert.deepEqual(
        await getLayoutSnapshot(current.folder.id),
        listing.layout,
      );
    });

    await t.test("같은 local 경로 id에 새 폴더 identity가 생기면 상태를 분리한다", async () => {
      const { folder, entries } = await makeFolder("folder-identity", ["item.txt"]);
      const entry = entries[0];
      const originalGetEntry = adapter.getEntry.bind(adapter);
      let generation = 1;
      let getEntryCalls = 0;
      adapter.getEntry = async (id) => {
        const result = await originalGetEntry(id);
        if (id !== folder.id) return result;
        getEntryCalls++;
        return { ...result, layoutKey: `local:test-folder:${generation}` };
      };

      try {
        const initial = await getLayoutSnapshotForEntries(folder.id, entries);
        const changed = await updateLayout(
          folder.id,
          [
            {
              entryId: entry.id,
              expectedVersion: initial.positions[entry.layoutKey].version,
              x: 620,
              y: 630,
            },
          ],
          "member-old-folder",
          initial.folderIdentity,
        );
        assert.equal(changed.revision, 2);

        generation = 2;
        const replacement = await getLayoutSnapshotForEntries(folder.id, entries);
        assert.equal(replacement.revision, 1);
        assert.equal(replacement.positions[entry.layoutKey].version, 1);
        assert.notDeepEqual(replacement.positions[entry.layoutKey], {
          x: 620,
          y: 630,
          version: 2,
        });
        assert.ok(getEntryCalls >= 5);
      } finally {
        adapter.getEntry = originalGetEntry;
      }
    });

    await t.test("같은 항목의 동시 변경은 하나만 성공한다", async () => {
      const { folder, entries } = await makeFolder("same-item", ["same.txt"]);
      const entry = entries[0];
      const initial = await getLayoutSnapshotForEntries(folder.id, entries);
      const expectedVersion = initial.positions[entry.layoutKey].version;
      const results = await Promise.allSettled([
        updateLayout(
          folder.id,
          [{ entryId: entry.id, expectedVersion, x: 111, y: 121 }],
          "member-a",
          initial.folderIdentity,
        ),
        updateLayout(
          folder.id,
          [{ entryId: entry.id, expectedVersion, x: 211, y: 221 }],
          "member-b",
          initial.folderIdentity,
        ),
      ]);

      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected && rejected.status === "rejected");
      assert.ok(rejected.reason instanceof StorageError);
      assert.equal(rejected.reason.code, "CONFLICT");

      const stored = await getLayoutSnapshot(folder.id);
      assert.equal(stored.revision, 2);
      assert.equal(stored.positions[entry.layoutKey].version, 2);
      assert.ok([111, 211].includes(stored.positions[entry.layoutKey].x));
    });

    await t.test("서로 다른 항목의 동시 변경은 둘 다 보존한다", async () => {
      const { folder, entries } = await makeFolder("different-items", [
        "a.txt",
        "b.txt",
      ]);
      const [a, b] = entries;
      const initial = await getLayoutSnapshotForEntries(folder.id, entries);
      const results = await Promise.allSettled([
        updateLayout(
          folder.id,
          [
            {
              entryId: a.id,
              expectedVersion: initial.positions[a.layoutKey].version,
              x: 410,
              y: 420,
            },
          ],
          "member-a",
          initial.folderIdentity,
        ),
        updateLayout(
          folder.id,
          [
            {
              entryId: b.id,
              expectedVersion: initial.positions[b.layoutKey].version,
              x: 510,
              y: 520,
            },
          ],
          "member-b",
          initial.folderIdentity,
        ),
      ]);

      assert.ok(results.every((result) => result.status === "fulfilled"));
      const stored = await getLayoutSnapshot(folder.id);
      assert.equal(stored.revision, 3);
      assert.deepEqual(stored.positions[a.layoutKey], {
        x: 410,
        y: 420,
        version: 2,
      });
      assert.deepEqual(stored.positions[b.layoutKey], {
        x: 510,
        y: 520,
        version: 2,
      });
    });

    await t.test("다른 인스턴스의 별도 항목 쓰기와 CAS 충돌하면 병합해 재시도한다", async () => {
      const { folder, entries } = await makeFolder("cas-merge", ["a.txt", "b.txt"]);
      const [a, b] = entries;
      const initial = await getLayoutSnapshotForEntries(folder.id, entries);
      const originalCompareAndSwap = adapter.compareAndSwapState.bind(adapter);
      let injected = false;
      let writeCalls = 0;
      adapter.compareAndSwapState = async (name, value, expectedVersion) => {
        writeCalls++;
        if (!injected) {
          injected = true;
          const rival = JSON.parse(JSON.stringify(value)) as StoredLayoutState;
          rival.items[a.layoutKey] = {
            ...rival.items[a.layoutKey],
            ...initial.positions[a.layoutKey],
            updatedAt: new Date().toISOString(),
            updatedBy: "member-rival",
          };
          rival.items[b.layoutKey] = {
            ...rival.items[b.layoutKey],
            x: 710,
            y: 720,
            version: initial.positions[b.layoutKey].version + 1,
            updatedAt: new Date().toISOString(),
            updatedBy: "member-rival",
          };
          await originalCompareAndSwap(name, rival, expectedVersion);
          throw new StorageError("CONFLICT", "forced inter-instance conflict");
        }
        return originalCompareAndSwap(name, value, expectedVersion);
      };

      try {
        const saved = await updateLayout(
          folder.id,
          [
            {
              entryId: a.id,
              expectedVersion: initial.positions[a.layoutKey].version,
              x: 610,
              y: 620,
            },
          ],
          "member-a",
          initial.folderIdentity,
        );
        assert.equal(writeCalls, 2);
        assert.equal(saved.revision, 3);
        assert.deepEqual(saved.positions[a.layoutKey], {
          x: 610,
          y: 620,
          version: 2,
        });
        assert.deepEqual(saved.positions[b.layoutKey], {
          x: 710,
          y: 720,
          version: 2,
        });
      } finally {
        adapter.compareAndSwapState = originalCompareAndSwap;
      }
    });

    await t.test("낡은 항목이 섞인 배치는 일부도 저장하지 않는다", async () => {
      const { folder, entries } = await makeFolder("batch-atomic", ["a.txt", "b.txt"]);
      const [a, b] = entries;
      const initial = await getLayoutSnapshotForEntries(folder.id, entries);
      await updateLayout(
        folder.id,
        [
          {
            entryId: a.id,
            expectedVersion: initial.positions[a.layoutKey].version,
            x: 810,
            y: 820,
          },
        ],
        "member-a",
        initial.folderIdentity,
      );

      await rejectsWithCode(
        updateLayout(
          folder.id,
          [
            {
              entryId: a.id,
              expectedVersion: initial.positions[a.layoutKey].version,
              x: 811,
              y: 821,
            },
            {
              entryId: b.id,
              expectedVersion: initial.positions[b.layoutKey].version,
              x: 911,
              y: 921,
            },
          ],
          "member-b",
          initial.folderIdentity,
        ),
        "CONFLICT",
      );

      const stored = await getLayoutSnapshot(folder.id);
      assert.equal(stored.revision, 2);
      assert.deepEqual(stored.positions[a.layoutKey], {
        x: 810,
        y: 820,
        version: 2,
      });
      assert.deepEqual(stored.positions[b.layoutKey], initial.positions[b.layoutKey]);
    });

    await t.test("CAS 재시도 소진 뒤 큐가 풀려 다음 쓰기가 성공한다", async () => {
      const { folder, entries } = await makeFolder("cas-exhaust-update", ["item.txt"]);
      const entry = entries[0];
      const initial = await getLayoutSnapshotForEntries(folder.id, entries);
      const originalCompareAndSwap = adapter.compareAndSwapState.bind(adapter);
      let conflictCalls = 0;
      adapter.compareAndSwapState = async () => {
        conflictCalls++;
        throw new StorageError("CONFLICT", "forced conflict");
      };

      try {
        await rejectsWithCode(
          updateLayout(
            folder.id,
            [
              {
                entryId: entry.id,
                expectedVersion: initial.positions[entry.layoutKey].version,
                x: 1010,
                y: 1020,
              },
            ],
            "member-a",
            initial.folderIdentity,
          ),
          "CONFLICT",
        );
        assert.equal(conflictCalls, 4);
      } finally {
        adapter.compareAndSwapState = originalCompareAndSwap;
      }

      const unchanged = await getLayoutSnapshot(folder.id);
      assert.deepEqual(unchanged, initial);
      const recovered = await updateLayout(
        folder.id,
        [
          {
            entryId: entry.id,
            expectedVersion: initial.positions[entry.layoutKey].version,
            x: 1110,
            y: 1120,
          },
        ],
        "member-a",
        initial.folderIdentity,
      );
      assert.deepEqual(recovered.positions[entry.layoutKey], {
        x: 1110,
        y: 1120,
        version: 2,
      });
    });

    await t.test("초기 배치 CAS 재시도 소진 시 저장되지 않은 버전을 반환하지 않는다", async () => {
      const { folder, entries } = await makeFolder("cas-exhaust-initial", ["item.txt"]);
      const originalCompareAndSwap = adapter.compareAndSwapState.bind(adapter);
      let conflictCalls = 0;
      adapter.compareAndSwapState = async () => {
        conflictCalls++;
        throw new StorageError("CONFLICT", "forced conflict");
      };

      try {
        await rejectsWithCode(
          getLayoutSnapshotForEntries(folder.id, entries),
          "CONFLICT",
        );
        assert.equal(conflictCalls, 4);
      } finally {
        adapter.compareAndSwapState = originalCompareAndSwap;
      }

      const missing = await getLayoutSnapshot(folder.id);
      assert.equal(missing.revision, 0);
      assert.equal(Object.keys(missing.positions).length, 0);
      const recovered = await getLayoutSnapshotForEntries(folder.id, entries);
      assert.equal(recovered.revision, 1);
      assert.equal(recovered.positions[entries[0].layoutKey].version, 1);
    });

    await t.test("서로 다른 id가 같은 레이아웃 키를 가리키면 배치를 거부한다", async () => {
      const { folder, entries } = await makeFolder("duplicate-key", ["a.txt", "b.txt"]);
      const [a, b] = entries;
      const initial = await getLayoutSnapshotForEntries(folder.id, entries);
      const originalList = adapter.list.bind(adapter);
      adapter.list = async (folderId) => {
        const listed = await originalList(folderId);
        return listed.map((entry) =>
          entry.id === b.id ? { ...entry, layoutKey: a.layoutKey } : entry,
        );
      };

      try {
        await rejectsWithCode(
          updateLayout(
            folder.id,
            [
              {
                entryId: a.id,
                expectedVersion: initial.positions[a.layoutKey].version,
                x: 1210,
                y: 1220,
              },
              {
                entryId: b.id,
                expectedVersion: initial.positions[b.layoutKey].version,
                x: 1310,
                y: 1320,
              },
            ],
            "member-a",
            initial.folderIdentity,
          ),
          "BAD_ID",
        );
      } finally {
        adapter.list = originalList;
      }

      assert.deepEqual(await getLayoutSnapshot(folder.id), initial);
    });
  } finally {
    if (originalDriver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = originalDriver;
    if (originalRoot === undefined) delete process.env.LOCAL_STORAGE_ROOT;
    else process.env.LOCAL_STORAGE_ROOT = originalRoot;
    await rm(root, { recursive: true, force: true });
  }
});
