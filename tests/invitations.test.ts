import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("기간제 초대 코드 생성·전환·1회 소비", async () => {
  const originalDateNow = Date.now;
  let fakeNow = originalDateNow();
  Date.now = () => fakeNow;
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-invite-"));
  await mkdir(path.join(root, ".sharedesk"), { recursive: true });
  await writeFile(
    path.join(root, ".sharedesk", "users.json"),
    JSON.stringify({
      version: 2,
      rev: 1,
      users: [
        {
          id: "admin-google-sub",
          email: "admin@example.com",
          name: "관리자",
          status: "approved",
          isAdmin: true,
          createdAt: "2026-08-01T00:00:00.000Z",
          sessionsValidFrom: 0,
        },
      ],
      invitations: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          recipientName: "예전 초대 사용자",
          email: "legacy-expired@example.com",
          note: "기간 필드가 없던 초대",
          active: true,
          tokenVersion: 1,
          createdAt: new Date(fakeNow - 9 * 24 * 60 * 60_000).toISOString(),
          updatedAt: new Date(fakeNow - 8 * 24 * 60 * 60_000).toISOString(),
          createdByUserId: "admin-google-sub",
          createdByEmail: "admin@example.com",
          usedAt: null,
          usedByUserId: null,
          usedByEmail: null,
        },
      ],
    }),
    "utf8",
  );

  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  process.env.SESSION_SECRET = "test-session-secret-with-32-characters";
  process.env.ADMIN_EMAILS = "admin@example.com";

  const users = await import("@/lib/users");
  const tokens = await import("@/lib/invite-token");
  const auth = await import("@/lib/auth");
  const sessionTokens = await import("@/lib/session-token");
  const { NextRequest } = await import("next/server");

  try {
    const migrated = await users.listUsers();
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].invitationId, null, "v1 사용자 필드를 보존해 읽는다");
    assert.equal(migrated[0].sessionVersion, 0, "기존 명단은 세션 버전 0으로 읽는다");
    assert.deepEqual(migrated[0].sessions, [], "기존 명단은 기기 세션 없이 읽는다");

    const legacy = (await users.listInvitations({ fresh: true }))[0];
    assert.equal(
      legacy.durationMinutes,
      users.LEGACY_INVITATION_DURATION_MINUTES,
    );
    assert.equal(
      legacy.expiresAt,
      new Date(
        Date.parse(legacy.updatedAt) +
          users.LEGACY_INVITATION_DURATION_MINUTES * 60_000,
      ).toISOString(),
      "기존 무기한 초대는 updatedAt부터 7일로 결정론적으로 바꾼다",
    );
    assert.deepEqual(
      await users.findInvitation(
        { id: legacy.id, tokenVersion: legacy.tokenVersion },
        { fresh: true },
      ),
      { ok: false, reason: "invite_expired" },
    );

    const directUnknown = await users.loginWithGoogle({
      id: "new-user",
      email: "new@example.com",
      name: "신규 사용자",
    });
    assert.ok(directUnknown.ok);
    assert.equal(directUnknown.user.status, "pending");
    assert.equal(
      (await users.findUserById("new-user", { fresh: true }))?.status,
      "pending",
      "Google 인증을 마친 신규 사용자는 코드 입력용 pending 세션을 갖는다",
    );

    const invitation = await users.createInvitation(
      {
        recipientName: "초대 사용자",
        email: "invitee@example.com",
        note: "영상팀",
        active: true,
      },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    assert.equal(
      invitation.durationMinutes,
      users.DEFAULT_INVITATION_DURATION_MINUTES,
    );
    assert.equal(
      Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt),
      users.DEFAULT_INVITATION_DURATION_MINUTES * 60_000,
    );
    await assert.rejects(
      users.createInvitation(
        {
          recipientName: "너무 짧은 초대",
          email: "too-short@example.com",
          expiresInMinutes: 4,
        },
        { userId: "admin-google-sub", email: "admin@example.com" },
      ),
      /초대 기간/,
    );
    await assert.rejects(
      users.createInvitation(
        {
          recipientName: "정수가 아닌 초대",
          email: "fraction@example.com",
          expiresInMinutes: 5.5,
        },
        { userId: "admin-google-sub", email: "admin@example.com" },
      ),
      /초대 기간/,
    );
    await assert.rejects(
      users.createInvitation(
        {
          recipientName: "너무 긴 초대",
          email: "too-long@example.com",
          expiresInMinutes: users.MAX_INVITATION_DURATION_MINUTES + 1,
        },
        { userId: "admin-google-sub", email: "admin@example.com" },
      ),
      /초대 기간/,
    );
    const ref = { id: invitation.id, tokenVersion: invitation.tokenVersion };
    const code = tokens.createInvitationCode(ref);
    assert.match(code, /^(?:[A-HJ-NP-Z]{4}-){5}[A-HJ-NP-Z]{4}$/);
    assert.equal(tokens.createInvitationCode(ref), code, "코드는 같은 초대 버전에서 결정적이다");
    const noisyCode = `  ${code.toLowerCase().replaceAll("-", " - \n")}  `;
    assert.equal(
      tokens.normalizeInvitationCode(noisyCode),
      code.replaceAll("-", ""),
      "공백·하이픈·대소문자는 입력 편의를 위해 정규화한다",
    );
    assert.equal((await tokens.findInvitationByCode(noisyCode)).ok, true);
    const compactCode = code.replaceAll("-", "");
    const changedFirst = compactCode[0] === "A" ? "B" : "A";
    assert.deepEqual(
      await tokens.findInvitationByCode(changedFirst + compactCode.slice(1)),
      { ok: false, reason: "invite_invalid" },
      "한 글자 변조한 코드는 거절한다",
    );
    assert.equal(tokens.normalizeInvitationCode("A".repeat(97)), null);
    assert.equal(
      tokens.normalizeInvitationCode("ß".repeat(12)),
      null,
      "대문자 변환 때 길이가 늘어나는 비 ASCII 문자는 받지 않는다",
    );
    const storedAfterCreate = await readFile(
      path.join(root, ".sharedesk", "users.json"),
      "utf8",
    );
    const persisted = JSON.parse(storedAfterCreate) as {
      invitations: Array<{
        id: string;
        durationMinutes?: number;
        expiresAt?: string;
      }>;
    };
    const persistedLegacy = persisted.invitations.find(
      (item) => item.id === legacy.id,
    );
    assert.equal(
      persistedLegacy?.durationMinutes,
      users.LEGACY_INVITATION_DURATION_MINUTES,
    );
    assert.equal(persistedLegacy?.expiresAt, legacy.expiresAt);
    assert.equal(storedAfterCreate.includes(code), false, "사람용 코드를 저장하지 않는다");
    assert.equal(
      storedAfterCreate.includes(process.env.SESSION_SECRET!),
      false,
      "코드 파생 비밀을 저장하지 않는다",
    );

    const expiring = await users.createInvitation(
      {
        recipientName: "곧 만료될 사용자",
        email: "expires@example.com",
        expiresInMinutes: 5,
      },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const expiringRef = {
      id: expiring.id,
      tokenVersion: expiring.tokenVersion,
    };
    fakeNow += 5 * 60_000;
    assert.deepEqual(
      await users.findInvitation(expiringRef, { fresh: true }),
      { ok: false, reason: "invite_expired" },
    );
    const expiredPending = await users.loginWithGoogle({
      id: "expired-user",
      email: expiring.email,
      name: "만료 사용자",
    });
    assert.ok(expiredPending.ok);
    assert.deepEqual(
      await users.redeemInvitationForUser(expiredPending.user.id, expiringRef),
      { ok: false, reason: "invite_expired" },
    );
    assert.deepEqual(
      await tokens.findInvitationByCode(
        tokens.createInvitationCode(expiringRef),
      ),
      { ok: false, reason: "invite_expired" },
    );

    const pendingInvite = await users.createInvitation(
      {
        recipientName: directUnknown.user.name,
        email: directUnknown.user.email,
        expiresInMinutes: 60,
      },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const pendingSessionToken = await auth.createUserSession(
      directUnknown.user.id,
      directUnknown.user.sessionVersion,
      directUnknown.session.id,
    );
    const codeRoute = await import("@/app/api/invitations/code/route");
    const formResponse = await codeRoute.POST(
      new NextRequest("http://localhost:3000/api/invitations/code", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `sharedesk_session=${pendingSessionToken}`,
        },
        body: new URLSearchParams({
          code: tokens.createInvitationCode({
            id: pendingInvite.id,
            tokenVersion: pendingInvite.tokenVersion,
          }),
        }),
      }),
    );
    assert.equal(formResponse.status, 303);
    assert.equal(
      new URL(formResponse.headers.get("location") ?? "").pathname,
      "/files",
    );
    assert.equal(
      (await users.findUserById(directUnknown.user.id, { fresh: true }))?.status,
      "approved",
    );
    assert.ok(
      await auth.resolveSession(pendingSessionToken, { fresh: true }),
      "승인 전 세션은 코드 사용 직후 승인 세션으로 이어진다",
    );
    assert.deepEqual(
      await users.findInvitation(
        { id: pendingInvite.id, tokenVersion: pendingInvite.tokenVersion },
        { fresh: true },
      ),
      { ok: false, reason: "invite_used" },
    );

    const jsonPending = await users.loginWithGoogle({
      id: "json-pending-user",
      email: "json-pending@example.com",
      name: "JSON 가입 사용자",
    });
    assert.ok(jsonPending.ok);
    const jsonInvite = await users.createInvitation(
      {
        recipientName: jsonPending.user.name,
        email: jsonPending.user.email,
      },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const jsonSessionToken = await auth.createUserSession(
      jsonPending.user.id,
      jsonPending.user.sessionVersion,
      jsonPending.session.id,
    );
    const jsonResponse = await codeRoute.POST(
      new NextRequest("http://localhost:3000/api/invitations/code", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `sharedesk_session=${jsonSessionToken}`,
        },
        body: JSON.stringify({
          code: tokens.createInvitationCode({
            id: jsonInvite.id,
            tokenVersion: jsonInvite.tokenVersion,
          }),
        }),
      }),
    );
    assert.equal(jsonResponse.status, 303);
    assert.equal(
      new URL(jsonResponse.headers.get("location") ?? "").pathname,
      "/files",
      "JSON 코드 제출도 받는다",
    );

    const invalidPending = await users.loginWithGoogle({
      id: "invalid-code-user",
      email: "invalid-code@example.com",
      name: "잘못된 코드 사용자",
    });
    assert.ok(invalidPending.ok);
    const invalidSessionToken = await auth.createUserSession(
      invalidPending.user.id,
      invalidPending.user.sessionVersion,
      invalidPending.session.id,
    );
    const invalidResponse = await codeRoute.POST(
      new NextRequest("http://localhost:3000/api/invitations/code", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `sharedesk_session=${invalidSessionToken}`,
        },
        body: new URLSearchParams({ code: "not-a-code" }),
      }),
    );
    const invalidLocation = new URL(
      invalidResponse.headers.get("location") ?? "",
    );
    assert.equal(invalidResponse.status, 303);
    assert.equal(invalidLocation.pathname, "/join");
    assert.equal(invalidLocation.searchParams.get("error"), "invite_invalid");
    for (let attempt = 1; attempt < 10; attempt += 1) {
      const repeatedInvalid = await codeRoute.POST(
        new NextRequest("http://localhost:3000/api/invitations/code", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: `sharedesk_session=${invalidSessionToken}`,
          },
          body: new URLSearchParams({ code: "not-a-code" }),
        }),
      );
      assert.equal(
        new URL(repeatedInvalid.headers.get("location") ?? "").searchParams.get(
          "error",
        ),
        "invite_invalid",
      );
    }
    const rateLimited = await codeRoute.POST(
      new NextRequest("http://localhost:3000/api/invitations/code", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `sharedesk_session=${invalidSessionToken}`,
        },
        body: new URLSearchParams({ code: "not-a-code" }),
      }),
    );
    assert.equal(
      new URL(rateLimited.headers.get("location") ?? "").searchParams.get(
        "error",
      ),
      "invite_rate_limited",
      "한 사용자의 반복 코드 대입은 분당 상한에서 멈춘다",
    );

    const oversizedPending = await users.loginWithGoogle({
      id: "oversized-code-user",
      email: "oversized-code@example.com",
      name: "큰 본문 사용자",
    });
    assert.ok(oversizedPending.ok);
    const oversizedToken = await auth.createUserSession(
      oversizedPending.user.id,
      oversizedPending.user.sessionVersion,
      oversizedPending.session.id,
    );
    const oversizedRequest = new NextRequest(
      "http://localhost:3000/api/invitations/code",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `sharedesk_session=${oversizedToken}`,
        },
        body: JSON.stringify({ code: "A".repeat(5_000) }),
      },
    );
    assert.equal(oversizedRequest.headers.get("content-length"), null);
    const oversizedResponse = await codeRoute.POST(oversizedRequest);
    assert.equal(
      new URL(oversizedResponse.headers.get("location") ?? "").searchParams.get(
        "error",
      ),
      "invite_invalid",
      "Content-Length가 없어도 4KB를 넘는 본문은 코드로 읽지 않는다",
    );

    const mismatchInvite = await users.createInvitation(
      {
        recipientName: "다른 이메일 사용자",
        email: "different-email@example.com",
      },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const mismatchRef = {
      id: mismatchInvite.id,
      tokenVersion: mismatchInvite.tokenVersion,
    };
    assert.deepEqual(
      await users.redeemInvitationForUser(invalidPending.user.id, mismatchRef),
      { ok: false, reason: "invite_email_mismatch" },
    );
    assert.equal(
      (await users.findInvitation(mismatchRef, { fresh: true })).ok,
      true,
      "이메일이 다른 코드 사용 실패는 초대를 소비하지 않는다",
    );

    const casPending = await users.loginWithGoogle({
      id: "cas-pending-user",
      email: "cas-pending@example.com",
      name: "동시 가입 사용자",
    });
    assert.ok(casPending.ok);
    const casInvite = await users.createInvitation(
      {
        recipientName: casPending.user.name,
        email: casPending.user.email,
      },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const casRef = {
      id: casInvite.id,
      tokenVersion: casInvite.tokenVersion,
    };
    const redemptions = await Promise.all([
      users.redeemInvitationForUser(casPending.user.id, casRef),
      users.redeemInvitationForUser(casPending.user.id, casRef),
    ]);
    assert.equal(redemptions.filter((result) => result.ok).length, 1);
    assert.equal(
      redemptions.filter((result) => !result.ok).length,
      1,
      "동시 코드 사용도 CAS로 한 번만 승인한다",
    );
    assert.deepEqual(
      await users.findInvitation(casRef, { fresh: true }),
      { ok: false, reason: "invite_used" },
    );

    const wrongPending = await users.loginWithGoogle({
      id: "wrong-user",
      email: "wrong@example.com",
      name: "다른 사람",
    });
    assert.ok(wrongPending.ok);
    const mismatch = await users.redeemInvitationForUser(
      wrongPending.user.id,
      ref,
    );
    assert.deepEqual(mismatch, { ok: false, reason: "invite_email_mismatch" });
    assert.equal((await users.findInvitation(ref, { fresh: true })).ok, true);

    await users.updateInvitation(invitation.id, { active: false });
    const inactive = await users.findInvitation(ref, { fresh: true });
    assert.deepEqual(inactive, { ok: false, reason: "invite_inactive" });
    await users.updateInvitation(invitation.id, { active: true });

    const profile = {
      id: "invitee-google-sub",
      email: "invitee@example.com",
      name: "초대 사용자",
    };
    const pendingProfile = await users.loginWithGoogle(profile);
    assert.ok(pendingProfile.ok);
    const attempts = await Promise.all([
      users.redeemInvitationForUser(profile.id, ref),
      users.redeemInvitationForUser(profile.id, ref),
    ]);
    assert.equal(attempts.filter((result) => result.ok).length, 1);
    assert.deepEqual(
      attempts.find((result) => !result.ok),
      { ok: false, reason: "invite_required" },
      "동시 소비 중 하나만 성공한다",
    );

    const approved = await users.findUserById(profile.id, { fresh: true });
    assert.equal(approved?.status, "approved");
    assert.equal(approved?.invitationId, invitation.id);
    const repeatedLogin = await users.loginWithGoogle(profile);
    assert.equal(repeatedLogin.ok, true, "기존 사용자는 재로그인한다");
    assert.ok(repeatedLogin.ok);

    assert.ok(approved);
    const currentSession = await auth.createUserSession(
      repeatedLogin.user.id,
      repeatedLogin.user.sessionVersion,
      repeatedLogin.session.id,
    );
    const legacySession = await sessionTokens.signPayload({
      t: "user",
      sub: approved.id,
      iat: Math.floor(Date.now() / 1000),
    });
    assert.ok(await auth.resolveSession(currentSession, { fresh: true }));
    assert.ok(
      await auth.resolveSession(legacySession, { fresh: true }),
      "마이그레이션 전 세션은 버전 0인 동안 유지한다",
    );

    const revoked = await users.revokeSessions(approved.id);
    assert.equal(revoked?.sessionVersion, 1);
    assert.equal(
      await auth.resolveSession(currentSession, { fresh: true }),
      null,
      "발급과 철회가 같은 초여도 이전 세션을 끊는다",
    );
    assert.equal(
      await auth.resolveSession(legacySession, { fresh: true }),
      null,
      "버전이 올라가면 버전 claim 없는 기존 세션도 끊는다",
    );
    const renewedLogin = await users.loginWithGoogle(profile);
    assert.ok(renewedLogin.ok);
    const renewedSession = await auth.createUserSession(
      renewedLogin.user.id,
      renewedLogin.user.sessionVersion,
      renewedLogin.session.id,
    );
    assert.ok(await auth.resolveSession(renewedSession, { fresh: true }));

    const rotateTarget = await users.createInvitation(
      {
        recipientName: "재발급 대상",
        email: "rotate@example.com",
        note: "",
        expiresInMinutes: 10,
      },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const oldRef = {
      id: rotateTarget.id,
      tokenVersion: rotateTarget.tokenVersion,
    };
    const oldCode = tokens.createInvitationCode(oldRef);
    fakeNow += 7 * 60_000;
    const rotated = await users.rotateInvitation(rotateTarget.id);
    assert.ok(rotated);
    assert.equal(rotated.durationMinutes, 10);
    assert.equal(
      rotated.expiresAt,
      new Date(fakeNow + 10 * 60_000).toISOString(),
      "재발급은 기존 기간을 현재 시각부터 다시 준다",
    );
    assert.equal((await users.findInvitation(oldRef, { fresh: true })).ok, false);
    assert.deepEqual(await tokens.findInvitationByCode(oldCode), {
      ok: false,
      reason: "invite_invalid",
    });
    assert.equal(
      (
        await users.findInvitation(
          { id: rotated.id, tokenVersion: rotated.tokenVersion },
          { fresh: true },
        )
      ).ok,
      true,
    );
    assert.equal(
      (
        await tokens.findInvitationByCode(
          tokens.createInvitationCode({
            id: rotated.id,
            tokenVersion: rotated.tokenVersion,
          }),
        )
      ).ok,
      true,
    );

    const removableInvite = await users.createInvitation(
      {
        recipientName: "삭제할 사용자",
        email: "remove@example.com",
        note: "가입용",
      },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const removableProfile = {
      id: "removable-google-sub",
      email: "remove@example.com",
      name: "삭제할 사용자",
    };
    const removablePending = await users.loginWithGoogle(removableProfile);
    assert.ok(removablePending.ok);
    assert.equal(
      (
        await users.redeemInvitationForUser(removableProfile.id, {
          id: removableInvite.id,
          tokenVersion: removableInvite.tokenVersion,
        })
      ).ok,
      true,
    );
    const firstUnused = await users.createInvitation(
      {
        recipientName: "삭제할 사용자",
        email: removableProfile.email,
        note: "첫 번째 미사용 코드",
      },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const secondUnused = await users.createInvitation(
      {
        recipientName: "삭제할 사용자",
        email: removableProfile.email,
        note: "두 번째 미사용 코드",
      },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const firstUnusedRef = {
      id: firstUnused.id,
      tokenVersion: firstUnused.tokenVersion,
    };
    const secondUnusedRef = {
      id: secondUnused.id,
      tokenVersion: secondUnused.tokenVersion,
    };
    assert.equal(await users.removeUser(removableProfile.id), true);
    const invalidatedInvitations = await users.listInvitations();
    for (const ref of [firstUnusedRef, secondUnusedRef]) {
      const invalidated = invalidatedInvitations.find(
        (item) => item.id === ref.id,
      );
      assert.equal(invalidated?.active, false);
      assert.equal(invalidated?.tokenVersion, ref.tokenVersion + 1);
      assert.ok(Number.isFinite(Date.parse(invalidated?.updatedAt ?? "")));
      assert.deepEqual(await users.findInvitation(ref, { fresh: true }), {
        ok: false,
        reason: "invite_invalid",
      });
    }
    const afterRemovalLogin = await users.loginWithGoogle(removableProfile);
    assert.ok(afterRemovalLogin.ok);
    assert.equal(
      afterRemovalLogin.user.status,
      "pending",
      "삭제된 사용자가 다시 Google 인증하면 코드 입력 대기 상태가 된다",
    );
    const reinvite = await users.createInvitation(
      {
        recipientName: "다시 초대한 사용자",
        email: removableProfile.email,
        note: "관리자가 새로 발급",
      },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    assert.equal(
      (
        await users.redeemInvitationForUser(removableProfile.id, {
          id: reinvite.id,
          tokenVersion: reinvite.tokenVersion,
        })
      ).ok,
      true,
      "삭제 뒤 관리자가 새 초대를 만들면 다시 가입할 수 있다",
    );

    const blockedUser = await users.setStatus(profile.id, "blocked");
    assert.equal(blockedUser?.sessionVersion, 2, "차단도 세션 버전을 올린다");
    const blockedInvite = await users.createInvitation(
      {
        recipientName: "차단 사용자",
        email: profile.email,
      },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const blockedResult = await users.redeemInvitationForUser(profile.id, {
      id: blockedInvite.id,
      tokenVersion: blockedInvite.tokenVersion,
    });
    assert.deepEqual(blockedResult, { ok: false, reason: "blocked" });
    assert.equal(
      (
        await users.findInvitation(
          { id: blockedInvite.id, tokenVersion: blockedInvite.tokenVersion },
          { fresh: true },
        )
      ).ok,
      true,
      "차단 사용자의 실패는 코드를 소비하지 않는다",
    );

    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "private-oauth-secret";
    process.env.PUBLIC_BASE_URL = "http://localhost:3000";
    const callbackRoute = await import(
      "@/app/api/auth/google/callback/route"
    );
    const loginRoute = await import("@/app/api/auth/google/route");
    assert.deepEqual(loginRoute.LOGIN_OAUTH_SCOPES, [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
    ]);
    const { getAdapter } = await import("@/lib/storage");
    const originalFetch = globalThis.fetch;
    const callbackRequest = () =>
      new NextRequest(
        "http://localhost:3000/api/auth/google/callback?code=test-code&state=test-state",
        {
          headers: {
            Cookie: "sharedesk_oauth=test-state.test-verifier",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36",
          },
        },
      );
    const assertCallbackFailure = (
      response: Awaited<ReturnType<typeof callbackRoute.GET>>,
      reason: string,
    ) => {
      const location = response.headers.get("location") ?? "";
      assert.match(location, new RegExp(`[?&]error=${reason}(?:&|$)`));
      assert.doesNotMatch(location, /private-oauth-secret|test-code/);
      assert.equal(response.cookies.get("sharedesk_oauth")?.value, "");
    };

    try {
      let receivedTimeoutSignal = false;
      globalThis.fetch = (async (_input, init) => {
        receivedTimeoutSignal = init?.signal instanceof AbortSignal;
        throw new TypeError("private-oauth-secret network detail");
      }) as typeof fetch;
      assertCallbackFailure(
        await callbackRoute.GET(callbackRequest()),
        "token",
      );
      assert.equal(receivedTimeoutSignal, true, "OAuth 요청에 timeout signal을 건다");

      globalThis.fetch = (async () =>
        new Response("not-json", { status: 200 })) as typeof fetch;
      assertCallbackFailure(
        await callbackRoute.GET(callbackRequest()),
        "token",
      );

      let fetchCount = 0;
      globalThis.fetch = (async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return Response.json({ access_token: "private-oauth-secret" });
        }
        throw new TypeError("userinfo network detail");
      }) as typeof fetch;
      assertCallbackFailure(
        await callbackRoute.GET(callbackRequest()),
        "userinfo",
      );

      fetchCount = 0;
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return fetchCount === 1
          ? Response.json({ access_token: "private-oauth-secret" })
          : new Response("not-json", { status: 200 });
      }) as typeof fetch;
      assertCallbackFailure(
        await callbackRoute.GET(callbackRequest()),
        "userinfo",
      );

      const adapter = getAdapter();
      const originalCompareAndSwapState = adapter.compareAndSwapState;
      adapter.compareAndSwapState = async () => {
        throw new Error("private storage detail");
      };
      try {
        fetchCount = 0;
        globalThis.fetch = (async () => {
          fetchCount += 1;
          return fetchCount === 1
            ? Response.json({ access_token: "private-oauth-secret" })
            : Response.json({
                sub: "oauth-storage-failure",
                email: "admin@example.com",
                email_verified: true,
                name: "관리자",
              });
        }) as typeof fetch;
        assertCallbackFailure(
          await callbackRoute.GET(callbackRequest()),
          "login",
        );
      } finally {
        adapter.compareAndSwapState = originalCompareAndSwapState;
      }

      const sessionsBeforeSigningFailure =
        (await users.findUserById("admin-google-sub", { fresh: true }))?.sessions ??
        [];
      const originalSessionSecret = process.env.SESSION_SECRET;
      try {
        process.env.SESSION_SECRET = "short";
        fetchCount = 0;
        globalThis.fetch = (async () => {
          fetchCount += 1;
          return fetchCount === 1
            ? Response.json({ access_token: "private-oauth-secret" })
            : Response.json({
                sub: "admin-google-sub",
                email: "admin@example.com",
                email_verified: true,
                name: "관리자",
              });
        }) as typeof fetch;
        assertCallbackFailure(
          await callbackRoute.GET(callbackRequest()),
          "session",
        );
        assert.deepEqual(
          (await users.findUserById("admin-google-sub", { fresh: true }))
            ?.sessions,
          sessionsBeforeSigningFailure,
          "세션 토큰 서명 실패는 기기 세션을 명단에 남기지 않는다",
        );
      } finally {
        if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
        else process.env.SESSION_SECRET = originalSessionSecret;
      }

      fetchCount = 0;
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return fetchCount === 1
          ? Response.json({ access_token: "private-oauth-secret" })
          : Response.json({
              sub: "oauth-pending-user",
              email: "oauth-pending@example.com",
              email_verified: true,
              name: "가입 대기 사용자",
            });
      }) as typeof fetch;
      const pendingCallback = await callbackRoute.GET(callbackRequest());
      assert.equal(
        new URL(pendingCallback.headers.get("location") ?? "").pathname,
        "/join",
        "미등록 Google 사용자는 인증 뒤 코드 입력 화면으로 간다",
      );
      const pendingCookie = pendingCallback.cookies.get(
        "sharedesk_session",
      )?.value;
      assert.deepEqual(await auth.resolveIdentity(pendingCookie), {
        userId: "oauth-pending-user",
        email: "oauth-pending@example.com",
        name: "가입 대기 사용자",
        status: "pending",
        isAdmin: false,
      });
      assert.equal(
        await auth.resolveSession(pendingCookie, { fresh: true }),
        null,
        "pending 세션은 신원 확인에만 쓰이고 승인 영역은 열지 않는다",
      );

      fetchCount = 0;
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return fetchCount === 1
          ? Response.json({ access_token: "private-oauth-secret" })
          : Response.json({
              sub: "admin-google-sub",
              email: "admin@example.com",
              email_verified: true,
              name: "관리자",
            });
      }) as typeof fetch;
      const success = await callbackRoute.GET(callbackRequest());
      assert.equal(
        new URL(success.headers.get("location") ?? "").pathname,
        "/files",
        "정상 OAuth 흐름을 유지한다",
      );
      const issuedCookie = success.cookies.get("sharedesk_session")?.value;
      const issuedClaims = await sessionTokens.openSigned(issuedCookie);
      assert.equal(issuedClaims?.t, "user");
      if (issuedClaims?.t === "user") {
        assert.equal(issuedClaims.sv, 0);
        assert.equal(sessionTokens.isValidSessionId(issuedClaims.sid), true);
        const oauthUser = await users.findUserById("admin-google-sub", {
          fresh: true,
        });
        const oauthSession = oauthUser?.sessions.find(
          (session) => session.id === issuedClaims.sid,
        );
        assert.equal(oauthSession?.deviceLabel, "Chrome · Windows");
      }
      assert.equal(success.cookies.get("sharedesk_oauth")?.value, "");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    Date.now = originalDateNow;
    await rm(root, { recursive: true, force: true });
  }
});
