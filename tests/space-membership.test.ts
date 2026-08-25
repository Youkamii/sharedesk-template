import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 멤버십 판정 모델: 정체·세션 유효성은 기본 데스크가 단일 진실 원천이고,
// 스페이스 명단에서는 멤버십과 역할만 읽는다.
// - 기본에 없는 토큰 → 어디서도 세션 없음 (기본에서 철회하면 스페이스도 즉시 죽음)
// - 관리자 → 모든 스페이스, role admin
// - 일반 사용자 → 그 스페이스 명단에 approved로 있어야 하고 역할은 그 명단의 것
//
// resolveSpaceSession은 cookies()를 읽는 요청 전용이라, 같은 판정 순서를
// resolveSession + findUserById로 재현해 검증한다.

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

function makeUser(
  id: string,
  email: string,
  role: string,
  sessionVersion = 0,
) {
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
    sessionVersion,
    sessions: [],
  };
}

type Mods = {
  space: typeof import("../src/lib/space-store");
  token: typeof import("../src/lib/session-token");
  auth: typeof import("../src/lib/auth");
  users: typeof import("../src/lib/users");
  storage: typeof import("../src/lib/storage");
};

async function withEnv(
  env: Record<string, string>,
  run: (mods: Mods) => Promise<void>,
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
      users: await import("../src/lib/users"),
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

const SPACE_A = { slug: "a", folderId: ".spaces/a" };

// resolveSpaceSession과 같은 판정 순서.
async function resolveForSpace(mods: Mods, token: string) {
  const base = await mods.space.runWithSpace(null, () =>
    mods.auth.resolveSession(token, { fresh: true }),
  );
  if (!base) return null;
  if (base.isAdmin) return { via: "admin", session: base };
  const member = await mods.space.runWithSpace(SPACE_A, () =>
    mods.users.findUserById(base.userId, { fresh: true }),
  );
  if (!member || member.status !== "approved") return null;
  return { via: "member", session: { ...base, role: member.role } };
}

test("멤버는 스페이스 명단의 역할로 세션을 얻는다", async () => {
  await withEnv({ ADMIN_EMAILS: "boss@example.com" }, async (mods) => {
    const adapter = mods.storage.getAdapter();
    // 기본 데스크에 editor로 가입돼 있고, A 스페이스 명단에는 viewer.
    await mods.space.runWithSpace(null, () =>
      adapter.writeState(
        "users.json",
        usersFile([makeUser("u-1", "member@example.com", "editor")]),
      ),
    );
    await mods.space.runWithSpace(SPACE_A, () =>
      adapter.writeState(
        "users.json",
        usersFile([makeUser("u-1", "member@example.com", "viewer")]),
      ),
    );
    const cookie = await mods.token.signPayload({
      t: "user",
      sub: "u-1",
      iat: Math.floor(Date.now() / 1000),
    });

    const result = await resolveForSpace(mods, cookie);
    assert.ok(result, "멤버는 세션을 얻어야 한다");
    assert.equal(result.via, "member");
    // 역할은 스페이스 명단의 것 — 같은 사람이 스페이스마다 다른 역할.
    assert.equal(result.session.role, "viewer");
  });
});

test("스페이스 명단에 없는 일반 사용자는 세션을 얻지 못한다", async () => {
  await withEnv({ ADMIN_EMAILS: "boss@example.com" }, async (mods) => {
    const adapter = mods.storage.getAdapter();
    await mods.space.runWithSpace(null, () =>
      adapter.writeState(
        "users.json",
        usersFile([makeUser("u-2", "outsider@example.com", "editor")]),
      ),
    );
    const cookie = await mods.token.signPayload({
      t: "user",
      sub: "u-2",
      iat: Math.floor(Date.now() / 1000),
    });
    assert.equal(await resolveForSpace(mods, cookie), null);
  });
});

test("관리자는 스페이스 명단에 없어도 admin으로 들어간다", async () => {
  await withEnv({ ADMIN_EMAILS: "boss@example.com" }, async (mods) => {
    const adapter = mods.storage.getAdapter();
    await mods.space.runWithSpace(null, () =>
      adapter.writeState(
        "users.json",
        usersFile([makeUser("u-boss", "boss@example.com", "viewer")]),
      ),
    );
    await mods.space.runWithSpace(SPACE_A, () =>
      adapter.writeState("users.json", usersFile([])),
    );
    const cookie = await mods.token.signPayload({
      t: "user",
      sub: "u-boss",
      iat: Math.floor(Date.now() / 1000),
    });

    const result = await resolveForSpace(mods, cookie);
    assert.ok(result, "관리자는 세션을 얻어야 한다");
    assert.equal(result.via, "admin");
    assert.equal(result.session.role, "admin");
  });
});

test("기본 데스크에서 철회한 세션은 스페이스에서도 죽는다", async () => {
  await withEnv({ ADMIN_EMAILS: "boss@example.com" }, async (mods) => {
    const adapter = mods.storage.getAdapter();
    // 기본 데스크의 sessionVersion이 5로 올라갔다(철회). 스페이스 명단에는
    // 옛 레코드(sv 0)가 남아 있다 — 명단 복사가 뒤처진 상황.
    await mods.space.runWithSpace(null, () =>
      adapter.writeState(
        "users.json",
        usersFile([makeUser("u-3", "member@example.com", "editor", 5)]),
      ),
    );
    await mods.space.runWithSpace(SPACE_A, () =>
      adapter.writeState(
        "users.json",
        usersFile([makeUser("u-3", "member@example.com", "editor", 0)]),
      ),
    );
    // sv 없는 옛 토큰 — 기본 데스크(sv 5)에서 무효다.
    const stale = await mods.token.signPayload({
      t: "user",
      sub: "u-3",
      iat: Math.floor(Date.now() / 1000),
    });
    // 정체 판정이 기본 데스크 기준이므로 스페이스에서도 거부된다. 스페이스
    // 명단의 옛 sv로 판정했다면 이 토큰이 살아남았을 것이다 — 그게 보안 갭.
    assert.equal(await resolveForSpace(mods, stale), null);
  });
});
