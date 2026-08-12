import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("관리 대상 Drive 권한 생성·변경·회수", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-sharing-"));
  const originalDriveRoot = process.env.DRIVE_ROOT_FOLDER_ID;
  await mkdir(path.join(root, ".sharedesk"), { recursive: true });
  await writeFile(path.join(root, "report.txt"), "공유 문서", "utf8");
  await writeFile(
    path.join(root, ".sharedesk", "users.json"),
    JSON.stringify({
      version: 2,
      rev: 1,
      users: [
        {
          id: "admin-id",
          email: "admin@example.com",
          name: "관리자",
          status: "approved",
          isAdmin: true,
          createdAt: "2026-08-01T00:00:00.000Z",
          invitationId: null,
          sessionsValidFrom: 0,
        },
        {
          id: "approved-1",
          email: "reader@example.com",
          name: "읽기 사용자",
          status: "approved",
          isAdmin: false,
          createdAt: "2026-08-01T00:00:00.000Z",
          invitationId: null,
          sessionsValidFrom: 0,
        },
        {
          id: "approved-2",
          email: "writer@example.com",
          name: "쓰기 사용자",
          status: "approved",
          isAdmin: false,
          createdAt: "2026-08-01T00:00:00.000Z",
          invitationId: null,
          sessionsValidFrom: 0,
        },
        {
          id: "blocked-id",
          email: "blocked@example.com",
          name: "차단 사용자",
          status: "blocked",
          isAdmin: false,
          createdAt: "2026-08-01T00:00:00.000Z",
          invitationId: null,
          sessionsValidFrom: 0,
        },
        {
          id: "race-id",
          email: "race@example.com",
          name: "경쟁 사용자",
          status: "approved",
          isAdmin: false,
          createdAt: "2026-08-01T00:00:00.000Z",
          invitationId: null,
          sessionsValidFrom: 0,
        },
        {
          id: "ambiguous-id",
          email: "ambiguous@example.com",
          name: "응답 불확실 사용자",
          status: "approved",
          isAdmin: false,
          createdAt: "2026-08-01T00:00:00.000Z",
          invitationId: null,
          sessionsValidFrom: 0,
        },
      ],
      invitations: [],
    }),
    "utf8",
  );

  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  process.env.ADMIN_EMAILS = "admin@example.com";
  process.env.DRIVE_ROOT_FOLDER_ID = "configured-root";

  const shares = await import("@/lib/drive-shares");
  const fileId = Buffer.from("report.txt", "utf8").toString("base64url");

  try {
    const initial = await shares.getDriveSharing(fileId, "admin-id");
    assert.deepEqual(
      initial.users.map((user) => user.id).sort(),
      ["ambiguous-id", "approved-1", "approved-2", "race-id"],
      "승인된 사용자만 후보로 돌려준다",
    );
    assert.deepEqual(initial.permissions, []);

    const created = await shares.createDrivePermission({
      fileId,
      targetUserId: "approved-1",
      role: "reader",
      createdByUserId: "admin-id",
    });
    assert.equal(created.email, "reader@example.com");
    assert.equal(created.role, "reader");
    assert.equal((await shares.getDriveSharing(fileId)).permissions.length, 1);

    const updated = await shares.updateDrivePermission({
      fileId,
      permissionId: created.permissionId,
      role: "writer",
    });
    assert.equal(updated.role, "writer");

    await assert.rejects(
      shares.updateDrivePermission({
        fileId,
        permissionId: "untracked-permission",
        role: "reader",
      }),
      /ShareDesk가 만든 권한이 아닙니다/,
    );
    await assert.rejects(
      shares.createDrivePermission({
        fileId,
        targetUserId: "blocked-id",
        role: "reader",
        createdByUserId: "admin-id",
      }),
      /승인된 사용자가 아닙니다/,
    );

    const concurrent = await Promise.allSettled([
      shares.createDrivePermission({
        fileId,
        targetUserId: "approved-2",
        role: "reader",
        createdByUserId: "admin-id",
      }),
      shares.createDrivePermission({
        fileId,
        targetUserId: "approved-2",
        role: "writer",
        createdByUserId: "admin-id",
      }),
    ]);
    assert.equal(
      concurrent.filter((result) => result.status === "fulfilled").length,
      1,
      "같은 파일의 중복 권한 생성은 하나만 성공한다",
    );

    const revoked = await shares.revokeDrivePermissionsForTargetUser(
      "approved-2",
    );
    assert.deepEqual(revoked, { revoked: 1, failed: 0 });
    assert.equal(
      (await shares.getDriveSharing(fileId)).permissions.some(
        (permission) => permission.targetUserId === "approved-2",
      ),
      false,
    );

    await shares.deleteDrivePermission({
      fileId,
      permissionId: created.permissionId,
    });
    assert.deepEqual((await shares.getDriveSharing(fileId)).permissions, []);

    const { getAdapter } = await import("@/lib/storage");
    const { setStatus } = await import("@/lib/users");
    const adapter = getAdapter();
    const originalCreatePermission = adapter.createPermission.bind(adapter);
    let releaseCreate!: () => void;
    let enteredCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const createEntered = new Promise<void>((resolve) => {
      enteredCreate = resolve;
    });
    adapter.createPermission = async (...args) => {
      enteredCreate();
      await createGate;
      return originalCreatePermission(...args);
    };
    try {
      const creating = shares.createDrivePermission({
        fileId,
        targetUserId: "race-id",
        role: "reader",
        createdByUserId: "admin-id",
      });
      await createEntered;
      await setStatus("race-id", "blocked");
      const revoking = shares.revokeDrivePermissionsForTargetUser("race-id");
      await new Promise((resolve) => setTimeout(resolve, 0));
      releaseCreate();

      await assert.rejects(creating, /승인된 사용자가 아닙니다/);
      assert.deepEqual(await revoking, { revoked: 1, failed: 0 });
      assert.equal(
        (await shares.getDriveSharing(fileId)).permissions.some(
          (permission) => permission.targetUserId === "race-id",
        ),
        false,
        "생성과 차단이 겹쳐도 Drive 권한과 추적 장부가 함께 정리된다",
      );
      const localPermissions = JSON.parse(
        await (
          await import("node:fs/promises")
        ).readFile(
          path.join(root, ".sharedesk", "local-drive-permissions.json"),
          "utf8",
        ),
      ) as { permissions: Array<{ email: string }> };
      assert.equal(
        localPermissions.permissions.some(
          (permission) => permission.email === "race@example.com",
        ),
        false,
      );
    } finally {
      adapter.createPermission = originalCreatePermission;
    }

    await writeFile(path.join(root, "roles.txt"), "roles", "utf8");
    const rolesFileId = Buffer.from("roles.txt", "utf8").toString("base64url");
    const rolePermission = await shares.createDrivePermission({
      fileId: rolesFileId,
      targetUserId: "approved-1",
      role: "reader",
      createdByUserId: "admin-id",
    });
    const shareStatePath = path.join(root, ".sharedesk", "drive-shares.json");
    const reservedState = JSON.parse(
      await readFile(shareStatePath, "utf8"),
    ) as {
      rev: number;
      permissions: Array<{
        permissionId: string | null;
        state: string;
        role: "reader" | "writer";
        updateOperation: unknown;
        revokeRequested: boolean;
      }>;
    };
    const reservedRecord = reservedState.permissions.find(
      (permission) => permission.permissionId === rolePermission.permissionId,
    )!;
    reservedRecord.state = "recovery";
    reservedRecord.role = "writer";
    reservedRecord.updateOperation = {
      operationId: "other-instance-update",
      previousRole: "reader",
      targetRole: "writer",
      startedAt: new Date().toISOString(),
    };
    reservedState.rev += 1;
    await writeFile(shareStatePath, JSON.stringify(reservedState), "utf8");
    await assert.rejects(
      shares.updateDrivePermission({
        fileId: rolesFileId,
        permissionId: rolePermission.permissionId,
        role: "reader",
      }),
      /다른 권한 작업이 진행 중입니다/,
      "다른 인스턴스가 남긴 update 예약은 두 번째 PATCH를 막는다",
    );

    reservedRecord.state = "active";
    reservedRecord.role = "reader";
    reservedRecord.updateOperation = null;
    reservedRecord.revokeRequested = false;
    reservedState.rev += 1;
    await writeFile(shareStatePath, JSON.stringify(reservedState), "utf8");

    const originalUpdatePermission = adapter.updatePermission.bind(adapter);
    let releaseUpdate!: () => void;
    let enteredUpdate!: () => void;
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const updateEntered = new Promise<void>((resolve) => {
      enteredUpdate = resolve;
    });
    adapter.updatePermission = async (...args) => {
      enteredUpdate();
      await updateGate;
      return originalUpdatePermission(...args);
    };
    try {
      const updating = shares.updateDrivePermission({
        fileId: rolesFileId,
        permissionId: rolePermission.permissionId,
        role: "writer",
      });
      await updateEntered;
      const duringUpdate = JSON.parse(
        await readFile(shareStatePath, "utf8"),
      ) as typeof reservedState;
      const duringRecord = duringUpdate.permissions.find(
        (permission) => permission.permissionId === rolePermission.permissionId,
      )!;
      assert.equal(duringRecord.state, "recovery");
      assert.equal(duringRecord.role, "writer");
      assert.ok(duringRecord.updateOperation);
      duringRecord.revokeRequested = true;
      duringUpdate.rev += 1;
      await writeFile(shareStatePath, JSON.stringify(duringUpdate), "utf8");
      releaseUpdate();
      await assert.rejects(updating, /승인된 사용자가 아닙니다/);
      assert.equal(
        (await readFile(shareStatePath, "utf8")).includes(
          rolePermission.permissionId,
        ),
        false,
        "역할 변경 중 회수 요청은 외부 PATCH 뒤 exact 권한과 장부를 제거한다",
      );
    } finally {
      adapter.updatePermission = originalUpdatePermission;
    }

    await writeFile(path.join(root, "cas-role.txt"), "cas", "utf8");
    const casFileId = Buffer.from("cas-role.txt", "utf8").toString("base64url");
    const casPermission = await shares.createDrivePermission({
      fileId: casFileId,
      targetUserId: "approved-2",
      role: "reader",
      createdByUserId: "admin-id",
    });
    const originalCompareAndSwap = adapter.compareAndSwapState.bind(adapter);
    const originalCasUpdate = adapter.updatePermission.bind(adapter);
    const { StorageError } = await import("@/lib/storage/types");
    let failShareFinalize = false;
    adapter.compareAndSwapState = async (name, value, expectedVersion) => {
      if (name === "drive-shares.json" && failShareFinalize) {
        throw new StorageError("CONFLICT", "forced finalize conflict");
      }
      return originalCompareAndSwap(name, value, expectedVersion);
    };
    adapter.updatePermission = async (_id, permissionId, role) => {
      failShareFinalize = true;
      return { permissionId, role };
    };
    try {
      await assert.rejects(
        shares.updateDrivePermission({
          fileId: casFileId,
          permissionId: casPermission.permissionId,
          role: "writer",
        }),
        /forced finalize conflict/,
      );
    } finally {
      failShareFinalize = false;
      adapter.compareAndSwapState = originalCompareAndSwap;
      adapter.updatePermission = originalCasUpdate;
    }
    const casRecovery = (await shares.getDriveSharing(casFileId)).permissions.find(
      (permission) => permission.permissionId === casPermission.permissionId,
    );
    assert.equal(casRecovery?.state, "recovery");
    assert.equal(
      casRecovery?.role,
      "writer",
      "외부 PATCH 성공 뒤 장부 CAS 실패 시 목표 역할을 숨기지 않는다",
    );
    await shares.deleteDrivePermission({
      fileId: casFileId,
      permissionId: casPermission.permissionId,
    });

    await writeFile(path.join(root, "missing-permission.txt"), "missing", "utf8");
    const missingPermissionFileId = Buffer.from(
      "missing-permission.txt",
      "utf8",
    ).toString("base64url");
    const missingPermission = await shares.createDrivePermission({
      fileId: missingPermissionFileId,
      targetUserId: "approved-2",
      role: "reader",
      createdByUserId: "admin-id",
    });
    const originalMissingUpdate = adapter.updatePermission.bind(adapter);
    adapter.updatePermission = async () => {
      throw new StorageError("NOT_FOUND", "permission missing");
    };
    try {
      await assert.rejects(
        shares.updateDrivePermission({
          fileId: missingPermissionFileId,
          permissionId: missingPermission.permissionId,
          role: "writer",
        }),
        /permission missing/,
      );
    } finally {
      adapter.updatePermission = originalMissingUpdate;
    }
    assert.deepEqual(
      (await shares.getDriveSharing(missingPermissionFileId)).permissions,
      [],
      "사라진 exact 권한을 이전 역할 active 장부로 되살리지 않는다",
    );
    await adapter.deleteTrackedPermission!(
      missingPermissionFileId,
      missingPermission.permissionId,
    );

    const manual = await adapter.createPermission(
      fileId,
      "ambiguous@example.com",
      "reader",
    );
    await assert.rejects(
      shares.createDrivePermission({
        fileId,
        targetUserId: "ambiguous-id",
        role: "writer",
        createdByUserId: "admin-id",
      }),
      /이미 공유된 사용자입니다/,
    );
    assert.equal(
      (await shares.getDriveSharing(fileId)).permissions.some(
        (permission) => permission.targetUserId === "ambiguous-id",
      ),
      false,
      "명시적 충돌은 ShareDesk 예약만 제거한다",
    );

    const originalTrackedDelete = adapter.deleteTrackedPermission!.bind(adapter);
    let exactDeleteCalled = false;
    adapter.createPermission = async () => {
      throw new Error("권한 생성 응답이 끊겼습니다");
    };
    adapter.deleteTrackedPermission = async () => {
      exactDeleteCalled = true;
      throw new Error("permissionId 없는 삭제를 호출하면 안 됩니다");
    };
    try {
      await assert.rejects(
        shares.createDrivePermission({
          fileId,
          targetUserId: "ambiguous-id",
          role: "reader",
          createdByUserId: "admin-id",
        }),
        /권한 생성 응답이 끊겼습니다/,
      );
      assert.equal(exactDeleteCalled, false);
      const recovery = (await shares.getDriveSharing(fileId)).permissions.find(
        (permission) => permission.targetUserId === "ambiguous-id",
      );
      assert.equal(recovery?.state, "recovery");
      assert.match(recovery?.permissionId ?? "", /^pending:/);
      await assert.rejects(
        shares.deleteDrivePermission({
          fileId,
          permissionId: recovery!.permissionId,
        }),
        /같은 이메일의 권한이 있어 자동 회수하지 않습니다/,
      );
      const localPermissions = JSON.parse(
        await readFile(
          path.join(root, ".sharedesk", "local-drive-permissions.json"),
          "utf8",
        ),
      ) as { permissions: Array<{ permissionId: string }> };
      assert.equal(
        localPermissions.permissions.some(
          (permission) => permission.permissionId === manual.permissionId,
        ),
        true,
        "응답 불확실 복구가 기존 수동 권한을 삭제하지 않는다",
      );
    } finally {
      adapter.createPermission = originalCreatePermission;
      adapter.deleteTrackedPermission = originalTrackedDelete;
    }

    const staleFilePath = path.join(root, "stale-reservation.txt");
    await writeFile(staleFilePath, "stale", "utf8");
    const staleFileId = Buffer.from(
      "stale-reservation.txt",
      "utf8",
    ).toString("base64url");
    const staleState = JSON.parse(
      await readFile(shareStatePath, "utf8"),
    ) as { rev: number; permissions: Array<Record<string, unknown>> };
    const staleAt = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    staleState.permissions.push({
      recordId: "stale-creating-record",
      permissionId: null,
      state: "creating",
      revokeRequested: false,
      updateOperation: null,
      fileId: staleFileId,
      targetUserId: "approved-2",
      email: "writer@example.com",
      name: "쓰기 사용자",
      role: "reader",
      createdAt: staleAt,
      updatedAt: staleAt,
      createdByUserId: "admin-id",
    });
    staleState.rev += 1;
    await writeFile(shareStatePath, JSON.stringify(staleState), "utf8");
    const recoveredPermission = await shares.createDrivePermission({
      fileId: staleFileId,
      targetUserId: "approved-2",
      role: "writer",
      createdByUserId: "admin-id",
    });
    assert.equal(recoveredPermission.role, "writer");
    assert.equal(
      (await shares.getDriveSharing(staleFileId)).permissions.length,
      1,
      "만료된 creating 예약은 외부 권한이 없을 때 새 생성을 영구 차단하지 않는다",
    );

    const localPermissionPath = path.join(
      root,
      ".sharedesk",
      "local-drive-permissions.json",
    );
    const shareState = JSON.parse(await readFile(shareStatePath, "utf8")) as {
      rev: number;
      permissions: Array<Record<string, unknown>>;
    };
    const localPermissionState = JSON.parse(
      await readFile(localPermissionPath, "utf8"),
    ) as {
      rev: number;
      permissions: Array<Record<string, unknown>>;
    };
    for (const [index, rootFileId] of ["root", "configured-root"].entries()) {
      const permissionId = `root-permission-${index}`;
      const now = new Date().toISOString();
      shareState.permissions.push({
        recordId: `root-record-${index}`,
        permissionId,
        state: "active",
        revokeRequested: false,
        updateOperation: null,
        fileId: rootFileId,
        targetUserId: "approved-1",
        email: "reader@example.com",
        name: "읽기 사용자",
        role: "reader",
        createdAt: now,
        updatedAt: now,
        createdByUserId: "admin-id",
      });
      localPermissionState.permissions.push({
        permissionId,
        fileId: rootFileId,
        email: "reader@example.com",
        role: "reader",
      });
    }
    shareState.rev += 1;
    localPermissionState.rev += 1;
    await writeFile(shareStatePath, JSON.stringify(shareState), "utf8");
    await writeFile(
      localPermissionPath,
      JSON.stringify(localPermissionState),
      "utf8",
    );

    for (const [index, rootFileId] of ["root", "configured-root"].entries()) {
      await assert.rejects(
        shares.getDriveSharing(rootFileId),
        /루트 폴더 자체는 공유할 수 없습니다/,
      );
      await assert.rejects(
        shares.createDrivePermission({
          fileId: rootFileId,
          targetUserId: "approved-1",
          role: "reader",
          createdByUserId: "admin-id",
        }),
        /루트 폴더 자체는 공유할 수 없습니다/,
      );
      await assert.rejects(
        shares.updateDrivePermission({
          fileId: rootFileId,
          permissionId: `root-permission-${index}`,
          role: "writer",
        }),
        /루트 폴더 자체는 공유할 수 없습니다/,
      );
      await shares.deleteDrivePermission({
        fileId: rootFileId,
        permissionId: `root-permission-${index}`,
      });
    }
    const rootsAfterDelete = JSON.parse(
      await readFile(shareStatePath, "utf8"),
    ) as { permissions: Array<{ fileId: string }> };
    assert.equal(
      rootsAfterDelete.permissions.some(
        (permission) =>
          permission.fileId === "root" ||
          permission.fileId === "configured-root",
      ),
      false,
      "기존 잘못된 루트 공유 장부는 정확한 권한 ID로 회수할 수 있다",
    );

    await writeFile(path.join(root, "prune.txt"), "prune", "utf8");
    const pruneFileId = Buffer.from("prune.txt", "utf8").toString("base64url");
    const prunePermission = await shares.createDrivePermission({
      fileId: pruneFileId,
      targetUserId: "approved-2",
      role: "reader",
      createdByUserId: "admin-id",
    });
    await rm(path.join(root, "prune.txt"));
    const originalGetEntry = adapter.getEntry.bind(adapter);
    let cleanupLookups = 0;
    adapter.getEntry = async (...args) => {
      cleanupLookups += 1;
      return originalGetEntry(...args);
    };
    try {
      assert.deepEqual(
        await shares.pruneDrivePermissionsForFiles([pruneFileId]),
        { pruned: 1, failed: 0 },
      );
    } finally {
      adapter.getEntry = originalGetEntry;
    }
    assert.equal(
      cleanupLookups,
      0,
      "삭제 직후 공유 장부 정리는 다른 파일을 조회하지 않는다",
    );
    const permissionsAfterPrune = JSON.parse(
      await readFile(localPermissionPath, "utf8"),
    ) as { permissions: Array<{ permissionId: string }> };
    assert.equal(
      permissionsAfterPrune.permissions.some(
        (permission) =>
          permission.permissionId === prunePermission.permissionId,
      ),
      false,
      "파일이 없어도 정확한 추적 permissionId는 로컬 상태에서 제거한다",
    );

    const stateId = Buffer.from(".sharedesk", "utf8").toString("base64url");
    await assert.rejects(shares.getDriveSharing(stateId), /대상이 없습니다/);
    const outsideId = Buffer.from("../outside", "utf8").toString("base64url");
    await assert.rejects(shares.getDriveSharing(outsideId), /잘못된 id입니다/);
  } finally {
    if (originalDriveRoot === undefined) {
      delete process.env.DRIVE_ROOT_FOLDER_ID;
    } else {
      process.env.DRIVE_ROOT_FOLDER_ID = originalDriveRoot;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("Drive 어댑터가 직접 권한과 알림 기본값을 지킨다", async () => {
  const originalFetch = globalThis.fetch;
  const originalStateFolderId = process.env.DRIVE_STATE_FOLDER_ID;
  const originalDriveRoot = process.env.DRIVE_ROOT_FOLDER_ID;
  process.env.GOOGLE_CLIENT_ID = "test-client";
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.GOOGLE_REFRESH_TOKEN = "test-refresh";
  process.env.DRIVE_ROOT_FOLDER_ID = "root-folder";
  delete process.env.DRIVE_STATE_FOLDER_ID;

  const calls: Array<{ url: string; method: string; body: string }> = [];
  let role = "reader";
  let stateDirLookup = 0;
  let fileInsideRoot = true;
  let failAtomicStateCreate = true;
  let trashEtag = '"trash-etag-1"';
  let secondTrashDeleted = false;
  const stateFiles = new Map<string, { id: string; createdTime: string }>();
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
    if (url.includes("/drive/v3/files?") && method === "GET") {
      const query = new URL(url).searchParams.get("q") ?? "";
      if (query === "trashed=true") {
        return Response.json({
          files: [
            {
              id: "trashed-inside",
              name: "inside.txt",
              mimeType: "text/plain",
              parents: ["root-folder"],
              trashed: true,
              explicitlyTrashed: true,
            },
            {
              id: "trashed-outside",
              name: "outside.txt",
              mimeType: "text/plain",
              parents: ["outside-parent"],
              trashed: true,
              explicitlyTrashed: true,
            },
            ...(!secondTrashDeleted
              ? [
                  {
                    id: "trashed-second",
                    name: "second.txt",
                    mimeType: "text/plain",
                    parents: ["root-folder"],
                    trashed: true,
                    explicitlyTrashed: true,
                  },
                ]
              : []),
          ],
        });
      }
      if (query.includes("name='.sharedesk'")) {
        stateDirLookup++;
        if (stateDirLookup === 1) return Response.json({ files: [] });
        return Response.json({
          files: [
            { id: "state-dir-a", createdTime: "2026-01-01T00:00:00Z" },
            { id: "state-dir-b", createdTime: "2026-01-01T00:00:01Z" },
          ],
        });
      }
      const stateName = [...stateFiles.keys()].find((name) =>
        query.includes(`name='${name}'`),
      );
      if (stateName) {
        const file = stateFiles.get(stateName);
        return Response.json({ files: file ? [file] : [] });
      }
      if (query.includes("name='failure-state.json'")) {
        return Response.json({ files: [] });
      }
    }
    if (url.endsWith("/drive/v3/files?fields=id") && method === "POST") {
      const body = JSON.parse(String(init.body)) as { name?: string };
      if (body.name === ".sharedesk") return Response.json({ id: "state-dir-b" });
    }
    if (url.includes("/drive/v3/files/state-dir-b") && method === "PATCH") {
      return Response.json({ id: "state-dir-b", trashed: true });
    }
    if (url.includes("/drive/v3/files/file-id?fields=id,parents,trashed")) {
      return Response.json({
        id: "file-id",
        parents: fileInsideRoot ? ["root-folder"] : [],
        trashed: false,
      });
    }
    if (
      url.includes(
        "/drive/v3/files/file-id?fields=id,name,mimeType,parents,trashed",
      )
    ) {
      return Response.json({
        id: "file-id",
        name: "report.txt",
        mimeType: "text/plain",
        parents: ["root-folder"],
        trashed: false,
      });
    }
    if (
      url.includes(
        "/drive/v3/files/root-folder?fields=id,mimeType,parents,trashed",
      )
    ) {
      return Response.json({
        id: "root-folder",
        mimeType: "application/vnd.google-apps.folder",
        parents: [],
        trashed: false,
      });
    }
    if (
      url.includes(
        "/drive/v2/files/file-id?fields=id,title,mimeType,fileSize,modifiedDate,etag",
      )
    ) {
      return Response.json({
        id: "file-id",
        title: "report.txt",
        mimeType: "text/plain",
        fileSize: "10",
        modifiedDate: "2026-01-01T00:00:00Z",
        etag: '"file-etag-1"',
      });
    }
    if (
      url.includes(
        "/drive/v3/files/file-id?fields=id,name,mimeType,size,modifiedTime",
      )
    ) {
      return Response.json({
        id: "file-id",
        name: "report.txt",
        mimeType: "text/plain",
        size: "10",
      });
    }
    if (url.includes("/drive/v3/files/outside?fields=id,parents,trashed")) {
      return Response.json({ id: "outside", parents: [], trashed: false });
    }
    if (
      url.includes(
        "/drive/v3/files/outside-parent?fields=id,parents,trashed",
      )
    ) {
      return Response.json({
        id: "outside-parent",
        parents: [],
        trashed: false,
      });
    }
    if (
      url.includes(
        "/drive/v3/files/trashed-inside?fields=id,name,parents,trashed,explicitlyTrashed",
      )
    ) {
      return Response.json({
        id: "trashed-inside",
        name: "inside.txt",
        parents: ["root-folder"],
        trashed: true,
        explicitlyTrashed: true,
      });
    }
    if (
      url.includes(
        "/drive/v3/files/trashed-outside?fields=id,name,parents,trashed,explicitlyTrashed",
      )
    ) {
      return Response.json({
        id: "trashed-outside",
        name: "outside.txt",
        parents: ["outside-parent"],
        trashed: true,
        explicitlyTrashed: true,
      });
    }
    if (
      url.includes(
        "/drive/v3/files/trashed-second?fields=id,name,parents,trashed,explicitlyTrashed",
      )
    ) {
      return Response.json({
        id: "trashed-second",
        name: "second.txt",
        parents: ["root-folder"],
        trashed: true,
        explicitlyTrashed: true,
      });
    }
    if (
      url.endsWith("/drive/v2/files/trashed-inside?fields=etag") &&
      method === "GET"
    ) {
      return Response.json({ etag: trashEtag });
    }
    if (url.endsWith("/drive/v2/files/trashed-inside") && method === "DELETE") {
      if (new Headers(init.headers).get("If-Match") !== trashEtag) {
        return new Response(null, { status: 412 });
      }
      return new Response(null, { status: 204 });
    }
    if (
      url.endsWith("/drive/v2/files/trashed-second?fields=etag") &&
      method === "GET"
    ) {
      return Response.json({ etag: '"trash-second-etag"' });
    }
    if (url.endsWith("/drive/v2/files/trashed-second") && method === "DELETE") {
      if (new Headers(init.headers).get("If-Match") !== '"trash-second-etag"') {
        return new Response(null, { status: 412 });
      }
      secondTrashDeleted = true;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/drive/v3/files/trashed-outside") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/permissions?") && method === "GET") {
      return Response.json({ permissions: [] });
    }
    if (url.includes("/permissions") && method === "POST") {
      return Response.json({
        id: "permission-1",
        type: "user",
        emailAddress: "reader@example.com",
        role,
      });
    }
    if (url.includes("/permissions/inherited-id") && method === "GET") {
      return Response.json({
        id: "inherited-id",
        type: "user",
        emailAddress: "reader@example.com",
        role: "reader",
        permissionDetails: [{ inherited: true }],
      });
    }
    if (url.includes("/permissions/permission-1") && method === "GET") {
      return Response.json({
        id: "permission-1",
        type: "user",
        emailAddress: "reader@example.com",
        role,
      });
    }
    if (url.includes("/permissions/permission-1") && method === "PATCH") {
      role = (JSON.parse(String(init.body)) as { role: string }).role;
      return Response.json({
        id: "permission-1",
        type: "user",
        emailAddress: "reader@example.com",
        role,
      });
    }
    if (url.includes("/permissions/permission-1") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/files/trashed-file/permissions/tracked-id") && method === "GET") {
      return Response.json({
        id: "tracked-id",
        type: "user",
        emailAddress: "reader@example.com",
        role: "reader",
      });
    }
    if (url.includes("/files/trashed-file/permissions/tracked-id") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (url.includes("/files/missing-file/permissions/missing-id") && method === "GET") {
      return new Response(null, { status: 404 });
    }
    if (url.includes("/files/root-folder/permissions/root-tracked") && method === "GET") {
      return Response.json({
        id: "root-tracked",
        type: "user",
        emailAddress: "reader@example.com",
        role: "reader",
      });
    }
    if (url.includes("/files/root-folder/permissions/root-tracked") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (
      url.includes("/upload/drive/v3/files?uploadType=multipart") &&
      method === "POST"
    ) {
      if (failAtomicStateCreate) {
        failAtomicStateCreate = false;
        return new Response("failed", { status: 500 });
      }
      stateFiles.set("failure-state.json", {
        id: "state-file-1",
        createdTime: "2026-01-01T00:00:00Z",
      });
      return Response.json({ id: "state-file-1" });
    }
    if (url.includes("/drive/v2/files/state-file-1?fields=etag")) {
      return Response.json({ etag: '"state-etag-1"' });
    }
    throw new Error(`예상하지 못한 요청: ${method} ${url}`);
  };

  try {
    const { DriveAdapter } = await import("@/lib/storage/drive");
    const adapter = new DriveAdapter();
    await Promise.all([adapter.getEntry("file-id"), adapter.getEntry("file-id")]);
    assert.equal(
      calls.filter(
        (call) =>
          call.method === "POST" &&
          call.url.endsWith("/drive/v3/files?fields=id"),
      ).length,
      1,
      "동시 최초 접근에서도 이 인스턴스는 상태 폴더를 한 번만 만든다",
    );
    assert.ok(
      calls.some(
        (call) =>
          call.method === "PATCH" && call.url.includes("/files/state-dir-b"),
      ),
      "경쟁에서 선택되지 않은 이 인스턴스의 새 폴더만 휴지통으로 보낸다",
    );
    await assert.rejects(
      adapter.move("file-id", "root-folder", '"stale-etag"'),
      /다른 사람이 먼저 옮기거나 수정했습니다/,
    );
    const noOpMove = await adapter.move(
      "file-id",
      "root-folder",
      '"file-etag-1"',
    );
    assert.equal(noOpMove.version, '"file-etag-1"');
    assert.equal(
      calls.some(
        (call) =>
          call.method === "PATCH" && call.url.includes("/drive/v2/files/file-id"),
      ),
      false,
      "같은 폴더로의 이동은 쓰지 않되 최신 ETag를 확인해 반환한다",
    );
    const created = await adapter.createPermission(
      "file-id",
      "reader@example.com",
      "reader",
    );
    assert.deepEqual(created, {
      permissionId: "permission-1",
      role: "reader",
    });
    const createCall = calls.find((call) => call.method === "POST" && call.url.includes("/permissions?"));
    assert.ok(createCall);
    assert.equal(
      new URL(createCall.url).searchParams.get("sendNotificationEmail"),
      "false",
    );
    assert.deepEqual(JSON.parse(createCall.body), {
      type: "user",
      role: "reader",
      emailAddress: "reader@example.com",
    });

    await assert.rejects(
      adapter.createPermission("root", "reader@example.com", "reader"),
      /루트 폴더 자체는 공유할 수 없습니다/,
    );
    await assert.rejects(
      adapter.createPermission(
        "root-folder",
        "reader@example.com",
        "reader",
      ),
      /루트 폴더 자체는 공유할 수 없습니다/,
    );
    await assert.rejects(
      adapter.updatePermission("root", "root-tracked", "writer"),
      /루트 폴더 자체는 공유할 수 없습니다/,
    );
    await adapter.deleteTrackedPermission("root", "root-tracked");
    assert.ok(
      calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.url.includes("/files/root-folder/permissions/root-tracked"),
      ),
      "기존 루트 장부의 exact 권한은 회수할 수 있다",
    );

    const trashEntries = await adapter.listTrash();
    assert.deepEqual(
      trashEntries.map((entry) => entry.id),
      ["trashed-inside", "trashed-second"],
      "루트 밖으로 옮긴 뒤 버린 파일은 휴지통 목록에서 제외한다",
    );
    await assert.rejects(
      adapter.restore("trashed-outside"),
      /공유 폴더 안에 없는 대상입니다/,
    );
    await assert.rejects(
      adapter.purge("trashed-outside", '"outside-etag"'),
      /공유 폴더 안에 없는 대상입니다/,
    );
    trashEtag = '"trash-etag-2"';
    assert.deepEqual(
      await adapter.emptyTrash(
        trashEntries.map(({ id, version }) => ({ id, version })),
      ),
      { fileIds: ["trashed-second"], skipped: 1, failed: 0 },
      "복원·수정·재삭제된 같은 id를 오래된 목록으로 완전 삭제하지 않는다",
    );
    const refreshedTrashEntries = await adapter.listTrash();
    assert.deepEqual(
      await adapter.emptyTrash(
        refreshedTrashEntries.map(({ id, version }) => ({ id, version })),
      ),
      { fileIds: ["trashed-inside"], skipped: 0, failed: 0 },
    );
    assert.ok(
      calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.url.endsWith("/drive/v2/files/trashed-inside"),
      ),
    );
    assert.equal(
      calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.url.endsWith("/drive/v3/files/trashed-outside"),
      ),
      false,
      "emptyTrash도 루트 밖 항목을 영구 삭제하지 않는다",
    );

    assert.equal(
      (await adapter.updatePermission("file-id", "permission-1", "writer"))
        .role,
      "writer",
    );
    fileInsideRoot = false;
    await assert.rejects(
      adapter.updatePermission("file-id", "permission-1", "reader"),
      /공유 폴더 안에 없는 대상입니다/,
      "Drive 웹에서 루트 밖으로 옮긴 뒤에는 이전 양성 판정을 재사용하지 않는다",
    );
    await adapter.deleteTrackedPermission(
      "trashed-file",
      "tracked-id",
    );
    await adapter.deleteTrackedPermission(
      "missing-file",
      "missing-id",
    );
    fileInsideRoot = true;
    await assert.rejects(
      adapter.updatePermission("file-id", "inherited-id", "writer"),
      /관리할 수 있는 직접 권한이 없습니다/,
    );
    await adapter.deletePermission("file-id", "permission-1");
    await assert.rejects(
      adapter.createPermission(
        "state-dir-a",
        "reader@example.com",
        "reader",
      ),
      /대상이 없습니다/,
    );
    await assert.rejects(
      adapter.createPermission("outside", "reader@example.com", "reader"),
      /공유 폴더 안에 없는 대상입니다/,
    );

    await assert.rejects(
      adapter.compareAndSwapState(
        "failure-state.json",
        { ok: true },
        null,
      ),
      /구글 드라이브 오류/,
    );
    assert.equal(
      stateFiles.has("failure-state.json"),
      false,
      "본문을 포함한 원자 생성 실패 뒤 빈 상태 파일이 남지 않는다",
    );
    assert.equal(
      await adapter.compareAndSwapState(
        "failure-state.json",
        { ok: true },
        null,
      ),
      '"state-etag-1"',
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStateFolderId === undefined) {
      delete process.env.DRIVE_STATE_FOLDER_ID;
    } else {
      process.env.DRIVE_STATE_FOLDER_ID = originalStateFolderId;
    }
    if (originalDriveRoot === undefined) {
      delete process.env.DRIVE_ROOT_FOLDER_ID;
    } else {
      process.env.DRIVE_ROOT_FOLDER_ID = originalDriveRoot;
    }
  }
});
