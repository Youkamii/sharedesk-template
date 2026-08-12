import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("기기별 세션을 개별·전체 폐기하고 오래된 명단을 안전하게 읽는다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-device-session-"));
  const stateDir = path.join(root, ".sharedesk");
  await mkdir(stateDir, { recursive: true });

  const historicalSessions = Array.from({ length: 23 }, (_, index) => ({
    id: `history-${String(index).padStart(32, "0")}`,
    createdAt: new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString(),
    deviceLabel: `기기 ${index}`,
  }));
  await writeFile(
    path.join(stateDir, "users.json"),
    JSON.stringify({
      version: 1,
      rev: 1,
      users: [
        {
          id: "member-sub",
          email: "member@example.com",
          name: "사용자",
          status: "approved",
          isAdmin: false,
          createdAt: "2025-01-01T00:00:00.000Z",
          sessionsValidFrom: 0,
        },
        {
          id: "history-sub",
          email: "history@example.com",
          name: "기록 사용자",
          status: "approved",
          isAdmin: false,
          createdAt: "2025-01-01T00:00:00.000Z",
          sessionsValidFrom: 0,
          sessionVersion: 0,
          sessions: [
            ...historicalSessions,
            {
              id: "short",
              createdAt: "2025-01-01T01:00:00.000Z",
              deviceLabel: "잘못된 ID",
            },
            {
              id: "bad-date-00000000000000000000000000000000",
              createdAt: "not-a-date",
              deviceLabel: "잘못된 시각",
            },
            {
              id: "bad-label-0000000000000000000000000000000",
              createdAt: "2025-01-01T01:00:00.000Z",
              deviceLabel: "줄바꿈\n라벨",
            },
          ],
        },
      ],
    }),
    "utf8",
  );

  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  process.env.SESSION_SECRET = "device-session-secret-with-32-characters";
  process.env.ADMIN_EMAILS = "admin@example.com";

  const users = await import("@/lib/users");
  const auth = await import("@/lib/auth");
  const tokens = await import("@/lib/session-token");

  try {
    const normalized = await users.listUsers();
    const historical = normalized.find((user) => user.id === "history-sub");
    assert.ok(historical);
    assert.equal(historical.sessions.length, users.MAX_DEVICE_SESSIONS);
    assert.equal(historical.sessions[0].id, historicalSessions[3].id);
    assert.equal(historical.sessions.at(-1)?.id, historicalSessions[22].id);

    const member = normalized.find((user) => user.id === "member-sub");
    assert.ok(member);
    assert.deepEqual(member.sessions, [], "sessions 없는 예전 레코드를 빈 목록으로 읽는다");

    const adminLogin = await users.loginWithGoogle({
      id: "admin-sub",
      email: "admin@example.com",
      name: "관리자",
    });
    assert.ok(adminLogin.ok);
    await assert.rejects(
      () => users.revokeDeviceSession("admin-sub", adminLogin.session.id),
      /관리자 계정의 세션은 끊을 수 없습니다/,
    );

    const legacyToken = await tokens.signPayload({
      t: "user",
      sub: member.id,
      iat: Math.floor(Date.now() / 1000),
    });
    assert.ok(await auth.resolveSession(legacyToken, { fresh: true }));

    const chromeLogin = await users.loginWithGoogle(
      { id: member.id, email: member.email, name: member.name },
      undefined,
      {
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0 Safari/537.36",
      },
    );
    const firefoxLogin = await users.loginWithGoogle(
      { id: member.id, email: member.email, name: member.name },
      undefined,
      {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15) Firefox/141.0",
      },
    );
    assert.ok(chromeLogin.ok);
    assert.ok(firefoxLogin.ok);
    assert.notEqual(chromeLogin.session.id, firefoxLogin.session.id);
    assert.equal(chromeLogin.session.deviceLabel, "Chrome · Windows");
    assert.equal(firefoxLogin.session.deviceLabel, "Firefox · macOS");

    const chromeToken = await auth.createUserSession(
      chromeLogin.user.id,
      chromeLogin.user.sessionVersion,
      chromeLogin.session.id,
    );
    const firefoxToken = await auth.createUserSession(
      firefoxLogin.user.id,
      firefoxLogin.user.sessionVersion,
      firefoxLogin.session.id,
    );
    assert.ok(await auth.resolveSession(chromeToken, { fresh: true }));
    assert.ok(await auth.resolveSession(firefoxToken, { fresh: true }));

    const oneRevoked = await users.revokeDeviceSession(
      member.id,
      chromeLogin.session.id,
    );
    assert.equal(oneRevoked?.revoked, true);
    assert.equal(await auth.resolveSession(chromeToken, { fresh: true }), null);
    assert.equal(await auth.resolveIdentity(chromeToken), null);
    assert.ok(await auth.resolveSession(firefoxToken, { fresh: true }));
    assert.ok(
      await auth.resolveSession(legacyToken, { fresh: true }),
      "sid 없는 구형 쿠키는 개별 식별할 수 없어 전체 폐기 전까지 유지한다",
    );

    const allRevoked = await users.revokeSessions(member.id);
    assert.equal(allRevoked?.sessionVersion, 1);
    assert.deepEqual(allRevoked?.sessions, []);
    assert.equal(await auth.resolveSession(firefoxToken, { fresh: true }), null);
    assert.equal(await auth.resolveSession(legacyToken, { fresh: true }), null);

    const afterRevoke = await users.loginWithGoogle({
      id: member.id,
      email: member.email,
      name: member.name,
    });
    assert.ok(afterRevoke.ok);
    const afterRevokeToken = await auth.createUserSession(
      afterRevoke.user.id,
      afterRevoke.user.sessionVersion,
      afterRevoke.session.id,
    );
    assert.ok(await auth.resolveSession(afterRevokeToken, { fresh: true }));
    const blocked = await users.setStatus(member.id, "blocked");
    assert.equal(blocked?.sessionVersion, 2);
    assert.deepEqual(blocked?.sessions, []);
    assert.equal(await auth.resolveSession(afterRevokeToken, { fresh: true }), null);
    assert.equal(await auth.resolveIdentity(afterRevokeToken), null);

    await users.setStatus(member.id, "approved");
    const cappedLogins: Array<
      Extract<
        Awaited<ReturnType<typeof users.loginWithGoogle>>,
        { ok: true }
      >
    > = [];
    for (let index = 0; index < users.MAX_DEVICE_SESSIONS + 1; index += 1) {
      const login = await users.loginWithGoogle({
        id: member.id,
        email: member.email,
        name: member.name,
      });
      assert.ok(login.ok);
      cappedLogins.push(login);
    }
    const capped = await users.findUserById(member.id, { fresh: true });
    assert.equal(capped?.sessions.length, users.MAX_DEVICE_SESSIONS);
    assert.equal(
      capped?.sessions.some((session) => session.id === cappedLogins[0].session.id),
      false,
      "상한을 넘으면 가장 오래된 로그인부터 버린다",
    );
    const oldestToken = await auth.createUserSession(
      cappedLogins[0].user.id,
      cappedLogins[0].user.sessionVersion,
      cappedLogins[0].session.id,
    );
    const newest = cappedLogins.at(-1);
    assert.ok(newest);
    const newestToken = await auth.createUserSession(
      newest.user.id,
      newest.user.sessionVersion,
      newest.session.id,
    );
    assert.equal(await auth.resolveSession(oldestToken, { fresh: true }), null);
    assert.ok(await auth.resolveSession(newestToken, { fresh: true }));

    await users.setStatus(member.id, "pending");
    assert.equal(await auth.resolveSession(newestToken, { fresh: true }), null);
    await users.setStatus(member.id, "approved");
    const removableLogin = await users.loginWithGoogle({
      id: member.id,
      email: member.email,
      name: member.name,
    });
    assert.ok(removableLogin.ok);
    const removableToken = await auth.createUserSession(
      removableLogin.user.id,
      removableLogin.user.sessionVersion,
      removableLogin.session.id,
    );
    assert.equal(await users.removeUser(member.id), true);
    assert.equal(await auth.resolveSession(removableToken, { fresh: true }), null);

    await assert.rejects(
      () => auth.createUserSession("history-sub", 0, "short"),
      /세션 ID/,
    );
    await assert.rejects(
      () => users.revokeDeviceSession("history-sub", "short"),
      /세션 ID/,
    );
    for (const sid of ["short", "a".repeat(65), `valid-looking-id-0000\n`]) {
      const malformed = await tokens.signPayload({
        t: "user",
        sub: "history-sub",
        sv: 0,
        sid,
        iat: Math.floor(Date.now() / 1000),
      });
      assert.equal(await tokens.openSigned(malformed), null);
    }

    const sanitized = users.deviceLabelFromUserAgent(
      `직접 만든 브라우저\n${"x".repeat(200)}`,
    );
    assert.equal(/[\u0000-\u001f\u007f]/.test(sanitized), false);
    assert.ok(sanitized.length <= users.MAX_DEVICE_LABEL_LENGTH);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
