import { randomUUID } from "node:crypto";
import { getAdapter } from "@/lib/storage";
import {
  ROOT_ID,
  ShareRole,
  StorageError,
} from "@/lib/storage/types";
import { findUserById, listUsers, type User } from "@/lib/users";

const FILE = "drive-shares.json";
const WRITE_RETRIES = 3;
const CREATION_LEASE_MS = 2 * 60 * 1000;

interface UpdateOperation {
  operationId: string;
  previousRole: ShareRole;
  targetRole: ShareRole;
  startedAt: string;
}

interface StoredPermission {
  recordId: string;
  permissionId: string | null;
  state: "creating" | "active" | "recovery";
  revokeRequested: boolean;
  updateOperation: UpdateOperation | null;
  fileId: string;
  targetUserId: string;
  email: string;
  name: string;
  role: ShareRole;
  createdAt: string;
  updatedAt: string;
  createdByUserId: string;
}

interface ShareFile {
  version: 2;
  rev: number;
  permissions: StoredPermission[];
}

export interface ShareUser {
  id: string;
  email: string;
  name: string;
}

export interface ManagedDrivePermission {
  permissionId: string;
  state: "active" | "recovery";
  targetUserId: string;
  email: string;
  name: string;
  role: ShareRole;
  createdAt: string;
  updatedAt: string;
}

export interface DriveSharingSnapshot {
  users: ShareUser[];
  permissions: ManagedDrivePermission[];
}

let stateWriteChain: Promise<unknown> = Promise.resolve();
const fileWriteChains = new Map<string, Promise<void>>();

function emptyFile(): ShareFile {
  return { version: 2, rev: 0, permissions: [] };
}

function validDate(value: unknown): string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : new Date(0).toISOString();
}

function normalize(raw: unknown): ShareFile {
  const file = raw as Partial<ShareFile> | null;
  if (!file || !Array.isArray(file.permissions)) return emptyFile();
  const permissions = file.permissions
    .filter((item) => {
      const candidate = item as Partial<StoredPermission> | null;
      return (
        !!item &&
        ((typeof candidate?.recordId === "string" && !!candidate.recordId) ||
          (typeof candidate?.permissionId === "string" &&
            !!candidate.permissionId)) &&
        typeof candidate?.fileId === "string" &&
        !!candidate.fileId &&
        typeof candidate.targetUserId === "string" &&
        !!candidate.targetUserId &&
        typeof candidate.email === "string" &&
        typeof candidate.name === "string" &&
        (candidate.role === "reader" || candidate.role === "writer")
      );
    })
    .map((item) => {
      const candidate = item as Partial<StoredPermission>;
      const permissionId =
        typeof candidate.permissionId === "string" && candidate.permissionId
          ? candidate.permissionId
          : null;
      const recordId =
        typeof candidate.recordId === "string" && candidate.recordId
          ? candidate.recordId
          : permissionId!;
      return {
        recordId,
        permissionId,
        state:
          candidate.state === "creating" || candidate.state === "recovery"
            ? candidate.state
            : "active",
        revokeRequested: candidate.revokeRequested === true,
        updateOperation:
          candidate.updateOperation &&
          typeof candidate.updateOperation === "object" &&
          typeof candidate.updateOperation.operationId === "string" &&
          (candidate.updateOperation.previousRole === "reader" ||
            candidate.updateOperation.previousRole === "writer") &&
          (candidate.updateOperation.targetRole === "reader" ||
            candidate.updateOperation.targetRole === "writer")
            ? {
                operationId: candidate.updateOperation.operationId,
                previousRole: candidate.updateOperation.previousRole,
                targetRole: candidate.updateOperation.targetRole,
                startedAt: validDate(candidate.updateOperation.startedAt),
              }
            : null,
        fileId: candidate.fileId!,
        targetUserId: candidate.targetUserId!,
        email: candidate.email!,
        name: candidate.name!,
        role: candidate.role!,
        createdAt: validDate(candidate.createdAt),
        updatedAt: validDate(candidate.updatedAt),
        createdByUserId:
          typeof candidate.createdByUserId === "string"
            ? candidate.createdByUserId
            : "",
      } satisfies StoredPermission;
    });
  return {
    version: 2,
    rev: typeof file.rev === "number" ? file.rev : 0,
    permissions,
  };
}

