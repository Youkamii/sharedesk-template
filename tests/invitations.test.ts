import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("초대 링크 생성·전환·1회 소비", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-invite-"));
  await mkdir(path.join(root, ".sharedesk"), { recursive: true });
  await writeFile(
    path.join(root, ".sharedesk", "users.json"),
    JSON.stringify({
      version: 1,
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
    }),
    "utf8",
  );

  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  process.env.SESSION_SECRET = "test-session-secret-with-32-characters";
  process.env.ADMIN_EMAILS = "admin@example.com";

  const users = await import("@/lib/users");
  const tokens = await import("@/lib/invite-token");

  try {
    const migrated = await users.listUsers();
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0].invitationId, null, "v1 사용자 필드를 보존해 읽는다");
    assert.equal(migrated[0].sessionVersion, 0, "기존 명단은 세션 버전 0으로 읽는다");
    assert.deepEqual(migrated[0].sessions, [], "기존 명단은 기기 세션 없이 읽는다");

    const directUnknown = await users.loginWithGoogle({
      id: "new-user",
      email: "new@example.com",
      name: "신규 사용자",
    });
    assert.deepEqual(directUnknown, { ok: false, reason: "invite_required" });
    assert.equal(
      (await users.listUsers()).some((user) => user.id === "new-user"),
      false,
      "초대 없는 신규 로그인은 명단을 만들지 않는다",
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
    const ref = { id: invitation.id, tokenVersion: invitation.tokenVersion };
    const token = tokens.createInvitationToken(ref);
    assert.deepEqual(tokens.openInvitationToken(token), ref);
    assert.equal(tokens.openInvitationToken(`${token}x`), null, "변조 링크는 거절한다");

    const mismatch = await users.loginWithGoogle(
      {
        id: "wrong-user",
        email: "wrong@example.com",
        name: "다른 사람",
      },
      ref,
    );
    assert.deepEqual(mismatch, {
      ok: false,
      reason: "invite_email_mismatch",
    });
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
    const attempts = await Promise.all([
      users.loginWithGoogle(profile, ref),
      users.loginWithGoogle(profile, ref),
    ]);
    assert.equal(attempts.filter((result) => result.ok).length, 1);
    assert.deepEqual(
      attempts.find((result) => !result.ok),
      { ok: false, reason: "invite_used" },
      "동시 소비 중 하나만 성공한다",
    );

    const approved = await users.findUserById(profile.id, { fresh: true });
    assert.equal(approved?.status, "approved");
    assert.equal(approved?.invitationId, invitation.id);
    const repeatedLogin = await users.loginWithGoogle(profile);
    assert.equal(repeatedLogin.ok, true, "기존 사용자는 재로그인한다");
    assert.ok(repeatedLogin.ok);

    const auth = await import("@/lib/auth");
    const sessionTokens = await import("@/lib/session-token");
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
      },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const oldRef = {
      id: rotateTarget.id,
      tokenVersion: rotateTarget.tokenVersion,
    };
    const rotated = await users.rotateInvitation(rotateTarget.id);
    assert.ok(rotated);
    assert.equal((await users.findInvitation(oldRef, { fresh: true })).ok, false);
    assert.equal(
      (
        await users.findInvitation(
          { id: rotated.id, tokenVersion: rotated.tokenVersion },
          { fresh: true },
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
    assert.equal(
      (
        await users.loginWithGoogle(removableProfile, {
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
        note: "첫 번째 미사용 링크",
      },
      { userId: "admin-google-sub", email: "admin@example.com" },
    );
    const secondUnused = await users.createInvitation(
      {
        recipientName: "삭제할 사용자",
        email: removableProfile.email,
        note: "두 번째 미사용 링크",
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
      assert.deepEqual(
        await users.loginWithGoogle(removableProfile, ref),
        { ok: false, reason: "invite_invalid" },
        "사용자를 삭제하면 그 이메일의 기존 미사용 링크가 즉시 폐기된다",
      );
    }
    assert.deepEqual(await users.loginWithGoogle(removableProfile), {
      ok: false,
      reason: "invite_required",
    });
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
        await users.loginWithGoogle(removableProfile, {
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
    const blockedResult = await users.loginWithGoogle(profile, {
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
      "차단 사용자의 실패는 링크를 소비하지 않는다",
    );

    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "private-oauth-secret";
    process.env.PUBLIC_BASE_URL = "http://localhost:3000";
    const { NextRequest } = await import("next/server");
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
    const callbackRequest = (withInvite = false) =>
      new NextRequest(
        "http://localhost:3000/api/auth/google/callback?code=test-code&state=test-state",
        {
          headers: {
            Cookie: `sharedesk_oauth=test-state.test-verifier${
              withInvite ? "; sharedesk_invite=leftover" : ""
            }`,
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
      assert.equal(response.cookies.get("sharedesk_invite")?.value, "");
    };

    try {
      let receivedTimeoutSignal = false;
      globalThis.fetch = (async (_input, init) => {
        receivedTimeoutSignal = init?.signal instanceof AbortSignal;
        throw new TypeError("private-oauth-secret network detail");
      }) as typeof fetch;
      assertCallbackFailure(
        await callbackRoute.GET(callbackRequest(true)),
        "token",
      );
      assert.equal(receivedTimeoutSignal, true, "OAuth 요청에 timeout signal을 건다");

      globalThis.fetch = (async () =>
        new Response("not-json", { status: 200 })) as typeof fetch;
      assertCallbackFailure(
        await callbackRoute.GET(callbackRequest(true)),
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
        await callbackRoute.GET(callbackRequest(true)),
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
        await callbackRoute.GET(callbackRequest(true)),
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
      assert.equal(success.cookies.get("sharedesk_invite")?.value, "");
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
