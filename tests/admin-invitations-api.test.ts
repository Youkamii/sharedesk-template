import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import test from "node:test";

const SESSION_SECRET = "integration-session-secret-with-32-characters";

test("관리자 초대 폼은 받는 사람 정보 없이 기간과 사용 방식을 고른다", async () => {
  const source = await readFile(
    new URL("../src/app/admin/AdminView.tsx", import.meta.url),
    "utf8",
  );
  const inviteSection = source.match(
    /<section aria-labelledby="invite-title">([\s\S]*?)<section aria-labelledby="user-title">/,
  )?.[1];
  assert.ok(inviteSection);

  assert.match(inviteSection, /<span>유효 기간<\/span>/);
  for (const minutes of [60, "1_440", "10_080", "43_200"]) {
    assert.match(inviteSection, new RegExp(`<option value=\\{${minutes}\\}>`));
  }
  assert.match(inviteSection, /<span>사용 방식<\/span>/);
  assert.match(inviteSection, /<option value="once">1회용<\/option>/);
  assert.match(
    inviteSection,
    /<option value="unlimited">기간 내 무제한<\/option>/,
  );
  assert.match(inviteSection, /받는 사람을 미리 지정하지 않습니다/);
  assert.match(inviteSection, /사용 기록/);
  assert.match(inviteSection, /초대 코드 생성/);
  assert.doesNotMatch(inviteSection, /<span>(이름|Google 이메일|비고)<\/span>/);
  assert.doesNotMatch(inviteSection, /정보 수정/);
});

