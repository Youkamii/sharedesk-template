import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 멤버십 판정: 스페이스 문맥에서 누가 세션을 얻는가.
// - 그 스페이스 users.json에 있는 사용자(초대받은 멤버) → 그 스페이스 역할로 OK
// - 없는 일반 사용자 → 세션 없음 (거부)
// - ADMIN_EMAILS 관리자 → 스페이스에 없어도 기본 데스크 정체로 통과
//
// resolveSpaceSession은 cookies()를 읽는 요청 전용이라, 여기서는 그 두 단계
// 조회 로직(스페이스 우선, 없으면 기본에서 admin 확인)을 resolveSession으로
// 직접 재현해 검증한다. cookies() 해석은 requireSession 통합 테스트가 아닌
// 실배포에서 확인된다.

const SESSION_SECRET = ["test-", "session-secret-32-characters-long"].join("");

function usersFile(users: ReturnType<typeof makeUser>[]) {
  return {
    version: 2,
    rev: 1,
    users,
    invitations: [],
    deskSettings: {
      locale: "en",
      allowMemberLocale: false,
      autoUpdate: false,
      autoUpdateTimezone: null,
      maxUploadBytes: null,
      deskStorageLimitBytes: null,
    },
  };
}

function makeUser(id: string, email: string, role: string) {
  return {
    id,
    email,
    name: email.split("@")[0],
    status: "approved",
    role,
    isAdmin: false,
    createdAt: new Date().toISOString(),
    invitationId: null,
    sessionsValidFrom: 0,
    sessionVersion: 0,
    sessions: [],
  };
}

async function withEnv(
  env: Record<string, string>,
  run: (mods: {
    space: typeof import("../src/lib/space-store");
    token: typeof import("../src/lib/session-token");
    auth: typeof import("../src/lib/auth");
    storage: typeof import("../src/lib/storage");
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "sharedesk-membership-"));
  const applied = {
    STORAGE_DRIVER: "local",
    LOCAL_STORAGE_ROOT: root,
    SESSION_SECRET,
    ...env,
  };
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(applied)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    await run({
      space: await import("../src/lib/space-store"),
      token: await import("../src/lib/session-token"),
      auth: await import("../src/lib/auth"),
      storage: await import("../src/lib/storage"),
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

// 두 단계 조회(space-context.resolveSpaceSession)와 같은 판정을 재현한다.
async function resolveWithFallback(
  space: typeof import("../src/lib/space-store"),
  auth: typeof import("../src/lib/auth"),
  slug: string | null,
  folderId: string | null,
  token: string,
) {
  const scoped = await space.runWithSpace(
    slug ? { slug, folderId } : null,
    () => auth.resolveSession(token, { fresh: true }),
  );
  if (scoped) return { via: "space", session: scoped };
  if (!slug) return null;
  const base = await space.runWithSpace(null, () => auth.resolveSession(token, { fresh: true }));
  if (base?.isAdmin) return { via: "admin-fallback", session: base };
  return null;
}

test("스페이스 멤버는 그 스페이스 역할로 세션을 얻는다", async () => {
  await withEnv({ ADMIN_EMAILS: "boss@example.com" }, async ({ space, token, auth, storage }) => {
    const adapter = storage.getAdapter();
    // A 스페이스에 editor 멤버.
    await space.runWithSpace({ slug: "a", folderId: ".spaces/a" }, () =>
      adapter.writeState("users.json", usersFile([
        makeUser("u-member", "member@example.com", "editor"),
      ])),
    );
    const cookie = await token.signPayload({
      t: "user",
      sub: "u-member",
      iat: Math.floor(Date.now() / 1000),
    });

    const result = await resolveWithFallback(space, auth, "a", ".spaces/a", cookie);
    assert.ok(result, "멤버는 세션을 얻어야 한다");
    assert.equal(result.via, "space");
    assert.equal(result.session.role, "editor");

    // 기본 데스크에는 이 사용자가 없다.
    const base = await space.runWithSpace(null, () => auth.resolveSession(cookie, { fresh: true }));
    assert.equal(base, null);
  });
});

test("스페이스에 없는 일반 사용자는 세션을 얻지 못한다", async () => {
  await withEnv({ ADMIN_EMAILS: "boss@example.com" }, async ({ space, token, auth, storage }) => {
    const adapter = storage.getAdapter();
    // 기본 데스크에만 있는 일반 사용자.
    await space.runWithSpace(null, () =>
      adapter.writeState("users.json", usersFile([
        makeUser("u-out", "outsider@example.com", "editor"),
      ])),
    );
    const cookie = await token.signPayload({
      t: "user",
      sub: "u-out",
      iat: Math.floor(Date.now() / 1000),
    });

    // A 스페이스에는 이 사용자가 없다 → 세션 없음.
    const result = await resolveWithFallback(space, auth, "a", ".spaces/a", cookie);
    assert.equal(result, null, "비멤버는 스페이스 세션을 얻으면 안 된다");
  });
});

test("관리자는 스페이스에 등록되지 않아도 세션을 얻는다", async () => {
  await withEnv({ ADMIN_EMAILS: "boss@example.com" }, async ({ space, token, auth, storage }) => {
    const adapter = storage.getAdapter();
    // 관리자는 기본 데스크에만 있다. A 스페이스 users.json에는 없다.
    await space.runWithSpace(null, () =>
      adapter.writeState("users.json", usersFile([
        makeUser("u-boss", "boss@example.com", "viewer"),
      ])),
    );
    await space.runWithSpace({ slug: "a", folderId: ".spaces/a" }, () =>
      adapter.writeState("users.json", usersFile([])),
    );
    const cookie = await token.signPayload({
      t: "user",
      sub: "u-boss",
      iat: Math.floor(Date.now() / 1000),
    });

    const result = await resolveWithFallback(space, auth, "a", ".spaces/a", cookie);
    assert.ok(result, "관리자는 스페이스 세션을 얻어야 한다");
    assert.equal(result.via, "admin-fallback");
    assert.equal(result.session.isAdmin, true);
    // 세션 역할은 저장값(viewer)이 아니라 admin으로 승격된다.
    assert.equal(result.session.role, "admin");
  });
});
