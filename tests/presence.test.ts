import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

Object.assign(globalThis, { AsyncLocalStorage });

const SESSION_SECRET = "presence-route-test-secret-with-32-characters";
const ACCESS_KEY = "presence-route-access-key";

test("현재 접속 인원은 공유 상태에서 계정별로 집계한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-presence-"));
  const previous = {
    driver: process.env.STORAGE_DRIVER,
    root: process.env.LOCAL_STORAGE_ROOT,
    secret: process.env.SESSION_SECRET,
    keys: process.env.ACCESS_KEYS,
  };
  process.env.STORAGE_DRIVER = "local";
  process.env.LOCAL_STORAGE_ROOT = root;
  process.env.SESSION_SECRET = SESSION_SECRET;
  process.env.ACCESS_KEYS = ACCESS_KEY;

  try {
    const { LocalAdapter } = await import("@/lib/storage/local");
    const {
      leavePresence,
      listPresence,
      PRESENCE_ACTIVE_MS,
      touchPresence,
    } = await import("@/lib/presence");
    const adapter = new LocalAdapter();
    const now = 1_800_000_000_000;

    await Promise.all([
      touchPresence(
        { participantId: "user:a", leaseId: "device-a", name: "가람" },
        now,
        adapter,
      ),
      touchPresence(
        { participantId: "user:b", leaseId: "device-b", name: "나래" },
        now + 1,
        adapter,
      ),
    ]);
    await touchPresence(
      { participantId: "user:a", leaseId: "device-a", name: "가람 새 이름" },
      now + 2,
      adapter,
    );

    await touchPresence(
      { participantId: "user:a", leaseId: "device-a-2", name: "가람 새 이름" },
      now + 3,
      adapter,
    );
    const active = await listPresence("user:a", now + 3, adapter);
    assert.equal(active.count, 2);
    assert.deepEqual(active.members, [
      { name: "가람 새 이름", isSelf: true },
      { name: "나래", isSelf: false },
    ]);
    assert.equal(active.activeWindowMs, PRESENCE_ACTIVE_MS);

    const expired = await listPresence(
      "user:a",
      now + PRESENCE_ACTIVE_MS + 4,
      adapter,
    );
    assert.equal(expired.count, 0);

    const afterOneDeviceLeaves = await leavePresence(
      { participantId: "user:a", leaseId: "device-a", name: "가람" },
      now + 4,
      adapter,
    );
    assert.equal(afterOneDeviceLeaves.count, 2);
    assert.ok(afterOneDeviceLeaves.members.some((member) => member.isSelf));

    await touchPresence(
      { participantId: "user:a", leaseId: "device-a-2", name: "가람 최신" },
      now + 20,
      adapter,
    );
    await touchPresence(
      { participantId: "user:a", leaseId: "device-a-2", name: "가람 오래된 응답" },
      now + 10,
      adapter,
    );
    const monotonic = await listPresence("user:a", now + 20, adapter);
    assert.equal(monotonic.members[0].name, "가람 최신");

    const afterLeave = await leavePresence(
      { participantId: "user:a", leaseId: "device-a-2", name: "가람" },
      now + 21,
      adapter,
    );
    assert.equal(afterLeave.count, 1);
    assert.equal(afterLeave.members[0].name, "나래");

    const { NextRequest } = await import("next/server");
    const { createKeySession } = await import("@/lib/auth");
    const { createRequestStoreForAPI } = await import(
      "next/dist/server/async-storage/request-store.js"
    );
    const { workUnitAsyncStorage } = await import(
      "next/dist/server/app-render/work-unit-async-storage.external.js"
    );
    const { workAsyncStorage } = await import(
      "next/dist/server/app-render/work-async-storage.external.js"
    );
    type WorkStore = import(
      "next/dist/server/app-render/work-async-storage.external.js"
    ).WorkStore;
    const token = await createKeySession(
      createHash("sha256").update(ACCESS_KEY).digest("hex"),
    );
    const route = await import("@/app/api/presence/route");

    async function call(
      handler: () => Promise<Response>,
      authenticated = true,
    ): Promise<Response> {
      const headers = new Headers();
      if (authenticated) {
        headers.set("Cookie", `sharedesk_session=${token}`);
      }
      const request = new NextRequest("http://localhost/api/presence", {
        method: "POST",
        headers,
      });
      const requestStore = createRequestStoreForAPI(
        request,
        { pathname: "/api/presence", search: "" },
        { tags: [], expirationsByCacheKind: new Map() },
        undefined,
        undefined,
        undefined,
      );
      const workStore = {
        route: "/api/presence",
        forceStatic: false,
      } as unknown as WorkStore;
      return workAsyncStorage.run(workStore, () =>
        workUnitAsyncStorage.run(requestStore, handler),
      );
    }

    const unauthorized = await call(route.POST, false);
    assert.equal(unauthorized.status, 401);
    const heartbeat = await call(route.POST);
    assert.equal(heartbeat.status, 200);
    const heartbeatBody = (await heartbeat.json()) as {
      count: number;
      members: Array<{ name: string; isSelf: boolean }>;
    };
    assert.ok(heartbeatBody.count >= 1);
    assert.ok(
      heartbeatBody.members.some(
        (member) => member.name === "손님" && member.isSelf,
      ),
    );
  } finally {
    if (previous.driver === undefined) delete process.env.STORAGE_DRIVER;
    else process.env.STORAGE_DRIVER = previous.driver;
    if (previous.root === undefined) delete process.env.LOCAL_STORAGE_ROOT;
    else process.env.LOCAL_STORAGE_ROOT = previous.root;
    if (previous.secret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previous.secret;
    if (previous.keys === undefined) delete process.env.ACCESS_KEYS;
    else process.env.ACCESS_KEYS = previous.keys;
    await rm(root, { recursive: true, force: true });
  }
});

test("상단 접속 상태는 실제 인원 목록을 열고 로그아웃 때 현재 접속을 끝낸다", async () => {
  const [view, css] = await Promise.all([
    readFile("src/app/files/FilesView.tsx", "utf8"),
    readFile("src/app/files/desktop.module.css", "utf8"),
  ]);

  assert.match(view, /fetch\("\/api\/presence", \{\s*method: "POST"/);
  assert.match(view, /document\.visibilityState === "visible"/);
  assert.match(view, /aria-controls="presence-panel"/);
  assert.match(view, /현재 접속 인원/);
  assert.match(view, /presence\.members\.map/);
  assert.match(
    view,
    /fetch\("\/api\/presence", \{\s*method: "DELETE"[\s\S]*?keepalive: true/,
  );
  assert.match(css, /\.presencePanel\s*\{/);
  assert.match(css, /\.liveDotError\s*\{/);
});