test("관리자 화면은 도트 도구 스타일과 접근 가능한 스크롤 영역을 쓴다", async () => {
  const [source, css] = await Promise.all([
    readFile(
      new URL("../src/app/admin/AdminView.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/admin/admin.module.css", import.meta.url),
      "utf8",
    ),
  ]);

  assert.match(source, /import styles from "\.\/admin\.module\.css"/);
  assert.match(css, /--admin-night:\s*#10172b/);
  assert.match(css, /--admin-window:\s*#f4e7c5/);
  assert.match(css, /--admin-amber:\s*#ffd27d/);
  assert.match(css, /--admin-teal:\s*#61b3a6/);
  assert.match(css, /radial-gradient/);
  assert.match(css, /font-family:\s*var\(--font-geist-sans\)/);
  assert.match(css, /font-family:\s*var\(--font-pixel\)/);
  assert.match(css, /border:\s*2px solid/);
  assert.match(css, /:focus-visible/);

  assert.match(css, /\.page\s*\{[\s\S]*?overflow-x:\s*clip/);
  assert.match(css, /\.tableRegion\s*\{[\s\S]*?overflow-x:\s*auto/);
  assert.equal(css.match(/overflow-x:\s*auto/g)?.length, 1);
  assert.equal(source.match(/className=\{styles\.tableRegion\}/g)?.length, 2);

  assert.match(source, /role="status"[\s\S]*?aria-live="polite"/);
  assert.match(source, /role="alert"[\s\S]*?aria-live="assertive"/);
  assert.equal(source.match(/role="region"/g)?.length, 2);
  assert.equal(source.match(/tabIndex=\{0\}/g)?.length, 2);
  assert.match(source, /aria-labelledby="invite-title"/);
  assert.match(source, /aria-labelledby="user-title"/);
  assert.equal(source.match(/<caption className=\{styles\.srOnly\}>/g)?.length, 2);
});

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

test("관리자 초대 코드 API 권한과 상태 변경", async (t) => {
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
      invitations: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          recipientName: "만료된 초대",
          email: "expired@example.com",
          note: "만료 상태 검증",
          active: true,
          tokenVersion: 1,
          createdAt: "2000-01-01T00:00:00.000Z",
          updatedAt: "2000-01-01T00:00:00.000Z",
          createdByUserId: "admin-sub",
          createdByEmail: "admin@example.com",
          usedAt: null,
          usedByUserId: null,
          usedByEmail: null,
          durationMinutes: 60,
          expiresAt: "2000-01-01T01:00:00.000Z",
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          active: true,
          tokenVersion: 1,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z",
          createdByUserId: "admin-sub",
          createdByEmail: "admin@example.com",
          usedAt: "2026-08-02T00:00:00.000Z",
          usedByUserId: "member-sub",
          usedByEmail: "member@example.com",
          durationMinutes: 10_080,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          active: true,
          tokenVersion: 1,
          createdAt: "2026-08-03T00:00:00.000Z",
          updatedAt: "2026-08-04T00:00:00.000Z",
          createdByUserId: "admin-sub",
          createdByEmail: "admin@example.com",
          usageMode: "unlimited",
          usageCount: 3,
          lastUsedAt: "2026-08-04T00:00:00.000Z",
          lastUsedByUserId: "member-sub",
          lastUsedByEmail: "member@example.com",
          durationMinutes: 43_200,
          expiresAt: "2099-02-01T00:00:00.000Z",
        },
      ],
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
  const listedInvitations = await fetch(`${origin}/api/admin/invitations`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(listedInvitations.status, 200);
  const listedBody = (await listedInvitations.json()) as {
    invitations: Array<{
      id: string;
      state: string;
      code: string | null;
      expiresAt: string;
      durationMinutes: number;
      usageMode: "once" | "unlimited";
      usageCount: number;
      lastUsedAt: string | null;
      lastUsedByEmail: string | null;
    }>;
  };
  const expiredInvitation = listedBody.invitations.find(
    (invitation) => invitation.id === "11111111-1111-4111-8111-111111111111",
  );
  assert.ok(expiredInvitation);
  assert.equal("recipientName" in expiredInvitation, false);
  assert.equal("email" in expiredInvitation, false);
  assert.equal("note" in expiredInvitation, false);
  assert.equal(expiredInvitation.state, "expired");
  assert.equal(expiredInvitation.code, null);
  assert.equal(expiredInvitation.expiresAt, "2000-01-01T01:00:00.000Z");
  assert.equal(expiredInvitation.durationMinutes, 60);
  const usedInvitation = listedBody.invitations.find(
    (invitation) => invitation.id === "22222222-2222-4222-8222-222222222222",
  );
  assert.ok(usedInvitation);
  assert.equal(usedInvitation.state, "used");
  assert.equal(usedInvitation.code, null);
  assert.equal(usedInvitation.usageMode, "once");
  assert.equal(usedInvitation.usageCount, 1);
  assert.equal(usedInvitation.lastUsedByEmail, "member@example.com");
  const unlimitedInvitation = listedBody.invitations.find(
    (invitation) => invitation.id === "33333333-3333-4333-8333-333333333333",
  );
  assert.ok(unlimitedInvitation);
  assert.equal(unlimitedInvitation.state, "active");
  assert.equal(unlimitedInvitation.usageMode, "unlimited");
  assert.equal(unlimitedInvitation.usageCount, 3);
  assert.equal(unlimitedInvitation.lastUsedAt, "2026-08-04T00:00:00.000Z");
  assert.equal(unlimitedInvitation.lastUsedByEmail, "member@example.com");
  assert.ok(unlimitedInvitation.code);
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

  const manualApproval = await fetch(`${origin}/api/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({ id: "member-sub", action: "approve" }),
  });
  assert.equal(
    manualApproval.status,
    400,
    "관리자는 기간제 코드를 건너뛰고 사용자를 수동 승인할 수 없다",
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
      expiresInMinutes: 60,
      usageMode: "once",
    }),
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as {
    invitation: {
      id: string;
      state: string;
      code: string;
      expiresAt: string;
      durationMinutes: number;
      usageMode: "once" | "unlimited";
      usageCount: number;
      lastUsedAt: string | null;
      lastUsedByEmail: string | null;
    };
  };
  assert.equal(createdBody.invitation.state, "active");
  assert.equal("recipientName" in createdBody.invitation, false);
  assert.equal("email" in createdBody.invitation, false);
  assert.equal("note" in createdBody.invitation, false);
  assert.equal("active" in createdBody.invitation, false);
  assert.equal("updatedAt" in createdBody.invitation, false);
  assert.equal("createdByUserId" in createdBody.invitation, false);
  assert.equal("usedByUserId" in createdBody.invitation, false);
  assert.equal("lastUsedByUserId" in createdBody.invitation, false);
  assert.ok(createdBody.invitation.code.length > 0);
  assert.equal(createdBody.invitation.durationMinutes, 60);
  assert.equal(createdBody.invitation.usageMode, "once");
  assert.equal(createdBody.invitation.usageCount, 0);
  assert.equal(createdBody.invitation.lastUsedAt, null);
  assert.equal(createdBody.invitation.lastUsedByEmail, null);
  assert.ok(
    Date.parse(createdBody.invitation.expiresAt) > Date.now() + 59 * 60_000,
  );

  const createdUnlimited = await fetch(`${origin}/api/admin/invitations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({
      expiresInMinutes: 10_080,
      usageMode: "unlimited",
    }),
  });
  assert.equal(createdUnlimited.status, 201);
  const createdUnlimitedInvitation = (
    (await createdUnlimited.json()) as {
      invitation: {
        usageMode: "once" | "unlimited";
        usageCount: number;
        state: string;
        code: string;
      };
    }
  ).invitation;
  assert.equal(createdUnlimitedInvitation.usageMode, "unlimited");
  assert.equal(createdUnlimitedInvitation.usageCount, 0);
  assert.equal(createdUnlimitedInvitation.state, "active");
  assert.ok(createdUnlimitedInvitation.code);

  for (const invalidDuration of [undefined, null, "5"]) {
    const invalidCreate = await fetch(`${origin}/api/admin/invitations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify(
        invalidDuration === undefined
          ? {}
          : { expiresInMinutes: invalidDuration, usageMode: "once" },
      ),
    });
    assert.equal(invalidCreate.status, 400);
  }

  for (const invalidUsageMode of [undefined, null, "many", 1]) {
    const invalidCreate = await fetch(`${origin}/api/admin/invitations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify(
        invalidUsageMode === undefined
          ? { expiresInMinutes: 60 }
          : { expiresInMinutes: 60, usageMode: invalidUsageMode },
      ),
    });
    assert.equal(invalidCreate.status, 400);
  }

  for (const unsupportedDuration of [0, 61, 525_600]) {
    const invalidCreate = await fetch(`${origin}/api/admin/invitations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        expiresInMinutes: unsupportedDuration,
        usageMode: "once",
      }),
    });
    assert.equal(invalidCreate.status, 400);
  }

  const emptyUpdate = await fetch(`${origin}/api/admin/invitations`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({
      id: createdBody.invitation.id,
      action: "update",
    }),
  });
  assert.equal(emptyUpdate.status, 400);

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
  const disabledSummary = (await disabled.json()) as {
    invitation: {
      state: string;
      code: string | null;
    };
  };
  assert.equal(disabledSummary.invitation.state, "inactive");
  assert.equal(disabledSummary.invitation.code, null);

  const rotated = await fetch(`${origin}/api/admin/invitations`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Cookie: adminCookie,
    },
    body: JSON.stringify({
      id: createdBody.invitation.id,
      action: "rotate",
    }),
  });
  assert.equal(rotated.status, 200);
  const rotatedInvitation = (
    (await rotated.json()) as {
      invitation: { state: string; code: string; expiresAt: string };
    }
  ).invitation;
  assert.equal(rotatedInvitation.state, "active");
  assert.notEqual(rotatedInvitation.code, createdBody.invitation.code);
  assert.ok(Date.parse(rotatedInvitation.expiresAt) > Date.now() + 59 * 60_000);

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
