import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ROLE_LABELS,
  USER_ROLES,
  canEdit,
  canUpload,
  resolveUserRole,
} from "../src/lib/roles";

test("역할 어휘: 저장 역할 목록·정규화 폴백·능력 표·라벨", () => {
  assert.deepEqual([...USER_ROLES], ["editor", "uploader", "viewer"]);

  for (const role of USER_ROLES) {
    assert.equal(resolveUserRole(role), role, "저장된 정상 역할은 그대로 읽는다");
  }
  for (const junk of [
    undefined,
    null,
    "",
    "admin", // 세션 전용 역할은 저장 역할이 아니다
    "EDITOR",
    "owner",
    0,
    true,
    {},
    ["editor"],
  ]) {
    assert.equal(
      resolveUserRole(junk),
      "editor",
      `USER_ROLES 밖 값은 editor로 폴백한다: ${JSON.stringify(junk)}`,
    );
  }

  // canUpload: admin·editor·uploader / canEdit: admin·editor
  assert.equal(canUpload("admin"), true);
  assert.equal(canUpload("editor"), true);
  assert.equal(canUpload("uploader"), true);
  assert.equal(canUpload("viewer"), false);
  assert.equal(canEdit("admin"), true);
  assert.equal(canEdit("editor"), true);
  assert.equal(canEdit("uploader"), false);
  assert.equal(canEdit("viewer"), false);

  assert.deepEqual(ROLE_LABELS, {
    editor: "수정 가능",
    uploader: "올리기 가능",
    viewer: "보기 전용",
  });
});

