import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("기간제 초대 코드 생성·전환·사용 방식", async () => {
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
        {
          id: "00000000-0000-4000-8000-000000000002",
          active: false,
          tokenVersion: 3,
          durationMinutes: 60,
          expiresAt: new Date(fakeNow + 60 * 60_000).toISOString(),
          createdAt: new Date(fakeNow - 60 * 60_000).toISOString(),
          updatedAt: new Date(fakeNow - 30 * 60_000).toISOString(),
          createdByUserId: "admin-google-sub",
          createdByEmail: "admin@example.com",
          usedAt: new Date(fakeNow - 30 * 60_000).toISOString(),
          usedByUserId: "legacy-used-user",
          usedByEmail: "legacy-used@example.com",
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

    const migratedInvitations = await users.listInvitations({ fresh: true });
    const legacy = migratedInvitations.find(
      (item) => item.id === "00000000-0000-4000-8000-000000000001",
    );
    assert.ok(legacy);
    assert.equal("recipientName" in legacy, false);
    assert.equal("email" in legacy, false);
    assert.equal("note" in legacy, false);
    assert.equal(legacy.active, false, "기존 이메일 전용 초대는 범용 코드로 열지 않는다");
    assert.equal(
      legacy.tokenVersion,
      2,
      "기존에 전달된 코드 값도 토큰 버전을 올려 무효화한다",
    );
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
    const migratedUsed = migratedInvitations.find(
      (item) => item.id === "00000000-0000-4000-8000-000000000002",
    );
    assert.ok(migratedUsed);
    assert.equal(migratedUsed.usageMode, "once");
    assert.equal(migratedUsed.usageCount, 1);
    assert.equal(
      migratedUsed.lastUsedAt,
      new Date(fakeNow - 30 * 60_000).toISOString(),
    );
    assert.equal(migratedUsed.lastUsedByUserId, "legacy-used-user");
    assert.equal(migratedUsed.lastUsedByEmail, "legacy-used@example.com");
    assert.deepEqual(
      await users.findInvitation(
        { id: migratedUsed.id, tokenVersion: migratedUsed.tokenVersion },
        { fresh: true },
      ),
      { ok: false, reason: "invite_used" },
      "기존 usedAt 감사 정보는 1회 사용 완료 상태로 옮긴다",
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
      { usageMode: "once" },
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
        { expiresInMinutes: 4, usageMode: "once" },
        { userId: "admin-google-sub", email: "admin@example.com" },
      ),
      /초대 기간/,
    );
    await assert.rejects(
      users.createInvitation(
        {} as Parameters<typeof users.createInvitation>[0],
        { userId: "admin-google-sub", email: "admin@example.com" },
      ),
      /사용 방식/,
    );
    await assert.rejects(
      users.createInvitation(
        { expiresInMinutes: 5.5, usageMode: "once" },
        { userId: "admin-google-sub", email: "admin@example.com" },
      ),
      /초대 기간/,
    );
    await assert.rejects(
      users.createInvitation(
        {
          expiresInMinutes: users.MAX_INVITATION_DURATION_MINUTES + 1,
          usageMode: "once",
        },
        { userId: "admin-google-sub", email: "admin@example.com" },
      ),
      /초대 기간/,
    );
    const ref = { id: invitation.id, tokenVersion: invitation.tokenVersion };
    const code = tokens.createInvitationCode(ref);
    assert.match(
      code,
      /^(?!.*[01IO])(?:[2-9A-Z]{4}-){15}[2-9A-Z]{4}$/,
    );
    assert.equal(tokens.createInvitationCode(ref), code, "코드는 같은 초대 버전에서 결정적이다");
    const noisyCode = `  ${code.toLowerCase().replaceAll("-", " - \n")}  `;
    assert.equal(
      tokens.normalizeInvitationCode(noisyCode),
      code.replaceAll("-", ""),
      "공백·하이픈·대소문자는 입력 편의를 위해 정규화한다",
    );
    assert.deepEqual(tokens.parseInvitationCode(noisyCode), ref);
    const compactCode = code.replaceAll("-", "");
    const changedFirst = compactCode[0] === "2" ? "3" : "2";
    assert.equal(
      tokens.parseInvitationCode(changedFirst + compactCode.slice(1)),
      null,
      "한 글자 변조한 코드는 거절한다",
    );
    assert.equal(tokens.normalizeInvitationCode("A".repeat(193)), null);
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
    assert.equal(
      storedAfterCreate.includes("legacy-expired@example.com"),
      false,
      "기존 수신자 정보는 다음 저장 때 제거한다",
    );
    assert.equal(storedAfterCreate.includes("예전 초대 사용자"), false);
    assert.equal(storedAfterCreate.includes("기간 필드가 없던 초대"), false);
    assert.equal(storedAfterCreate.includes(code), false, "사람용 코드를 저장하지 않는다");
    assert.equal(
      storedAfterCreate.includes(process.env.SESSION_SECRET!),
      false,
      "코드 파생 비밀을 저장하지 않는다",
    );

    const expiring = await users.createInvitation(
      { expiresInMinutes: 5, usageMode: "once" },
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
      email: "expires@example.com",
      name: "만료 사용자",
    });
    assert.ok(expiredPending.ok);
    assert.deepEqual(
      await users.redeemInvitationForUser(expiredPending.user.id, expiringRef),
      { ok: false, reason: "invite_expired" },
    );
    assert.deepEqual(
      tokens.parseInvitationCode(tokens.createInvitationCode(expiringRef)),
      expiringRef,
      "코드 해석은 저장소를 보지 않고 만료 여부를 최종 사용 단계에 맡긴다",
    );

    const pendingInvite = await users.createInvitation(
      { expiresInMinutes: 60, usageMode: "once" },
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
    // 로그인·수락의 목적지는 항상 데스크 선택(/spaces)이다(#14).
    assert.equal(
      new URL(formResponse.headers.get("location") ?? "").pathname,
      "/spaces",
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
      { usageMode: "once" },
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
      "/spaces",
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
    const storage = await import("@/lib/storage");
    const invalidCodeAdapter = storage.getAdapter();
    const originalReadStateVersioned = invalidCodeAdapter.readStateVersioned;
    let invalidCodeStateReads = 0;
    const invalidCodeStatePath = path.join(root, ".sharedesk", "users.json");
    const revBeforeInvalidCode = (
      JSON.parse(await readFile(invalidCodeStatePath, "utf8")) as { rev: number }
    ).rev;
    invalidCodeAdapter.readStateVersioned = (async (...args) => {
      invalidCodeStateReads += 1;
      return originalReadStateVersioned.apply(invalidCodeAdapter, args);
    }) as typeof originalReadStateVersioned;
    let invalidResponse: Awaited<ReturnType<typeof codeRoute.POST>>;
    let tamperedResponse: Awaited<ReturnType<typeof codeRoute.POST>>;
    try {
      invalidResponse = await codeRoute.POST(
        new NextRequest("http://localhost:3000/api/invitations/code", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: `sharedesk_session=${invalidSessionToken}`,
          },
          body: new URLSearchParams({ code: "not-a-code" }),
        }),
      );
      tamperedResponse = await codeRoute.POST(
        new NextRequest("http://localhost:3000/api/invitations/code", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: `sharedesk_session=${invalidSessionToken}`,
          },
          body: new URLSearchParams({
            code: changedFirst + compactCode.slice(1),
          }),
        }),
      );
    } finally {
      invalidCodeAdapter.readStateVersioned = originalReadStateVersioned;
    }
    assert.equal(
      invalidCodeStateReads,
      0,
      "형식이 틀리거나 서명이 맞지 않는 코드는 사용자·초대 저장소를 읽지 않는다",
    );
    assert.equal(
      (JSON.parse(await readFile(invalidCodeStatePath, "utf8")) as { rev: number })
        .rev,
      revBeforeInvalidCode,
      "잘못된 코드 요청은 사용자·초대 상태도 바꾸지 않는다",
    );
    const invalidLocation = new URL(
      invalidResponse.headers.get("location") ?? "",
    );
    assert.equal(invalidResponse.status, 303);
    assert.equal(invalidLocation.pathname, "/join");
    assert.equal(invalidLocation.searchParams.get("error"), "invite_invalid");
    assert.equal(
      new URL(tamperedResponse.headers.get("location") ?? "").searchParams.get(
        "error",
      ),
      "invite_invalid",
    );
    for (let attempt = 2; attempt < 10; attempt += 1) {
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

    const genericInvite = await users.createInvitation(
      { usageMode: "once" },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const genericRef = {
      id: genericInvite.id,
      tokenVersion: genericInvite.tokenVersion,
    };
    assert.equal(
      (
        await users.redeemInvitationForUser(
          invalidPending.user.id,
          genericRef,
        )
      ).ok,
      true,
      "범용 코드는 생성할 때 특정한 수신자와 무관하게 pending 사용자가 쓴다",
    );
    const genericUsed = (await users.listInvitations({ fresh: true })).find(
      (item) => item.id === genericInvite.id,
    );
    assert.equal(genericUsed?.usageCount, 1);
    assert.equal(genericUsed?.lastUsedByUserId, invalidPending.user.id);
    assert.equal(genericUsed?.lastUsedByEmail, invalidPending.user.email);
    assert.equal("recipientName" in genericInvite, false);
    assert.equal("email" in genericInvite, false);
    assert.equal("note" in genericInvite, false);

    const statePath = path.join(root, ".sharedesk", "users.json");
    const beforeRepeatedRedemption = JSON.parse(
      await readFile(statePath, "utf8"),
    ) as { rev: number };
    assert.deepEqual(
      await users.redeemInvitationForUser(invalidPending.user.id, genericRef),
      { ok: false, reason: "invite_required" },
    );
    const afterRepeatedRedemption = JSON.parse(
      await readFile(statePath, "utf8"),
    ) as { rev: number };
    assert.equal(
      afterRepeatedRedemption.rev,
      beforeRepeatedRedemption.rev,
      "승인된 사용자의 실패한 재입력은 사용자 상태를 다시 저장하지 않는다",
    );
    const approvedCodeResponse = await codeRoute.POST(
      new NextRequest("http://localhost:3000/api/invitations/code", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: `sharedesk_session=${jsonSessionToken}`,
        },
        body: new URLSearchParams({
          code: tokens.createInvitationCode(genericRef),
        }),
      }),
    );
    const approvedCodeLocation = new URL(
      approvedCodeResponse.headers.get("location") ?? "",
    );
    assert.equal(
      approvedCodeLocation.pathname,
      "/join",
      "서명 확인 뒤 CAS가 현재 사용자 상태까지 최종 판정한다",
    );
    assert.equal(
      approvedCodeLocation.searchParams.get("error"),
      "invite_required",
    );
    assert.equal(
      (JSON.parse(await readFile(statePath, "utf8")) as { rev: number }).rev,
      beforeRepeatedRedemption.rev,
      "승인된 세션의 코드 제출 API도 사용자 상태를 저장하지 않는다",
    );

    const casPendingOne = await users.loginWithGoogle({
      id: "cas-pending-user-one",
      email: "cas-pending-one@example.com",
      name: "동시 가입 사용자 1",
    });
    const casPendingTwo = await users.loginWithGoogle({
      id: "cas-pending-user-two",
      email: "cas-pending-two@example.com",
      name: "동시 가입 사용자 2",
    });
    assert.ok(casPendingOne.ok);
    assert.ok(casPendingTwo.ok);
    const casInvite = await users.createInvitation(
      { usageMode: "once" },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const casRef = {
      id: casInvite.id,
      tokenVersion: casInvite.tokenVersion,
    };
    const redemptions = await Promise.all([
      users.redeemInvitationForUser(casPendingOne.user.id, casRef),
      users.redeemInvitationForUser(casPendingTwo.user.id, casRef),
    ]);
    assert.equal(redemptions.filter((result) => result.ok).length, 1);
    assert.equal(
      redemptions.filter((result) => !result.ok).length,
      1,
      "서로 다른 사용자의 동시 코드 사용도 CAS로 한 번만 승인한다",
    );
    assert.deepEqual(redemptions.find((result) => !result.ok), {
      ok: false,
      reason: "invite_used",
    });
    assert.deepEqual(
      await users.findInvitation(casRef, { fresh: true }),
      { ok: false, reason: "invite_used" },
    );
    await assert.rejects(
      users.setInvitationActive(casInvite.id, true),
      /사용 완료/,
    );
    await assert.rejects(
      users.rotateInvitation(casInvite.id),
      /사용 완료/,
    );

    const unlimitedPendingOne = await users.loginWithGoogle({
      id: "unlimited-pending-one",
      email: "unlimited-one@example.com",
      name: "무제한 가입 사용자 1",
    });
    const unlimitedPendingTwo = await users.loginWithGoogle({
      id: "unlimited-pending-two",
      email: "unlimited-two@example.com",
      name: "무제한 가입 사용자 2",
    });
    const unlimitedPendingThree = await users.loginWithGoogle({
      id: "unlimited-pending-three",
      email: "unlimited-three@example.com",
      name: "무제한 가입 사용자 3",
    });
    const unlimitedPendingFour = await users.loginWithGoogle({
      id: "unlimited-pending-four",
      email: "unlimited-four@example.com",
      name: "무제한 가입 사용자 4",
    });
    assert.ok(unlimitedPendingOne.ok);
    assert.ok(unlimitedPendingTwo.ok);
    assert.ok(unlimitedPendingThree.ok);
    assert.ok(unlimitedPendingFour.ok);
    const unlimitedInvite = await users.createInvitation(
      { expiresInMinutes: 60, usageMode: "unlimited" },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const unlimitedRef = {
      id: unlimitedInvite.id,
      tokenVersion: unlimitedInvite.tokenVersion,
    };
    const unlimitedCode = tokens.createInvitationCode(unlimitedRef);
    const unlimitedRedemptions = await Promise.all([
      users.redeemInvitationForUser(unlimitedPendingOne.user.id, unlimitedRef),
      users.redeemInvitationForUser(unlimitedPendingTwo.user.id, unlimitedRef),
    ]);
    assert.equal(
      unlimitedRedemptions.filter((result) => result.ok).length,
      2,
      "무제한 코드는 서로 다른 사용자가 동시에 써도 모두 승인한다",
    );
    let unlimitedStored = (await users.listInvitations({ fresh: true })).find(
      (item) => item.id === unlimitedInvite.id,
    );
    assert.equal(unlimitedStored?.usageCount, 2);
    assert.equal(unlimitedStored?.active, true);
    assert.equal((await users.findInvitation(unlimitedRef)).ok, true);
    assert.deepEqual(tokens.parseInvitationCode(unlimitedCode), unlimitedRef);

    assert.deepEqual(
      await users.redeemInvitationForUser(
        unlimitedPendingOne.user.id,
        unlimitedRef,
      ),
      { ok: false, reason: "invite_required" },
      "이미 가입한 사용자가 같은 코드를 다시 입력해도 사용 횟수를 늘리지 않는다",
    );
    unlimitedStored = (await users.listInvitations({ fresh: true })).find(
      (item) => item.id === unlimitedInvite.id,
    );
    assert.equal(unlimitedStored?.usageCount, 2);

    await users.setInvitationActive(unlimitedInvite.id, false);
    assert.deepEqual(await users.findInvitation(unlimitedRef, { fresh: true }), {
      ok: false,
      reason: "invite_inactive",
    });
    assert.deepEqual(
      await users.redeemInvitationForUser(
        unlimitedPendingThree.user.id,
        unlimitedRef,
      ),
      { ok: false, reason: "invite_inactive" },
    );
    await users.setInvitationActive(unlimitedInvite.id, true);
    assert.equal(
      (
        await users.redeemInvitationForUser(
          unlimitedPendingThree.user.id,
          unlimitedRef,
        )
      ).ok,
      true,
    );
    const beforeUnlimitedRotate = (
      await users.listInvitations({ fresh: true })
    ).find((item) => item.id === unlimitedInvite.id);
    assert.equal(beforeUnlimitedRotate?.usageCount, 3);
    const rotatedUnlimited = await users.rotateInvitation(unlimitedInvite.id);
    assert.ok(rotatedUnlimited);
    assert.equal(rotatedUnlimited.usageCount, 3);
    assert.equal(rotatedUnlimited.lastUsedAt, beforeUnlimitedRotate?.lastUsedAt);
    assert.equal(
      rotatedUnlimited.lastUsedByEmail,
      unlimitedPendingThree.user.email,
    );
    assert.deepEqual(
      tokens.parseInvitationCode(unlimitedCode),
      unlimitedRef,
      "재발급 전 코드도 서명 자체는 해석되고 저장 단계에서 버전이 거절된다",
    );
    const rotatedUnlimitedRef = {
      id: rotatedUnlimited.id,
      tokenVersion: rotatedUnlimited.tokenVersion,
    };
    assert.deepEqual(
      await users.redeemInvitationForUser(
        unlimitedPendingFour.user.id,
        tokens.parseInvitationCode(unlimitedCode)!,
      ),
      { ok: false, reason: "invite_invalid" },
      "재발급 전 코드의 버전은 최종 저장 단계에서 거절한다",
    );
    assert.equal(
      (
        await users.redeemInvitationForUser(
          unlimitedPendingFour.user.id,
          rotatedUnlimitedRef,
        )
      ).ok,
      true,
      "무제한 코드는 사용 뒤 재발급해도 누적 감사값을 이어서 쓴다",
    );
    unlimitedStored = (await users.listInvitations({ fresh: true })).find(
      (item) => item.id === unlimitedInvite.id,
    );
    assert.equal(unlimitedStored?.usageCount, 4);
    assert.equal(unlimitedStored?.lastUsedByEmail, unlimitedPendingFour.user.email);

    const expiringUnlimited = await users.createInvitation(
      { expiresInMinutes: 5, usageMode: "unlimited" },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const expiringUnlimitedRef = {
      id: expiringUnlimited.id,
      tokenVersion: expiringUnlimited.tokenVersion,
    };
    fakeNow += 5 * 60_000;
    assert.deepEqual(
      await users.findInvitation(expiringUnlimitedRef, { fresh: true }),
      { ok: false, reason: "invite_expired" },
      "무제한 코드도 유효기간이 지나면 더 쓸 수 없다",
    );

    await users.setInvitationActive(invitation.id, false);
    const inactive = await users.findInvitation(ref, { fresh: true });
    assert.deepEqual(inactive, { ok: false, reason: "invite_inactive" });
    await users.setInvitationActive(invitation.id, true);

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
      { expiresInMinutes: 10, usageMode: "once" },
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
    assert.deepEqual(tokens.parseInvitationCode(oldCode), oldRef);
    assert.equal(
      (
        await users.findInvitation(
          { id: rotated.id, tokenVersion: rotated.tokenVersion },
          { fresh: true },
        )
      ).ok,
      true,
    );
    assert.deepEqual(
      tokens.parseInvitationCode(
        tokens.createInvitationCode({
          id: rotated.id,
          tokenVersion: rotated.tokenVersion,
        }),
      ),
      { id: rotated.id, tokenVersion: rotated.tokenVersion },
    );

    const removableInvite = await users.createInvitation(
      { usageMode: "once" },
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
      { usageMode: "once" },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const secondUnused = await users.createInvitation(
      { usageMode: "once" },
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
    const invitationsAfterRemoval = await users.listInvitations();
    for (const ref of [firstUnusedRef, secondUnusedRef]) {
      const unaffected = invitationsAfterRemoval.find(
        (item) => item.id === ref.id,
      );
      assert.equal(unaffected?.active, true);
      assert.equal(unaffected?.tokenVersion, ref.tokenVersion);
      assert.equal(
        (await users.findInvitation(ref, { fresh: true })).ok,
        true,
        "사용자 삭제는 특정 수신자가 없는 범용 코드를 바꾸지 않는다",
      );
    }
    const afterRemovalLogin = await users.loginWithGoogle(removableProfile);
    assert.ok(afterRemovalLogin.ok);
    assert.equal(
      afterRemovalLogin.user.status,
      "pending",
      "삭제된 사용자가 다시 Google 인증하면 코드 입력 대기 상태가 된다",
    );
    assert.equal(
      (
        await users.redeemInvitationForUser(removableProfile.id, {
          id: firstUnused.id,
          tokenVersion: firstUnused.tokenVersion,
        })
      ).ok,
      true,
      "삭제 뒤 다시 로그인한 사용자도 기존 범용 코드를 쓸 수 있다",
    );
    assert.equal(
      (await users.findInvitation(secondUnusedRef, { fresh: true })).ok,
      true,
      "다른 범용 코드는 그대로 남는다",
    );

    const blockedUser = await users.setStatus(profile.id, "blocked");
    assert.equal(blockedUser?.sessionVersion, 2, "차단도 세션 버전을 올린다");
    const blockedInvite = await users.createInvitation(
      { usageMode: "once" },
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
    process.env.GOOGLE_CLIENT_SECRET = "test-oauth-secret";
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
      assert.doesNotMatch(location, /test-oauth-secret|test-code/);
      assert.equal(response.cookies.get("sharedesk_oauth")?.value, "");
    };

    try {
      let receivedTimeoutSignal = false;
      globalThis.fetch = (async (_input, init) => {
        receivedTimeoutSignal = init?.signal instanceof AbortSignal;
        throw new TypeError("test-oauth-secret network detail");
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
          return Response.json({ access_token: "test-oauth-secret" });
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
          ? Response.json({ access_token: "test-oauth-secret" })
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
            ? Response.json({ access_token: "test-oauth-secret" })
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
            ? Response.json({ access_token: "test-oauth-secret" })
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
          ? Response.json({ access_token: "test-oauth-secret" })
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
          ? Response.json({ access_token: "test-oauth-secret" })
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
        "/spaces",
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
