import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
// 문맥 재설계 이후 resolveSpaceSession은 (token, space) 를 명시 인자로 받고
// next/headers를 모른다 — 실제 함수를 그대로 돌려 검증한다.

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
  context: typeof import("../src/lib/space-context");
  access: typeof import("../src/lib/space-access");
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
      context: await import("../src/lib/space-context"),
      access: await import("../src/lib/space-access"),
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

    const result = await mods.context.resolveSpaceSession(cookie, SPACE_A, {
      fresh: true,
    });
    assert.equal(result.kind, "ok", "멤버는 세션을 얻어야 한다");
    assert.ok(result.kind === "ok");
    // 역할은 스페이스 명단의 것 — 같은 사람이 스페이스마다 다른 역할.
    assert.equal(result.session.role, "viewer");

    // 같은 토큰이 기본 데스크(space null)에서는 기본 명단의 역할을 받는다.
    const base = await mods.context.resolveSpaceSession(cookie, null, {
      fresh: true,
    });
    assert.ok(base.kind === "ok");
    assert.equal(base.session.role, "editor");
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
    const result = await mods.context.resolveSpaceSession(cookie, SPACE_A, {
      fresh: true,
    });
    assert.equal(result.kind, "not-member");
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

    const result = await mods.context.resolveSpaceSession(cookie, SPACE_A, {
      fresh: true,
    });
    assert.equal(result.kind, "ok", "관리자는 세션을 얻어야 한다");
    assert.ok(result.kind === "ok");
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
    const result = await mods.context.resolveSpaceSession(stale, SPACE_A, {
      fresh: true,
    });
    assert.equal(result.kind, "unauthenticated");
  });
});

test("판정은 호출 시점의 주변 문맥과 무관하게 같은 답을 낸다", async () => {
  await withEnv({ ADMIN_EMAILS: "boss@example.com" }, async (mods) => {
    const adapter = mods.storage.getAdapter();
    await mods.space.runWithSpace(null, () =>
      adapter.writeState(
        "users.json",
        usersFile([makeUser("u-4", "member@example.com", "editor")]),
      ),
    );
    await mods.space.runWithSpace(SPACE_A, () =>
      adapter.writeState(
        "users.json",
        usersFile([makeUser("u-4", "member@example.com", "viewer")]),
      ),
    );
    const cookie = await mods.token.signPayload({
      t: "user",
      sub: "u-4",
      iat: Math.floor(Date.now() / 1000),
    });

    // 엉뚱한 스페이스 문맥 안에서 불러도(=이전 요청의 문맥이 남아 있던 상황을
    // 흉내) 판정 인자가 명시적이므로 결과가 흔들리지 않는다.
    const insideForeign = await mods.space.runWithSpace(
      { slug: "z", folderId: ".spaces/z" },
      () => mods.context.resolveSpaceSession(cookie, SPACE_A, { fresh: true }),
    );
    assert.ok(insideForeign.kind === "ok");
    assert.equal(insideForeign.session.role, "viewer");
  });
});

test("들어갈 수 있는 스페이스 판정과 로그인 목적지 (#12 목록·나가기 기준)", async () => {
  await withEnv({ ADMIN_EMAILS: "boss@example.com" }, async (mods) => {
    const adapter = mods.storage.getAdapter();
    await mods.space.runWithSpace(null, async () => {
      await adapter.writeState(
        "users.json",
        usersFile([makeUser("u-m", "member@example.com", "editor")]),
      );
      await adapter.writeState("spaces.json", {
        version: 1,
        spaces: [
          {
            slug: "a",
            name: "가",
            folderId: ".spaces/a",
            createdAt: new Date().toISOString(),
            createdByUserId: "u-boss",
          },
          {
            slug: "b",
            name: "나",
            folderId: ".spaces/b",
            createdAt: new Date().toISOString(),
            createdByUserId: "u-boss",
          },
        ],
      });
    });
    // u-m은 a에만 멤버다.
    await mods.space.runWithSpace(SPACE_A, () =>
      adapter.writeState(
        "users.json",
        usersFile([makeUser("u-m", "member@example.com", "viewer")]),
      ),
    );

    const admin = await mods.access.listAccessibleSpaces(
      { userId: "u-boss", isAdmin: true, isGuest: false },
      { fresh: true },
    );
    assert.deepEqual(
      admin.map((space) => space.slug),
      ["a", "b"],
      "관리자는 모든 스페이스",
    );

    const member = await mods.access.listAccessibleSpaces(
      { userId: "u-m", isAdmin: false, isGuest: false },
      { fresh: true },
    );
    assert.deepEqual(
      member.map((space) => space.slug),
      ["a"],
      "일반 사용자는 명단에 approved로 있는 곳만",
    );

    const guest = await mods.access.listAccessibleSpaces(
      { userId: "key:x", isAdmin: false, isGuest: true },
      { fresh: true },
    );
    assert.deepEqual(guest, [], "손님은 스페이스 없음");

    // 로그인 목적지는 항상 데스크 선택(#14) — 스페이스 수와 무관하게 main
    // 카드가 있는 /spaces가 전 단계다(손님 분기는 호출자가 한다).
    assert.equal(mods.access.LANDING_PATH, "/spaces");
  });
});

// ---- 요청 경계: 문맥은 run() 블록 밖으로 새지 않는다 ----

test("runWithSpace 문맥은 await를 지나도 유지되고 블록이 끝나면 복원된다", async () => {
  const space = await import("../src/lib/space-store");
  assert.equal(space.currentSpaceSlug(), null);

  const seen = await space.runWithSpace(
    { slug: "a", folderId: ".spaces/a" },
    async () => {
      const before = space.currentSpaceSlug();
      await new Promise((resolve) => setTimeout(resolve, 5));
      // await 뒤에도 같은 문맥이 보인다 — enterWith와 달리 run()은 이 구간을
      // 자기 문맥으로 감싼다.
      const after = space.currentSpaceSlug();
      // 중첩: 안쪽이 이기고,
      const nested = space.runWithSpace(
        { slug: "b", folderId: ".spaces/b" },
        () => space.currentSpaceSlug(),
      );
      // 끝나면 바깥 문맥이 복원된다.
      const restored = space.currentSpaceSlug();
      return { before, after, nested, restored };
    },
  );
  assert.deepEqual(seen, {
    before: "a",
    after: "a",
    nested: "b",
    restored: "a",
  });

  // 블록 밖 — 다음 요청에 해당하는 위치 — 에는 아무 문맥도 남지 않는다.
  assert.equal(space.currentSpaceSlug(), null);
});

test("문맥 세우기는 run()뿐이다 — enterWith 금지", async () => {
  const store = await readFile(
    new URL("../src/lib/space-store.ts", import.meta.url),
    "utf8",
  );
  // 주석의 언급은 허용하고 실제 호출(.enterWith( )만 금지한다.
  assert.doesNotMatch(store, /\.enterWith\(/, "enterWith 호출이 되살아났다");
  const api = await readFile(
    new URL("../src/lib/api.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(api, /\.enterWith\(/);
  // 러너가 핸들러 본문 전체를 스페이스 문맥으로 감싼다.
  assert.match(api, /runWithSpace\(toSpaceContext\(resolved\.space\)/);
});