function handlerSource(source: string, method: "GET" | "POST" | "PATCH"): string {
  const marker = `export async function ${method}`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${method} 핸들러가 없습니다`);
  const next = source.indexOf("export async function", start + marker.length);
  return next >= 0 ? source.slice(start, next) : source.slice(start);
}

async function routeSource(relative: string): Promise<string> {
  return readFile(new URL(`../src/app/api/${relative}/route.ts`, import.meta.url), "utf8");
}

test("가드 적용: 쓰기 라우트는 역할 가드를, 읽기 라우트는 기존 가드를 쓴다", async () => {
  // 새 항목 생성 계열 → requireUploadRights
  for (const route of ["drive/upload", "drive/upload-session", "drive/mkdir"]) {
    const source = await routeSource(route);
    assert.match(
      handlerSource(source, "POST"),
      /requireUploadRights\(\{ fresh: true \}\)/,
      `${route} POST는 requireUploadRights를 쓴다`,
    );
    assert.doesNotMatch(source, /requireSession/, `${route}에 requireSession이 남아 있다`);
  }

  // 기존 항목 변경 계열 → requireEditRights
  for (const route of ["drive/content", "drive/delete", "drive/move", "drive/rename"]) {
    const source = await routeSource(route);
    assert.match(
      handlerSource(source, route === "drive/content" ? "PATCH" : "POST"),
      /requireEditRights\(\{ fresh: true \}\)/,
      `${route}는 requireEditRights를 쓴다`,
    );
    assert.doesNotMatch(source, /requireSession/, `${route}에 requireSession이 남아 있다`);
  }

  // GET·쓰기가 한 파일에 있는 라우트 — 읽기는 그대로, 쓰기만 교체
  const layout = await routeSource("desktop/layout");
  assert.match(handlerSource(layout, "PATCH"), /requireUploadRights\(\{ fresh: true \}\)/);
  assert.match(handlerSource(layout, "GET"), /requireSession\(\)/);
  assert.doesNotMatch(handlerSource(layout, "GET"), /requireUploadRights|requireEditRights/);

  const trash = await routeSource("drive/trash");
  assert.match(handlerSource(trash, "POST"), /requireEditRights\(\{ fresh: true \}\)/);
  assert.match(handlerSource(trash, "GET"), /requireSession\(\)/);
  assert.doesNotMatch(handlerSource(trash, "GET"), /requireUploadRights|requireEditRights/);

  const folderNote = await routeSource("folder-note");
  assert.match(handlerSource(folderNote, "PATCH"), /requireEditRights\(\{ fresh: true \}\)/);
  assert.match(handlerSource(folderNote, "GET"), /requireSession\(\)/);
  assert.doesNotMatch(handlerSource(folderNote, "GET"), /requireUploadRights|requireEditRights/);

  // 읽기 전용·presence 라우트는 역할 가드를 쓰지 않는다
  for (const route of ["drive/list", "drive/download", "drive/path", "drive/search", "presence"]) {
    const source = await routeSource(route);
    assert.match(source, /requireSession/, `${route}는 기존 requireSession을 유지한다`);
    assert.doesNotMatch(
      source,
      /requireUploadRights|requireEditRights/,
      `${route}에 역할 가드를 넣지 않는다`,
    );
  }

  // 관리자 전용 라우트는 기존 requireAdmin 그대로
  const share = await routeSource("drive/share");
  assert.match(share, /requireAdmin/);
  assert.doesNotMatch(share, /requireUploadRights|requireEditRights/);

  // 가드 헬퍼 본문: 계약 문구의 403
  const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
  assert.match(api, /export async function requireUploadRights/);
  assert.match(api, /export async function requireEditRights/);
  assert.match(api, /이 작업을 할 권한이 없습니다/);
  assert.match(api, /status: 403/);

  // admin/invitations: role 검증·저장·응답 포함
  const invitationsRoute = await routeSource("admin/invitations");
  assert.match(invitationsRoute, /role: invitation\.role/, "summary 응답에 role을 포함한다");
  assert.match(invitationsRoute, /역할 값을 확인해 주세요/, "잘못된 role은 400으로 거절한다");
  assert.match(invitationsRoute, /USER_ROLES/, "USER_ROLES로 검증한다");
});

test("역할 저장: 기본값 폴백·변경 저장·초대 role 적용·세션 역할 계산", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-roles-"));
  const statePath = path.join(root, ".sharedesk", "users.json");
  await mkdir(path.dirname(statePath), { recursive: true });
  const now = Date.now();
  await writeFile(
    statePath,
    JSON.stringify({
      version: 2,
      rev: 1,
      users: [
        {
          id: "admin-sub",
          email: "admin@example.com",
          name: "관리자",
          // 저장값이 무엇이든 ADMIN_EMAILS 세션 역할이 우선함을 확인하는 미끼 값
          role: "viewer",
          status: "approved",
          isAdmin: true,
          createdAt: "2026-08-01T00:00:00.000Z",
          sessionsValidFrom: 0,
        },
        {
          id: "uploader-sub",
          email: "uploader@example.com",
          name: "올리기 담당",
          role: "uploader",
          status: "approved",
          isAdmin: false,
          createdAt: "2026-08-01T00:00:00.000Z",
          sessionsValidFrom: 0,
        },
        {
          id: "legacy-sub",
          email: "legacy@example.com",
          name: "역할 없던 사용자",
          status: "approved",
          isAdmin: false,
          createdAt: "2026-08-01T00:00:00.000Z",
          sessionsValidFrom: 0,
        },
        {
          id: "junk-role-sub",
          email: "junk@example.com",
          name: "이상한 역할 값",
          role: "superuser",
          status: "approved",
          isAdmin: false,
          createdAt: "2026-08-01T00:00:00.000Z",
          sessionsValidFrom: 0,
        },
      ],
      invitations: [
        {
          id: "00000000-0000-4000-8000-00000000ro01",
          active: true,
          tokenVersion: 1,
          usageMode: "unlimited",
          usageCount: 0,
          durationMinutes: 60,
          expiresAt: new Date(now + 60 * 60_000).toISOString(),
          createdAt: new Date(now - 60_000).toISOString(),
          updatedAt: new Date(now - 60_000).toISOString(),
          createdByUserId: "admin-sub",
          createdByEmail: "admin@example.com",
          lastUsedAt: null,
          lastUsedByUserId: null,
          lastUsedByEmail: null,
        },
      ],
    }),
    "utf8",
  );

  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  // 테스트 전용 더미 값. secrets-guard 훅 오탐을 피하려고 조각으로 나눠 조립한다.
  process.env.SESSION_SECRET = ["roles-", "test-session-secret-32-characters"].join("");
  process.env.ADMIN_EMAILS = "admin@example.com";
  process.env.ACCESS_KEYS = "roles-test-guest-key";

  const users = await import("@/lib/users");
  const auth = await import("@/lib/auth");
  const tokens = await import("@/lib/session-token");

  try {
    // 1) 읽기 정규화: role 없던 파일은 editor, 이상한 값도 editor, 저장값은 유지
    const listed = await users.listUsers();
    assert.equal(listed.find((u) => u.id === "legacy-sub")?.role, "editor");
    assert.equal(listed.find((u) => u.id === "junk-role-sub")?.role, "editor");
    assert.equal(listed.find((u) => u.id === "uploader-sub")?.role, "uploader");
    assert.equal(listed.find((u) => u.id === "admin-sub")?.role, "viewer");

    const legacyInvitation = (await users.listInvitations())[0];
    assert.equal(
      legacyInvitation.role,
      "editor",
      "role 없던 기존 초대는 editor로 읽는다",
    );

    // 2) 세션 역할: ADMIN_EMAILS 우선·저장 역할 반영·손님 viewer
    const legacyStyleToken = (sub: string) =>
      tokens.signPayload({ t: "user", sub, iat: Math.floor(Date.now() / 1000) });
    const adminSession = await auth.resolveSession(await legacyStyleToken("admin-sub"), {
      fresh: true,
    });
    assert.equal(
      adminSession?.role,
      "admin",
      "ADMIN_EMAILS 사용자는 저장 역할이 무엇이든 admin이다",
    );
    assert.equal(
      (await auth.resolveSession(await legacyStyleToken("uploader-sub"), { fresh: true }))?.role,
      "uploader",
    );
    // 접속 키 손님: 로컬 모드는 개인 사용이라 수정 가능, 운영(drive)은 보기 전용.
    const guestToken = await auth.createKeySession(
      await tokens.sha256Hex("roles-test-guest-key"),
    );
    const localGuest = await auth.resolveSession(guestToken);
    assert.equal(localGuest?.isGuest, true);
    assert.equal(
      localGuest?.role,
      "editor",
      "local 모드의 접속 키는 개인 사용이라 수정 가능이다",
    );
    process.env.STORAGE_DRIVER = "drive";
    try {
      const driveGuest = await auth.resolveSession(guestToken);
      assert.equal(
        driveGuest?.role,
        "viewer",
        "운영(drive)의 접속 키 손님은 보기 전용이다",
      );
    } finally {
      process.env.STORAGE_DRIVER = "local";
    }

    // 3) setUserRole: 변경·저장·없는 id·잘못된 값
    const changed = await users.setUserRole("legacy-sub", "viewer");
    assert.equal(changed?.role, "viewer");
    assert.equal(
      (await users.findUserById("legacy-sub", { fresh: true }))?.role,
      "viewer",
    );
    assert.equal(
      (await auth.resolveSession(await legacyStyleToken("legacy-sub"), { fresh: true }))?.role,
      "viewer",
      "역할 변경은 다음 세션 판정에 바로 반영된다",
    );
    assert.equal(await users.setUserRole("no-such-user", "editor"), null);
    await assert.rejects(
      users.setUserRole(
        "legacy-sub",
        "admin" as unknown as Parameters<typeof users.setUserRole>[1],
      ),
      /역할 값/,
      "세션 전용 역할 admin은 저장 역할로 받지 않는다",
    );
    const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
      users: Array<{ id: string; role?: string }>;
      invitations: Array<{ id: string; role?: string }>;
    };
    assert.equal(
      persisted.users.find((u) => u.id === "legacy-sub")?.role,
      "viewer",
      "바뀐 역할을 파일에 저장한다",
    );
    assert.equal(
      persisted.users.find((u) => u.id === "junk-role-sub")?.role,
      "editor",
      "정규화된 기본값도 다음 쓰기 때 파일에 남는다",
    );
    assert.equal(persisted.invitations[0]?.role, "editor");

    // 4) 초대 role: 기본 editor·지정 역할 저장·가입 시 사용자에 적용
    const defaultInvite = await users.createInvitation(
      { usageMode: "once" },
      { userId: "admin-sub", email: "admin@example.com" },
    );
    assert.equal(defaultInvite.role, "editor", "role 없이 만든 초대는 editor다");
    await assert.rejects(
      users.createInvitation(
        {
          usageMode: "once",
          role: "admin" as unknown as NonNullable<
            Parameters<typeof users.createInvitation>[0]["role"]
          >,
        },
        { userId: "admin-sub", email: "admin@example.com" },
      ),
      /역할 값/,
    );

    const viewerInvite = await users.createInvitation(
      { expiresInMinutes: 60, usageMode: "once", role: "viewer" },
      { userId: "admin-sub", email: "admin@example.com" },
    );
    assert.equal(viewerInvite.role, "viewer");
    const joiner = await users.loginWithGoogle({
      id: "viewer-joiner-sub",
      email: "viewer-joiner@example.com",
      name: "보기 전용 가입자",
    });
    assert.ok(joiner.ok);
    assert.equal(joiner.user.status, "pending");
    assert.equal(joiner.user.role, "editor", "가입 전 기본 저장 역할은 editor다");
    const redeemed = await users.redeemInvitationForUser("viewer-joiner-sub", {
      id: viewerInvite.id,
      tokenVersion: viewerInvite.tokenVersion,
    });
    assert.ok(redeemed.ok);
    assert.equal(redeemed.user.role, "viewer", "초대의 role이 가입자 역할이 된다");
    assert.equal(
      (await users.findUserById("viewer-joiner-sub", { fresh: true }))?.role,
      "viewer",
    );
    const joinerToken = await auth.createUserSession(
      redeemed.user.id,
      redeemed.user.sessionVersion,
      joiner.session.id,
    );
    assert.equal(
      (await auth.resolveSession(joinerToken, { fresh: true }))?.role,
      "viewer",
    );

    // role 없던 기존 초대로 가입하면 editor를 받는다
    const legacyJoiner = await users.loginWithGoogle({
      id: "legacy-invite-joiner",
      email: "legacy-invite@example.com",
      name: "기존 초대 가입자",
    });
    assert.ok(legacyJoiner.ok);
    const legacyRedeemed = await users.redeemInvitationForUser(
      "legacy-invite-joiner",
      { id: legacyInvitation.id, tokenVersion: legacyInvitation.tokenVersion },
    );
    assert.ok(legacyRedeemed.ok);
    assert.equal(legacyRedeemed.user.role, "editor");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
