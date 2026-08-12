import { randomUUID } from "node:crypto";
import {
  createDrivePermission,
  deleteDrivePermission,
  getDriveSharing,
  pruneDrivePermissionsForFiles,
  updateDrivePermission,
} from "../src/lib/drive-shares";
import { getAdapter } from "../src/lib/storage";
import { ROOT_ID, type ShareRole } from "../src/lib/storage/types";
import { isAdminEmail, listUsers, normalizeEmail } from "../src/lib/users";

const DRIVE_API = "https://www.googleapis.com/drive/v3";

interface DrivePermission {
  id: string;
  type?: string;
  emailAddress?: string;
  role?: string;
  permissionDetails?: Array<{ inherited?: boolean }>;
}

interface LedgerPermission {
  permissionId?: string | null;
  state?: string;
  fileId?: string;
  targetUserId?: string;
  role?: string;
}

interface LedgerFile {
  permissions?: LedgerPermission[];
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 환경 변수가 필요합니다`);
  return value;
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function accessToken(): Promise<string> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: required("GOOGLE_CLIENT_ID"),
      client_secret: required("GOOGLE_CLIENT_SECRET"),
      refresh_token: required("GOOGLE_REFRESH_TOKEN"),
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    throw new Error(`Google 토큰 발급 실패 (${response.status})`);
  }
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("Google access token이 없습니다");
  return body.access_token;
}

async function listPermissions(
  token: string,
  fileId: string,
): Promise<DrivePermission[]> {
  const permissions: DrivePermission[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      fields:
        "nextPageToken,permissions(id,type,emailAddress,role,permissionDetails(inherited))",
      pageSize: "100",
      supportsAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}/permissions?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      throw new Error(`Google 권한 조회 실패 (${response.status})`);
    }
    const body = (await response.json()) as {
      nextPageToken?: string;
      permissions?: DrivePermission[];
    };
    permissions.push(...(body.permissions ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken);
  return permissions;
}

function verifyPermission(
  permissions: DrivePermission[],
  permissionId: string,
  targetEmail: string,
  role: ShareRole,
): void {
  const permission = permissions.find((item) => item.id === permissionId);
  ensure(permission, "검증용 직접 권한을 조회하지 못했습니다");
  ensure(permission.type === "user", "검증용 권한 유형이 올바르지 않습니다");
  ensure(permission.role === role, `검증용 권한이 ${role}로 반영되지 않았습니다`);
  ensure(
    normalizeEmail(permission.emailAddress ?? "") === targetEmail,
    "검증용 권한의 대상 계정이 일치하지 않습니다",
  );
  ensure(
    !permission.permissionDetails?.every((detail) => detail.inherited === true),
    "검증용 권한이 직접 권한이 아닙니다",
  );
}

async function verifyLedger(
  fileId: string,
  permissionId: string,
  targetUserId: string,
  role: ShareRole | null,
): Promise<void> {
  const ledger = await getAdapter().readStateVersioned<LedgerFile>(
    "drive-shares.json",
  );
  const record = (ledger.value?.permissions ?? []).find(
    (item) =>
      item.fileId === fileId && item.permissionId === permissionId,
  );
  if (role === null) {
    ensure(!record, "회수한 권한이 drive-shares.json 장부에 남아 있습니다");
    return;
  }
  ensure(record, "공유 권한이 drive-shares.json 장부에 없습니다");
  ensure(record.state === "active", "공유 권한 장부가 active 상태가 아닙니다");
  ensure(
    record.targetUserId === targetUserId,
    "공유 권한 장부의 대상 사용자가 일치하지 않습니다",
  );
  ensure(record.role === role, `공유 권한 장부가 ${role}로 반영되지 않았습니다`);
}

async function verifySharingSnapshot(
  fileId: string,
  adminUserId: string,
  permissionId: string,
  targetUserId: string,
  role: ShareRole | null,
): Promise<void> {
  const snapshot = await getDriveSharing(fileId, adminUserId);
  const permission = snapshot.permissions.find(
    (item) => item.permissionId === permissionId,
  );
  if (role === null) {
    ensure(!permission, "회수한 권한이 ShareDesk 공유 조회에 남아 있습니다");
    return;
  }
  ensure(permission, "ShareDesk 공유 조회에서 권한을 찾지 못했습니다");
  ensure(permission.targetUserId === targetUserId, "공유 대상 사용자가 다릅니다");
  ensure(permission.role === role, `ShareDesk 공유 조회가 ${role}가 아닙니다`);
  ensure(permission.state === "active", "ShareDesk 공유 권한이 active 상태가 아닙니다");
}

async function main() {
  if (!process.argv.includes("--live")) {
    throw new Error("실제 Drive 공유 검증은 --live 옵션을 붙여 실행하세요");
  }
  if (process.env.STORAGE_DRIVER !== "drive") {
    throw new Error("STORAGE_DRIVER=drive 환경에서만 실행할 수 있습니다");
  }

  const targetEmail = normalizeEmail(required("SHAREDESK_SHARE_TEST_EMAIL"));
  const users = await listUsers();
  const target = users.find(
    (user) =>
      user.status === "approved" && normalizeEmail(user.email) === targetEmail,
  );
  ensure(
    target,
    "SHAREDESK_SHARE_TEST_EMAIL 계정을 먼저 초대해 승인 사용자로 로그인하세요",
  );
  const admin = users.find(
    (user) => user.status === "approved" && isAdminEmail(user.email),
  );
  ensure(admin, "승인 상태인 관리자 계정으로 ShareDesk에 먼저 로그인하세요");
  ensure(admin.id !== target.id, "관리자와 공유 검증 대상은 서로 다른 계정이어야 합니다");

  const adapter = getAdapter();
  const token = await accessToken();
  let fileId: string | null = null;
  let permissionId: string | null = null;
  let permissionRevoked = false;
  let verificationError: unknown = null;

  try {
    const content = new TextEncoder().encode("ShareDesk Drive sharing check\n");
    const file = await adapter.upload(
      ROOT_ID,
      `[ShareDesk sharing check] ${randomUUID()}.txt`,
      "text/plain",
      new Blob([content]).stream(),
    );
    fileId = file.id;

    const initial = await getDriveSharing(file.id, admin.id);
    ensure(
      initial.users.some((user) => user.id === target.id),
      "승인 사용자가 ShareDesk 공유 대상 목록에 없습니다",
    );
    ensure(initial.permissions.length === 0, "새 검증 파일의 공유 장부가 비어 있지 않습니다");

    const before = await listPermissions(token, file.id);
    ensure(
      !before.some(
        (permission) =>
          permission.type === "user" &&
          normalizeEmail(permission.emailAddress ?? "") === targetEmail,
      ),
      "검증 계정이 이미 상속되거나 직접 부여된 권한을 가지고 있습니다",
    );

    const created = await createDrivePermission({
      fileId: file.id,
      targetUserId: target.id,
      role: "reader",
      sendNotificationEmail: false,
      createdByUserId: admin.id,
    });
    permissionId = created.permissionId;
    ensure(created.role === "reader", "reader 권한 생성 응답이 올바르지 않습니다");
    await verifySharingSnapshot(
      file.id,
      admin.id,
      permissionId,
      target.id,
      "reader",
    );
    await verifyLedger(file.id, permissionId, target.id, "reader");
    verifyPermission(
      await listPermissions(token, file.id),
      permissionId,
      targetEmail,
      "reader",
    );

    const updated = await updateDrivePermission({
      fileId: file.id,
      permissionId,
      role: "writer",
    });
    ensure(updated.role === "writer", "writer 권한 변경 응답이 올바르지 않습니다");
    await verifySharingSnapshot(
      file.id,
      admin.id,
      permissionId,
      target.id,
      "writer",
    );
    await verifyLedger(file.id, permissionId, target.id, "writer");
    verifyPermission(
      await listPermissions(token, file.id),
      permissionId,
      targetEmail,
      "writer",
    );

    await deleteDrivePermission({ fileId: file.id, permissionId });
    permissionRevoked = true;
    await verifySharingSnapshot(
      file.id,
      admin.id,
      permissionId,
      target.id,
      null,
    );
    await verifyLedger(file.id, permissionId, target.id, null);
    ensure(
      !(await listPermissions(token, file.id)).some(
        (permission) => permission.id === permissionId,
      ),
      "회수한 검증용 권한이 Google Drive에 남아 있습니다",
    );

    console.info(
      "PASS: 승인 사용자/관리자 고수준 공유 흐름, Google 직접 권한, drive-shares 장부",
    );
    console.info(
      "MANUAL / UNVERIFIED: 받는 사람 Google Drive의 'Shared with me(공유 문서함)' UI 표시는 별도 계정에서 직접 확인해야 합니다.",
    );
  } catch (error) {
    verificationError = error;
  } finally {
    let permissionCleanupError: unknown = null;
    let fileCleanupError: unknown = null;
    if (fileId && permissionId && !permissionRevoked) {
      try {
        await deleteDrivePermission({ fileId, permissionId });
        permissionRevoked = true;
      } catch (error) {
        permissionCleanupError = error;
      }
    }
    if (fileId) {
      try {
        await adapter.remove(fileId);
        const entry = (await adapter.listTrash()).find(
          (item) => item.id === fileId,
        );
        if (!entry) throw new Error("검증용 파일이 휴지통에 없습니다");
        const deletedFileId = await adapter.purge(fileId, entry.version);
        const pruned = await pruneDrivePermissionsForFiles([deletedFileId]);
        if (pruned.failed > 0) {
          throw new Error(`검증용 공유 장부 ${pruned.failed}개를 정리하지 못했습니다`);
        }
      } catch (error) {
        fileCleanupError = error;
      }
    }
    // 파일 완전 삭제가 끝났다면 그 파일의 권한도 Google에서 함께 사라진다.
    const cleanupFailed = fileCleanupError ?? (!fileId && permissionCleanupError);
    if (cleanupFailed) {
      const cleanupError = new Error("검증용 Drive 항목을 완전히 정리하지 못했습니다");
      if (!verificationError) verificationError = cleanupError;
      else console.error(cleanupError.message);
    } else if (fileId) {
      console.info("PASS: 검증용 Drive 파일, 정확한 permission ID, 공유 장부 정리");
    }
  }

  if (verificationError) throw verificationError;
}

void main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Drive 공유 검증에 실패했습니다",
  );
  process.exitCode = 1;
});
