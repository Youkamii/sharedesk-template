import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const SESSION_SECRET = "integration-session-secret-with-32-characters";

function session(userId: string): string {
  const body = Buffer.from(
    JSON.stringify({
      t: "user",
      sub: userId,
      iat: Math.floor(Date.now() / 1000),
    }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET)
    .update(Buffer.from(body, "base64url"))
    .digest("base64url");
  return `${body}.${signature}`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("테스트 포트를 만들지 못했습니다"));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolve(address.port),
      );
    });
  });
}

async function waitForServer(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Next 테스트 서버가 종료됐습니다 (${child.exitCode})`);
    }
    try {
      const response = await fetch(origin, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // 서버가 포트를 열 때까지 짧게 다시 확인한다.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Next 테스트 서버가 준비되지 않았습니다");
}

test("관리자 초대 API 권한과 상태 변경", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-invite-api-"));
  const stateDir = path.join(root, ".sharedesk");
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(root, "report.txt"), "공유 API 검증", "utf8");
  await writeFile(
    path.join(root, "trash-warning.txt"),
    "휴지통 정리 경고 검증",
    "utf8",
  );
  await writeFile(
    path.join(stateDir, "users.json"),
    JSON.stringify({
      version: 2,
      rev: 1,
      users: [
        {
          id: "admin-sub",
          email: "admin@example.com",
          name: "관리자",
          status: "approved",
          isAdmin: true,
          createdAt: "2026-08-01T00:00:00.000Z",
          invitationId: null,
          sessionsValidFrom: 0,
          sessions: [
            {
              id: "admin-device-session-00000000000000001",
              createdAt: "2026-08-01T01:00:00.000Z",
              deviceLabel: "Chrome · Windows",
            },
          ],
        },
        {
          id: "member-sub",
          email: "member@example.com",
          name: "일반 사용자",
          status: "approved",
          isAdmin: false,
          createdAt: "2026-08-02T00:00:00.000Z",
          invitationId: null,
          sessionsValidFrom: 0,
          sessions: [
            {
              id: "member-device-session-0000000000000001",
              createdAt: "2026-08-02T01:00:00.000Z",
              deviceLabel: "Chrome · Windows",
            },
          ],
        },
      ],
      invitations: [],
    }),
    "utf8",
  );

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const nextBin = path.join(
    process.cwd(),
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );
  const child = spawn(process.execPath, [nextBin, "dev", "-p", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_ROOT: root,
      SESSION_SECRET,
      ADMIN_EMAILS: "admin@example.com",
      PUBLIC_BASE_URL: origin,
      ACCESS_KEYS: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  });

  await waitForServer(origin, child);

  const unauthorized = await fetch(`${origin}/api/admin/invitations`);
  assert.equal(unauthorized.status, 401);

  const forbidden = await fetch(`${origin}/api/admin/invitations`, {
    headers: { Cookie: `sharedesk_session=${session("member-sub")}` },
  });
  assert.equal(forbidden.status, 403);

  const adminCookie = `sharedesk_session=${session("admin-sub")}`;
  const unauthorizedSessionRevoke = await fetch(`${origin}/api/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: "member-sub",
      action: "revoke-session",
      sessionId: "member-device-session-0000000000000001",
    }),
  });
  assert.equal(unauthorizedSessionRevoke.status, 401);
  const forbiddenSessionRevoke = await fetch(`${origin}/api/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `sharedesk_session=${session("member-sub")}`,
    },
    body: JSON.stringify({
      id: "member-sub",
      action: "revoke-session",
      sessionId: "member-device-session-0000000000000001",
    }),
  });
  assert.equal(forbiddenSessionRevoke.status, 403);

  const listedUsers = await fetch(`${origin}/api/admin/users`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(listedUsers.status, 200);
  const listedMember = (
    (await listedUsers.json()) as {
      users: Array<{ id: string; sessions: Array<{ id: string }> }>;
    }
  ).users.find((user) => user.id === "member-sub");
  assert.equal(
    listedMember?.sessions[0]?.id,
    "member-device-session-0000000000000001",
  );

  const revokedSession = await fetch(`${origin}/api/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({
      id: "member-sub",
      action: "revoke-session",
      sessionId: "member-device-session-0000000000000001",
    }),
  });
  assert.equal(revokedSession.status, 200);
  assert.deepEqual(
    ((await revokedSession.json()) as { user: { sessions: unknown[] } }).user
      .sessions,
    [],
  );
  const protectedAdminSession = await fetch(`${origin}/api/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({
      id: "admin-sub",
      action: "revoke-session",
      sessionId: "admin-device-session-00000000000000001",
    }),
  });
  assert.equal(protectedAdminSession.status, 400);
  assert.match(
    ((await protectedAdminSession.json()) as { error: string }).error,
    /관리자 계정의 세션은 끊을 수 없습니다/,
  );

  const created = await fetch(`${origin}/api/admin/invitations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({
      recipientName: "초대 사용자",
      email: "invitee@example.com",
      note: "프로젝트 영상 공유",
      active: true,
    }),
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as {
    invitation: { id: string; state: string; link: string; note: string };
  };
  assert.equal(createdBody.invitation.state, "active");
  assert.equal(createdBody.invitation.note, "프로젝트 영상 공유");
  assert.match(createdBody.invitation.link, new RegExp(`^${origin}/i/`));

  const disabled = await fetch(`${origin}/api/admin/invitations`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({
      id: createdBody.invitation.id,
      action: "update",
      active: false,
    }),
  });
  assert.equal(disabled.status, 200);
  assert.equal(
    ((await disabled.json()) as { invitation: { state: string } }).invitation
      .state,
    "inactive",
  );

  const fileId = Buffer.from("report.txt", "utf8").toString("base64url");
  const unauthorizedShare = await fetch(
    `${origin}/api/drive/share?id=${fileId}`,
  );
  assert.equal(unauthorizedShare.status, 401);
  const forbiddenShare = await fetch(
    `${origin}/api/drive/share?id=${fileId}`,
    { headers: { Cookie: `sharedesk_session=${session("member-sub")}` } },
  );
  assert.equal(forbiddenShare.status, 403);

  const share = await fetch(`${origin}/api/drive/share`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({
      id: fileId,
      targetUserId: "member-sub",
      role: "reader",
      sendNotificationEmail: false,
    }),
  });
  assert.equal(share.status, 201);
  const shared = (await share.json()) as {
    permission: { permissionId: string; role: string; email: string };
  };
  assert.equal(shared.permission.role, "reader");
  assert.equal(shared.permission.email, "member@example.com");

  const changed = await fetch(`${origin}/api/drive/share`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({
      id: fileId,
      permissionId: shared.permission.permissionId,
      role: "writer",
    }),
  });
  assert.equal(changed.status, 200);
  assert.equal(
    ((await changed.json()) as { permission: { role: string } }).permission.role,
    "writer",
  );

  const deleted = await fetch(`${origin}/api/drive/share`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({
      id: fileId,
      permissionId: shared.permission.permissionId,
    }),
  });
  assert.equal(deleted.status, 200);

  const warningFileId = Buffer.from("trash-warning.txt", "utf8").toString(
    "base64url",
  );
  const warningShare = await fetch(`${origin}/api/drive/share`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({
      id: warningFileId,
      targetUserId: "member-sub",
      role: "reader",
    }),
  });
  assert.equal(warningShare.status, 201);
  const warningPermissionId = (
    (await warningShare.json()) as { permission: { permissionId: string } }
  ).permission.permissionId;
  const movedToTrash = await fetch(`${origin}/api/drive/delete`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({ id: warningFileId }),
  });
  assert.equal(movedToTrash.status, 200);
  const trashList = await fetch(`${origin}/api/drive/trash`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(trashList.status, 200);
  const warningTrashEntry = (
    (await trashList.json()) as {
      entries: Array<{ id: string; name: string; version: string }>;
    }
  ).entries.find((entry) => entry.name === "trash-warning.txt");
  assert.ok(warningTrashEntry);
  const missingTrashVersion = await fetch(`${origin}/api/drive/trash`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({ action: "purge", id: warningTrashEntry.id }),
  });
  assert.equal(missingTrashVersion.status, 400);
  const staleTrashVersion = await fetch(`${origin}/api/drive/trash`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({
      action: "purge",
      id: warningTrashEntry.id,
      version: "stale-version",
    }),
  });
  assert.equal(staleTrashVersion.status, 409);

  const shareLedgerPath = path.join(stateDir, "drive-shares.json");
  const shareLedger = JSON.parse(await readFile(shareLedgerPath, "utf8")) as {
    rev: number;
    permissions: Array<{ recordId: string; permissionId: string | null }>;
  };
  const warningRecord = shareLedger.permissions.find(
    (permission) => permission.permissionId === warningPermissionId,
  );
  assert.ok(warningRecord);
  warningRecord.permissionId = null;
  shareLedger.rev += 1;
  await writeFile(shareLedgerPath, JSON.stringify(shareLedger), "utf8");

  const purgedWithWarning = await fetch(`${origin}/api/drive/trash`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({
      action: "purge",
      id: warningTrashEntry.id,
      version: warningTrashEntry.version,
    }),
  });
  assert.equal(purgedWithWarning.status, 200);
  const purgeBody = (await purgedWithWarning.json()) as {
    ok: boolean;
    shareCleanup: { pruned: number; failed: number };
    warning: string | null;
  };
  assert.equal(purgeBody.ok, true);
  assert.deepEqual(purgeBody.shareCleanup, { pruned: 0, failed: 1 });
  assert.match(purgeBody.warning ?? "", /파일은 삭제됐지만 공유 장부 1건/);
  const ledgerAfterWarning = JSON.parse(
    await readFile(shareLedgerPath, "utf8"),
  ) as {
    rev: number;
    permissions: Array<{ recordId: string; permissionId: string | null }>;
  };
  ledgerAfterWarning.permissions = ledgerAfterWarning.permissions.filter(
    (permission) => permission.recordId !== warningRecord.recordId,
  );
  ledgerAfterWarning.rev += 1;
  await writeFile(
    shareLedgerPath,
    JSON.stringify(ledgerAfterWarning),
    "utf8",
  );

  const sharedAgain = await fetch(`${origin}/api/drive/share`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({
      id: fileId,
      targetUserId: "member-sub",
      role: "reader",
    }),
  });
  assert.equal(sharedAgain.status, 201);

  const blocked = await fetch(`${origin}/api/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({ id: "member-sub", action: "block" }),
  });
  assert.equal(blocked.status, 200);
  assert.equal(
    ((await blocked.json()) as { warning: string | null }).warning,
    null,
  );
  const afterBlock = await fetch(`${origin}/api/drive/share?id=${fileId}`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(afterBlock.status, 200);
  assert.deepEqual(
    ((await afterBlock.json()) as { permissions: unknown[] }).permissions,
    [],
  );

  // 직전 GET이 승인 상태를 캐시에 올린 뒤 저장 파일을 외부에서 바꾼 상황을 재현한다.
  // 쓰기 API는 캐시가 남아 있어도 최신 차단 상태를 읽어야 한다.
  const usersPath = path.join(stateDir, "users.json");
  const state = JSON.parse(await readFile(usersPath, "utf8")) as {
    rev: number;
    users: Array<{ id: string; status: string }>;
  };
  const admin = state.users.find((user) => user.id === "admin-sub");
  assert.ok(admin);
  admin.status = "blocked";
  state.rev += 1;
  await writeFile(usersPath, JSON.stringify(state), "utf8");

  const rejectedMutation = await fetch(`${origin}/api/drive/mkdir`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: "{}",
  });
  assert.equal(rejectedMutation.status, 401);

  const rejectedAdminMutation = await fetch(
    `${origin}/api/admin/invitations`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: "{}",
    },
  );
  assert.equal(rejectedAdminMutation.status, 401);
});