async function readFile(): Promise<{
  data: ShareFile;
  storageVersion: string | null;
}> {
  const state = await getAdapter().readStateVersioned<ShareFile>(FILE);
  return { data: normalize(state.value), storageVersion: state.version };
}

async function mutate<T>(fn: (file: ShareFile) => T): Promise<T> {
  const run = stateWriteChain.then(async () => {
    for (let attempt = 0; attempt <= WRITE_RETRIES; attempt++) {
      const before = await readFile();
      const draft = JSON.parse(JSON.stringify(before.data)) as ShareFile;
      const result = fn(draft);
      draft.version = 2;
      draft.rev = before.data.rev + 1;
      try {
        await getAdapter().compareAndSwapState(
          FILE,
          draft,
          before.storageVersion,
        );
        return result;
      } catch (error) {
        if (
          error instanceof StorageError &&
          error.code === "CONFLICT" &&
          attempt < WRITE_RETRIES
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new StorageError("CONFLICT", "공유 권한이 계속 변경되고 있습니다");
  });
  stateWriteChain = run.catch(() => undefined);
  return run;
}

async function withFileWrite<T>(fileId: string, task: () => Promise<T>): Promise<T> {
  const previous = fileWriteChains.get(fileId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  fileWriteChains.set(fileId, tail);
  try {
    return await run;
  } finally {
    if (fileWriteChains.get(fileId) === tail) fileWriteChains.delete(fileId);
  }
}

function toPublic(item: StoredPermission): ManagedDrivePermission {
  return {
    permissionId: item.permissionId ?? `pending:${item.recordId}`,
    state: item.state === "active" ? "active" : "recovery",
    targetUserId: item.targetUserId,
    email: item.email,
    name: item.name,
    role: item.role,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function parseShareRole(value: unknown): ShareRole {
  if (value !== "reader" && value !== "writer") {
    throw new StorageError("BAD_ID", "권한은 reader 또는 writer여야 합니다");
  }
  return value;
}

async function approvedTarget(targetUserId: string): Promise<User> {
  if (!targetUserId || targetUserId.length > 256) {
    throw new StorageError("BAD_ID", "대상 사용자를 확인해 주세요");
  }
  const user = await findUserById(targetUserId, { fresh: true });
  if (!user || user.status !== "approved") {
    throw new StorageError("NOT_FOUND", "승인된 사용자가 아닙니다");
  }
  return user;
}

async function assertShareable(fileId: string): Promise<void> {
  if (!fileId || fileId.length > 1024) {
    throw new StorageError("BAD_ID", "대상을 확인해 주세요");
  }
  const configuredRoot = process.env.DRIVE_ROOT_FOLDER_ID?.trim();
  if (fileId === ROOT_ID || (configuredRoot && fileId === configuredRoot)) {
    throw new StorageError("BAD_ID", "루트 폴더 자체는 공유할 수 없습니다");
  }
  await getAdapter().getEntry(fileId);
}

function findByPublicPermissionId(
  file: ShareFile,
  fileId: string,
  permissionId: string,
): StoredPermission | undefined {
  return file.permissions.find(
    (item) =>
      item.fileId === fileId &&
      (item.permissionId === permissionId ||
        `pending:${item.recordId}` === permissionId),
  );
}

async function deleteTrackedExternal(item: StoredPermission): Promise<void> {
  const adapter = getAdapter();
  if (!item.permissionId) {
    throw new StorageError(
      "CONFLICT",
      "정확한 권한 ID를 확인할 때까지 자동으로 회수하지 않습니다",
    );
  }
  try {
    if (adapter.deleteTrackedPermission) {
      await adapter.deleteTrackedPermission(item.fileId, item.permissionId);
      return;
    }
    await adapter.deletePermission(item.fileId, item.permissionId);
  } catch (error) {
    // 파일 또는 권한이 이미 사라졌다면 회수는 끝난 것이다.
    if (!(error instanceof StorageError && error.code === "NOT_FOUND")) {
      throw error;
    }
  }
}

async function removeRecord(recordId: string): Promise<void> {
  await mutate((file) => {
    const index = file.permissions.findIndex(
      (item) => item.recordId === recordId,
    );
    if (index >= 0) file.permissions.splice(index, 1);
  });
}

async function markRecovery(
  recordId: string,
  permissionId?: string,
): Promise<void> {
  await mutate((file) => {
    const item = file.permissions.find(
      (permission) => permission.recordId === recordId,
    );
    if (!item) return;
    if (permissionId) item.permissionId = permissionId;
    item.state = "recovery";
    item.revokeRequested = true;
    item.updatedAt = new Date().toISOString();
  });
}

async function deleteRecordUnlocked(
  recordId: string,
  updateOperationId?: string,
): Promise<void> {
  const before = await readFile();
  const current = before.data.permissions.find(
    (item) => item.recordId === recordId,
  );
  if (!current) return;
  if (
    current.updateOperation &&
    current.updateOperation.operationId !== updateOperationId
  ) {
    await mutate((file) => {
      const item = file.permissions.find(
        (permission) => permission.recordId === recordId,
      );
      if (!item) return;
      item.revokeRequested = true;
      item.state = "recovery";
      item.updatedAt = new Date().toISOString();
    });
    // 역할 PATCH와 exact permission DELETE가 겹쳐도 PATCH는 삭제된 권한을
    // 다시 만들 수 없다. 회수를 바로 진행해 차단/삭제 요청을 우선한다.
  }
  if (
    !current.permissionId &&
    current.state === "creating" &&
    Date.now() - Date.parse(current.createdAt) < CREATION_LEASE_MS
  ) {
    await mutate((file) => {
      const item = file.permissions.find(
        (permission) => permission.recordId === recordId,
      );
      if (!item) return null;
      item.state = "recovery";
      item.revokeRequested = true;
      item.updatedAt = new Date().toISOString();
      return { ...item };
    });
    // 생성 요청이 권한 ID를 붙인 뒤 revokeRequested를 보고 직접 회수한다.
    // 레코드를 지금 지우면 그 직후 외부 권한이 생기는 경쟁에서 추적 정보가 사라진다.
    throw new StorageError("CONFLICT", "공유 권한 생성이 끝난 뒤 자동 회수됩니다");
  }
  if (!current.permissionId) {
    const adapter = getAdapter();
    if (!adapter.findPermissionByEmail) {
      throw new StorageError(
        "CONFLICT",
        "정확한 권한 ID를 확인할 때까지 자동으로 회수하지 않습니다",
      );
    }
    let found: Awaited<ReturnType<typeof adapter.findPermissionByEmail>> = null;
    try {
      found = await adapter.findPermissionByEmail(current.fileId, current.email);
    } catch (error) {
      if (!(error instanceof StorageError && error.code === "NOT_FOUND")) {
        throw error;
      }
    }
    if (found) {
      throw new StorageError(
        "CONFLICT",
        "같은 이메일의 권한이 있어 자동 회수하지 않습니다",
      );
    }
    if (Date.now() - Date.parse(current.createdAt) < CREATION_LEASE_MS) {
      throw new StorageError(
        "CONFLICT",
        "권한 생성 결과를 확인하는 중입니다. 잠시 뒤 다시 시도해 주세요",
      );
    }
    await removeRecord(recordId);
    return;
  }
  await deleteTrackedExternal(current);
  await removeRecord(recordId);
}

export async function getDriveSharing(
  fileId: string,
  excludeUserId?: string,
): Promise<DriveSharingSnapshot> {
  await assertShareable(fileId);
  const [stored, users] = await Promise.all([readFile(), listUsers()]);
  return {
    users: users
      .filter(
        (user) =>
          user.status === "approved" && user.id !== excludeUserId,
      )
      .map(({ id, email, name }) => ({ id, email, name }))
      .sort((a, b) => a.name.localeCompare(b.name, "ko")),
    permissions: stored.data.permissions
      .filter(
        (permission) =>
          permission.fileId === fileId && permission.state !== "creating",
      )
      .map(toPublic)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
}

export async function createDrivePermission(input: {
  fileId: string;
  targetUserId: string;
  role: ShareRole;
  sendNotificationEmail?: boolean;
  createdByUserId: string;
}): Promise<ManagedDrivePermission> {
  return withFileWrite(input.fileId, async () => {
    await assertShareable(input.fileId);
    const target = await approvedTarget(input.targetUserId);
    const existing = (await readFile()).data.permissions.find(
      (item) =>
        item.fileId === input.fileId &&
        item.targetUserId === input.targetUserId,
    );
    if (
      existing?.state === "creating" &&
      !existing.permissionId &&
      Date.now() - Date.parse(existing.createdAt) >= CREATION_LEASE_MS
    ) {
      // 생성 요청이 중간에 끊긴 오래된 예약은 기존의 보수적 복구 경로로
      // 확인한다. 같은 이메일의 권한이 보이면 모호하므로 그대로 막는다.
      await deleteRecordUnlocked(existing.recordId);
    }
    const now = new Date().toISOString();
    const record: StoredPermission = {
      recordId: randomUUID(),
      permissionId: null,
      state: "creating",
      revokeRequested: false,
      updateOperation: null,
      fileId: input.fileId,
      targetUserId: target.id,
      email: target.email,
      name: target.name,
      role: input.role,
      createdAt: now,
      updatedAt: now,
      createdByUserId: input.createdByUserId,
    };
    // 외부 API를 부르기 전에 복구에 필요한 파일·이메일을 먼저 영구 장부에 남긴다.
    await mutate((file) => {
      if (
        file.permissions.some(
          (item) =>
            item.fileId === input.fileId &&
            item.targetUserId === input.targetUserId,
        )
      ) {
        throw new StorageError("CONFLICT", "이미 공유된 사용자입니다");
      }
      file.permissions.push(record);
    });

    let createdPermissionId: string;
    try {
      const created = await getAdapter().createPermission(
        input.fileId,
        target.email,
        input.role,
        { sendNotificationEmail: input.sendNotificationEmail === true },
      );
      createdPermissionId = created.permissionId;
      record.permissionId = created.permissionId;
      record.role = created.role;
    } catch (error) {
      if (error instanceof StorageError && error.code === "CONFLICT") {
        // Drive가 명시적으로 충돌을 알린 경우에는 새 권한이 생기지 않았다.
        // 예약만 지우고, 같은 이메일의 기존 수동 권한은 절대 건드리지 않는다.
        await removeRecord(record.recordId).catch((cleanupError) =>
          console.error("[share] 생성 예약 정리 실패", cleanupError),
        );
      } else {
        // 네트워크 단절처럼 결과가 불확실하면 정확한 permissionId가 없으므로
        // 이메일로 추정 삭제하지 않고 recovery 장부를 남긴다.
        await markRecovery(record.recordId).catch((stateError) =>
          console.error("[share] 생성 실패 복구 장부 갱신 실패", stateError),
        );
      }
      throw error;
    }

    // 권한 ID를 먼저 복구 상태로 적는다. 이후 어느 단계가 실패해도 장부에서 회수할 수 있다.
    try {
      await mutate((file) => {
        const item = file.permissions.find(
          (permission) => permission.recordId === record.recordId,
        );
        if (!item) {
          throw new StorageError("CONFLICT", "공유 생성 예약이 취소되었습니다");
        }
        item.permissionId = createdPermissionId;
        item.role = record.role;
        item.state = "recovery";
        item.updatedAt = new Date().toISOString();
      });
    } catch (error) {
      try {
        await deleteTrackedExternal(record);
        await removeRecord(record.recordId).catch(() => undefined);
      } catch (cleanupError) {
        // 예약에는 이메일이 남아 있어 ID 저장마저 실패해도 다음 회수가 가능하다.
        await markRecovery(record.recordId, createdPermissionId).catch(
          (stateError) =>
            console.error("[share] 권한 복구 장부 갱신 실패", stateError),
        );
        console.error("[share] 권한 생성 롤백 실패", cleanupError);
      }
      throw error;
    }

    let targetError: unknown = null;
    try {
      await approvedTarget(input.targetUserId);
    } catch (error) {
      targetError = error;
    }

    let shouldRevoke = targetError !== null;
    let finalized: ManagedDrivePermission | null = null;
    if (!shouldRevoke) {
      try {
        const result = await mutate((file) => {
          const item = file.permissions.find(
            (permission) => permission.recordId === record.recordId,
          );
          if (!item || item.revokeRequested) return null;
          item.state = "active";
          item.updatedAt = new Date().toISOString();
          return toPublic(item);
        });
        finalized = result;
        shouldRevoke = result === null;
      } catch (error) {
        targetError = error;
        shouldRevoke = true;
      }
    }

    if (shouldRevoke) {
      try {
        await deleteRecordUnlocked(record.recordId);
      } catch (cleanupError) {
        await markRecovery(record.recordId, createdPermissionId).catch(
          (stateError) =>
            console.error("[share] 권한 복구 장부 갱신 실패", stateError),
        );
        console.error("[share] 권한 생성 롤백 실패", cleanupError);
      }
      if (targetError) throw targetError;
      throw new StorageError("NOT_FOUND", "승인된 사용자가 아닙니다");
    }
    return finalized!;
  });
}

export async function updateDrivePermission(input: {
  fileId: string;
  permissionId: string;
  role: ShareRole;
}): Promise<ManagedDrivePermission> {
  return withFileWrite(input.fileId, async () => {
    await assertShareable(input.fileId);
    const before = await readFile();
    const current = before.data.permissions.find(
      (item) =>
        item.fileId === input.fileId &&
        item.permissionId === input.permissionId,
    );
    if (!current) {
      throw new StorageError("NOT_FOUND", "ShareDesk가 만든 권한이 아닙니다");
    }
    await approvedTarget(current.targetUserId);
    if (current.role === input.role && current.state === "active") {
      return toPublic(current);
    }

    const operationId = randomUUID();
    const reserved = await mutate((file) => {
      const item = file.permissions.find(
        (permission) =>
          permission.fileId === input.fileId &&
          permission.permissionId === input.permissionId,
      );
      if (!item) {
        throw new StorageError("NOT_FOUND", "ShareDesk가 만든 권한이 아닙니다");
      }
      if (
        item.state !== "active" ||
        item.updateOperation ||
        item.revokeRequested
      ) {
        throw new StorageError("CONFLICT", "다른 권한 작업이 진행 중입니다");
      }
      const startedAt = new Date().toISOString();
      item.updateOperation = {
        operationId,
        previousRole: item.role,
        targetRole: input.role,
        startedAt,
      };
      // 외부 PATCH보다 먼저 목표 역할을 recovery 상태로 적어, 응답 유실이나
      // CAS 실패 때 실제 writer인데 장부에는 reader로 숨는 상태를 만들지 않는다.
      item.role = input.role;
      item.state = "recovery";
      item.updatedAt = startedAt;
      return { ...item };
    });

    let updated: { permissionId: string; role: ShareRole };
    try {
      updated = await getAdapter().updatePermission(
        input.fileId,
        input.permissionId,
        input.role,
      );
    } catch (error) {
      if (error instanceof StorageError && error.code === "NOT_FOUND") {
        // 파일은 직전 경계 검사에 통과했으므로 exact permission이 사라진
        // 경우를 포함한다. 존재하지 않는 권한을 active로 되살리지 않는다.
        await removeRecord(reserved.recordId).catch((stateError) =>
          console.error("[share] 사라진 권한 장부 정리 실패", stateError),
        );
        throw error;
      }
      const definitelyUnchanged =
        error instanceof StorageError &&
        (error.code === "CONFLICT" ||
          error.code === "BAD_ID");
      if (definitelyUnchanged) {
        let shouldRevoke = false;
        try {
          shouldRevoke = await mutate((file) => {
            const item = file.permissions.find(
              (permission) => permission.recordId === reserved.recordId,
            );
            if (
              !item ||
              item.updateOperation?.operationId !== operationId
            ) {
              return false;
            }
            item.role = reserved.updateOperation!.previousRole;
            item.updateOperation = null;
            item.state = item.revokeRequested ? "recovery" : "active";
            item.updatedAt = new Date().toISOString();
            return item.revokeRequested;
          });
        } catch (stateError) {
          console.error("[share] 권한 변경 예약 복구 실패", stateError);
        }
        if (shouldRevoke) {
          await deleteRecordUnlocked(reserved.recordId).catch((cleanupError) =>
            console.error("[share] 변경 실패 뒤 권한 회수 실패", cleanupError),
          );
        }
      } else {
        // 결과가 불확실하면 목표 역할과 정확한 permissionId가 든 recovery를
        // 그대로 노출한다. 이메일 추정 삭제나 낙관적 롤백은 하지 않는다.
        const latest = await readFile().catch(() => null);
        const needsRevoke = latest?.data.permissions.find(
          (item) => item.recordId === reserved.recordId,
        )?.revokeRequested;
        if (needsRevoke) {
          await deleteRecordUnlocked(reserved.recordId, operationId).catch(
            (cleanupError) =>
              console.error("[share] 변경 불확실 권한 회수 실패", cleanupError),
          );
        }
      }
      throw error;
    }

    try {
      const finalized = await mutate((file) => {
        const item = file.permissions.find(
          (permission) => permission.recordId === reserved.recordId,
        );
        if (
          !item ||
          item.updateOperation?.operationId !== operationId
        ) {
          throw new StorageError("CONFLICT", "권한 변경 예약이 바뀌었습니다");
        }
        item.role = updated.role;
        item.updateOperation = null;
        item.state = item.revokeRequested ? "recovery" : "active";
        item.updatedAt = new Date().toISOString();
        return { permission: toPublic(item), revoke: item.revokeRequested };
      });
      if (finalized.revoke) {
        await deleteRecordUnlocked(reserved.recordId);
        throw new StorageError("NOT_FOUND", "승인된 사용자가 아닙니다");
      }
      return finalized.permission;
    } catch (error) {
      // 외부 PATCH는 이미 성공했으므로 이전 역할로 되돌리지 않는다. 예약
      // 장부가 목표 역할/recovery를 유지해 관리자가 정확한 ID로 회수할 수 있다.
      const latest = await readFile().catch(() => null);
      const needsRevoke = latest?.data.permissions.find(
        (item) => item.recordId === reserved.recordId,
      )?.revokeRequested;
      if (needsRevoke) {
        await deleteRecordUnlocked(reserved.recordId, operationId).catch(
          (cleanupError) =>
            console.error("[share] 변경 완료 뒤 권한 회수 실패", cleanupError),
        );
      }
      throw error;
    }
  });
}

export async function deleteDrivePermission(input: {
  fileId: string;
  permissionId: string;
}): Promise<void> {
  return withFileWrite(input.fileId, async () => {
    const before = await readFile();
    const record = findByPublicPermissionId(
      before.data,
      input.fileId,
      input.permissionId,
    );
    if (!record) {
      throw new StorageError("NOT_FOUND", "ShareDesk가 만든 권한이 아닙니다");
    }
    await deleteRecordUnlocked(record.recordId);
  });
}

export async function revokeDrivePermissionsForTargetUser(
  targetUserId: string,
): Promise<{ revoked: number; failed: number }> {
  const stored = await readFile();
  const targets = stored.data.permissions.filter(
    (item) => item.targetUserId === targetUserId,
  );
  const failedRecordIds = new Set<string>();
  await Promise.all(
    targets.map(async (item) => {
      try {
        await withFileWrite(item.fileId, () =>
          deleteRecordUnlocked(item.recordId),
        );
      } catch (error) {
        failedRecordIds.add(item.recordId);
        console.error("[share] 사용자 권한 회수 실패", {
          targetUserId,
          fileId: item.fileId,
          permissionId: item.permissionId,
          error,
        });
      }
    }),
  );
  // 생성 중 레코드는 회수 요청만 표시하고 생성 요청이 마무리한다. 아직 장부에
  // 남아 있다면 삭제 API가 사용자를 없애지 않고 다음 회수를 안내하도록 실패로 센다.
  const remaining = (await readFile()).data.permissions.filter(
    (item) => item.targetUserId === targetUserId,
  );
  for (const item of remaining) failedRecordIds.add(item.recordId);
  const failed = failedRecordIds.size;
  return { revoked: Math.max(0, targets.length - failed), failed };
}

/**
 * Prunes ShareDesk share records whose files are no longer addressable.
 * Only an exact, recorded permissionId is ever deleted; ambiguous email-only
 * recovery records are deliberately retained for manual inspection.
 */
async function pruneTrackedPermissions(
  candidates: StoredPermission[],
): Promise<{
  pruned: number;
  failed: number;
}> {
  const failedRecordIds = new Set<string>();
  let pruned = 0;
  for (const candidate of candidates) {
    if (!candidate.permissionId) {
      failedRecordIds.add(candidate.recordId);
      continue;
    }
    try {
      const removed = await withFileWrite(candidate.fileId, async () => {
        const latest = (await readFile()).data.permissions.find(
          (item) => item.recordId === candidate.recordId,
        );
        if (!latest) return false;
        if (!latest.permissionId) {
          failedRecordIds.add(candidate.recordId);
          return false;
        }
        await deleteTrackedExternal(latest);
        await removeRecord(latest.recordId);
        return true;
      });
      if (removed) pruned += 1;
    } catch (error) {
      failedRecordIds.add(candidate.recordId);
      console.error("[share] 완전 삭제된 파일의 공유 장부 정리 실패", {
        fileId: candidate.fileId,
        permissionId: candidate.permissionId,
        error,
      });
    }
  }

  return { pruned, failed: failedRecordIds.size };
}

/** Cleans only files the caller has just permanently deleted. */
export async function pruneDrivePermissionsForFiles(
  fileIds: readonly string[],
): Promise<{ pruned: number; failed: number }> {
  const affected = new Set(fileIds);
  if (affected.size === 0) return { pruned: 0, failed: 0 };
  const snapshot = (await readFile()).data.permissions.filter((item) =>
    affected.has(item.fileId),
  );
  return pruneTrackedPermissions(snapshot);
}

export async function pruneMissingDrivePermissions(): Promise<{
  pruned: number;
  failed: number;
}> {
  const adapter = getAdapter();
  const snapshot = (await readFile()).data.permissions;
  const missingFileIds = new Set<string>();
  const failedRecordIds = new Set<string>();

  for (const fileId of new Set(snapshot.map((item) => item.fileId))) {
    try {
      await adapter.getEntry(fileId);
    } catch (error) {
      if (error instanceof StorageError && error.code === "NOT_FOUND") {
        missingFileIds.add(fileId);
      } else {
        for (const item of snapshot) {
          if (item.fileId === fileId) failedRecordIds.add(item.recordId);
        }
      }
    }
  }

  const result = await pruneTrackedPermissions(
    snapshot.filter((candidate) => missingFileIds.has(candidate.fileId)),
  );
  return {
    pruned: result.pruned,
    failed: result.failed + failedRecordIds.size,
  };
}
