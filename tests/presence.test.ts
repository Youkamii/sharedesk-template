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
      leavePresenceGroup,
      leavePresence,
      listPresence,
      PRESENCE_ACTIVE_MS,
      PRESENCE_MAX_TABS_PER_SESSION,
      PRESENCE_MAX_TRANSFERS_PER_PARTICIPANT,
      PRESENCE_TRANSFER_ACTIVE_MS,
      presenceTabLeaseId,
      touchPresence,
    } = await import("@/lib/presence");
    const adapter = new LocalAdapter();
    const now = 1_800_000_000_000;

    await adapter.writeState("presence.json", {
      version: 1,
      leases: [
        {
          participantId: "user:legacy",
          leaseId: "legacy-device",
          name: "기존 사용자",
          lastSeenAt: now,
        },
      ],
    });
    assert.deepEqual(
      (await listPresence("user:legacy", now, adapter)).members,
      [{ name: "기존 사용자", isSelf: true, transfers: [] }],
    );
    await leavePresence(
      {
        participantId: "user:legacy",
        leaseId: "legacy-device",
        name: "기존 사용자",
      },
      now,
      adapter,
    );

    await Promise.all([
      touchPresence(
        {
          participantId: "user:a",
          leaseId: "device-a",
          name: "가람",
          transfers: [
            {
              id: "upload-a",
              kind: "upload",
              name: "여행.mp4",
              transferred: 40,
              total: 100,
            },
          ],
        },
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
      {
        participantId: "user:a",
        leaseId: "device-a-2",
        name: "가람 새 이름",
        transfers: [
          {
            id: "download-a",
            kind: "download",
            name: "자료.zip",
            transferred: 10,
            total: null,
          },
        ],
      },
      now + 3,
      adapter,
    );
    const active = await listPresence("user:a", now + 3, adapter);
    assert.equal(active.count, 2);
    assert.deepEqual(active.members, [
      {
        name: "가람 새 이름",
        isSelf: true,
        transfers: [
          {
            id: "download-a",
            kind: "download",
            name: "자료.zip",
            transferred: 10,
            total: null,
            updatedAt: now + 3,
          },
          {
            id: "upload-a",
            kind: "upload",
            name: "여행.mp4",
            transferred: 40,
            total: 100,
            updatedAt: now,
          },
        ],
      },
      { name: "나래", isSelf: false, transfers: [] },
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
      {
        participantId: "user:a",
        leaseId: "device-a-2",
        name: "가람 최신",
        transfers: [
          {
            id: "latest-report",
            kind: "upload",
            name: "최신.bin",
            transferred: 90,
            total: 100,
          },
        ],
      },
      now + 20,
      adapter,
    );
    await touchPresence(
      {
        participantId: "user:a",
        leaseId: "device-a-2",
        name: "가람 오래된 응답",
        transfers: [
          {
            id: "old-report",
            kind: "download",
            name: "오래됨.bin",
            transferred: 1,
            total: 100,
          },
        ],
      },
      now + 10,
      adapter,
    );
    const monotonic = await listPresence("user:a", now + 20, adapter);
    assert.equal(monotonic.members[0].name, "가람 최신");
    assert.deepEqual(monotonic.members[0].transfers, [
      {
        id: "latest-report",
        kind: "upload",
        name: "최신.bin",
        transferred: 90,
        total: 100,
        updatedAt: now + 20,
      },
    ]);

    const afterComplete = await touchPresence(
      {
        participantId: "user:a",
        leaseId: "device-a-2",
        name: "가람 최신",
        transfers: [],
      },
      now + 21,
      adapter,
    );
    assert.deepEqual(afterComplete.members[0].transfers, []);

    const afterLeave = await leavePresence(
      { participantId: "user:a", leaseId: "device-a-2", name: "가람" },
      now + 22,
      adapter,
    );
    assert.equal(afterLeave.count, 1);
    assert.equal(afterLeave.members[0].name, "나래");
    assert.deepEqual(afterLeave.members[0].transfers, []);

    const tabBaseLease = "shared-session-lease";
    const tabOneLease = presenceTabLeaseId(tabBaseLease, "tab_alpha_01");
    const tabTwoLease = presenceTabLeaseId(tabBaseLease, "tab_beta_02");
    await touchPresence(
      {
        participantId: "user:tabs",
        leaseId: tabOneLease,
        name: "여러 탭 사용자",
        transfers: [
          {
            id: "tab-one-upload",
            kind: "upload",
            name: "첫째.bin",
            transferred: 20,
            total: 100,
          },
        ],
      },
      now + 30,
      adapter,
    );
    await touchPresence(
      {
        participantId: "user:tabs",
        leaseId: tabTwoLease,
        name: "여러 탭 사용자",
        transfers: [
          {
            id: "tab-two-download",
            kind: "download",
            name: "둘째.bin",
            transferred: 40,
            total: 100,
          },
        ],
      },
      now + 31,
      adapter,
    );
    const bothTabs = await listPresence("user:tabs", now + 31, adapter);
    assert.deepEqual(
      bothTabs.members.find((member) => member.isSelf)?.transfers.map(
        (transfer) => transfer.id,
      ),
      ["tab-two-download", "tab-one-upload"],
    );

    const oneTabCompleted = await touchPresence(
      {
        participantId: "user:tabs",
        leaseId: tabOneLease,
        name: "여러 탭 사용자",
        transfers: [],
      },
      now + 32,
      adapter,
    );
    assert.deepEqual(
      oneTabCompleted.members
        .find((member) => member.isSelf)
        ?.transfers.map((transfer) => transfer.id),
      ["tab-two-download"],
    );

    const oneTabLeft = await leavePresence(
      {
        participantId: "user:tabs",
        leaseId: tabOneLease,
        name: "여러 탭 사용자",
      },
      now + 33,
      adapter,
    );
    assert.deepEqual(
      oneTabLeft.members
        .find((member) => member.isSelf)
        ?.transfers.map((transfer) => transfer.id),
      ["tab-two-download"],
    );

    const staleTransfer = await listPresence(
      "user:tabs",
      now + 31 + PRESENCE_TRANSFER_ACTIVE_MS + 1,
      adapter,
    );
    assert.equal(
      staleTransfer.members.find((member) => member.isSelf)?.transfers.length,
      0,
    );
    assert.ok(staleTransfer.members.some((member) => member.isSelf));

    const allTabsLeft = await leavePresenceGroup(
      {
        participantId: "user:tabs",
        leaseId: tabBaseLease,
        name: "여러 탭 사용자",
      },
      now + 34,
      adapter,
    );
    assert.ok(!allTabsLeft.members.some((member) => member.isSelf));

    const cappedSessionLease = "capped-session-lease";
    for (let index = 0; index < PRESENCE_MAX_TABS_PER_SESSION + 3; index += 1) {
      await touchPresence(
        {
          participantId: "user:capped-tabs",
          leaseId: presenceTabLeaseId(
            cappedSessionLease,
            `tab_cap_${String(index).padStart(2, "0")}`,
          ),
          name: "탭 제한 사용자",
          transfers: [
            {
              id: `tab-transfer-${index}`,
              kind: "upload",
              name: `${index}.bin`,
              transferred: index,
              total: 100,
            },
          ],
        },
        now + 100 + index,
        adapter,
      );
    }
    const storedAfterTabCap = JSON.parse(
      await readFile(path.join(root, ".sharedesk", "presence.json"), "utf8"),
    ) as {
      leases: Array<{ participantId: string; leaseId: string }>;
    };
    const cappedTabLeases = storedAfterTabCap.leases.filter(
      (lease) => lease.participantId === "user:capped-tabs",
    );
    assert.equal(cappedTabLeases.length, PRESENCE_MAX_TABS_PER_SESSION);
    assert.ok(
      cappedTabLeases.every((lease) =>
        lease.leaseId.startsWith(`${cappedSessionLease}:tab:`),
      ),
    );
    assert.ok(
      !cappedTabLeases.some((lease) => lease.leaseId.endsWith("tab_cap_00")),
    );

    const transferLeases = Array.from({ length: 3 }, (_, leaseIndex) => ({
      participantId: "user:transfer-cap",
      leaseId: `transfer-cap-${leaseIndex}`,
      name: "전송 제한 사용자",
      lastSeenAt: now + 200 + leaseIndex,
      transfers: Array.from({ length: 100 }, (_, transferIndex) => ({
        id:
          transferIndex === 0
            ? "duplicate-transfer"
            : `transfer-${leaseIndex}-${String(transferIndex).padStart(3, "0")}`,
        kind: "upload",
        name: `${leaseIndex}-${transferIndex}.bin`,
        transferred: leaseIndex * 100 + transferIndex,
        total: null,
        updatedAt: now + 200 + leaseIndex,
      })),
    }));
    await adapter.writeState("presence.json", {
      version: 1,
      leases: transferLeases,
    });
    const cappedTransfers = await listPresence(
      "user:transfer-cap",
      now + 202,
      adapter,
    );
    const returnedTransfers = cappedTransfers.members[0].transfers;
    assert.equal(
      returnedTransfers.length,
      PRESENCE_MAX_TRANSFERS_PER_PARTICIPANT,
    );
    assert.equal(
      returnedTransfers.filter((transfer) => transfer.id === "duplicate-transfer")
        .length,
      1,
    );
    assert.equal(
      returnedTransfers.find((transfer) => transfer.id === "duplicate-transfer")
        ?.updatedAt,
      now + 202,
    );

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
      handler: (request: Request) => Promise<Response>,
      authenticated = true,
      body?: unknown,
      extraHeaders?: HeadersInit,
    ): Promise<Response> {
      const headers = new Headers(extraHeaders);
      if (authenticated) {
        headers.set("Cookie", `sharedesk_session=${token}`);
      }
      if (body !== undefined) headers.set("Content-Type", "application/json");
      const request = new NextRequest("http://localhost/api/presence", {
        method: "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
        workUnitAsyncStorage.run(requestStore, () => handler(request)),
      );
    }

    const unauthorized = await call(route.POST, false);
    assert.equal(unauthorized.status, 401);
    const invalid = await call(route.POST, true, {
      tabId: "tab_invalid_01",
      transfers: [
        {
          id: "bad",
          kind: "upload",
          name: "bad.bin",
          transferred: -1,
          total: 10,
        },
      ],
    });
    assert.equal(invalid.status, 400);
    const impossibleProgress = await call(route.POST, true, {
      tabId: "tab_invalid_01",
      transfers: [
        {
          id: "bad-total",
          kind: "download",
          name: "bad-total.bin",
          transferred: 11,
          total: 10,
        },
      ],
    });
    assert.equal(impossibleProgress.status, 400);
    const invalidTab = await call(route.POST, true, {
      tabId: "bad:tab",
      transfers: [],
    });
    assert.equal(invalidTab.status, 400);

    const bodylessHeartbeat = await call(route.POST);
    assert.equal(bodylessHeartbeat.status, 200);

    const declaredOversize = await call(
      route.POST,
      true,
      { tabId: "tab_limit_01", transfers: [] },
      { "Content-Length": String(512 * 1024 + 1) },
    );
    assert.equal(declaredOversize.status, 413);
    assert.deepEqual(await declaredOversize.json(), {
      error: "요청 본문이 너무 큽니다",
    });

    const streamedOversize = new NextRequest("http://localhost/api/presence", {
      method: "POST",
      headers: {
        Cookie: `sharedesk_session=${token}`,
        "Content-Type": "application/json",
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(300 * 1024));
          controller.enqueue(new Uint8Array(300 * 1024));
          controller.close();
        },
      }),
      duplex: "half",
    });
    const streamedRequestStore = createRequestStoreForAPI(
      streamedOversize,
      { pathname: "/api/presence", search: "" },
      { tags: [], expirationsByCacheKind: new Map() },
      undefined,
      undefined,
      undefined,
    );
    const streamedWorkStore = {
      route: "/api/presence",
      forceStatic: false,
    } as unknown as WorkStore;
    const streamedOversizeResponse = await workAsyncStorage.run(
      streamedWorkStore,
      () =>
        workUnitAsyncStorage.run(streamedRequestStore, () =>
          route.POST(streamedOversize),
        ),
    );
    assert.equal(streamedOversizeResponse.status, 413);

    const heartbeat = await call(route.POST, true, {
      tabId: "tab_route_01",
      transfers: [
        {
          id: "route-upload",
          kind: "upload",
          name: "route.bin",
          transferred: 2,
          total: 8,
        },
      ],
    });
    assert.equal(heartbeat.status, 200);
    const heartbeatBody = (await heartbeat.json()) as {
      count: number;
      members: Array<{
        name: string;
        isSelf: boolean;
        transfers: Array<{ id: string; updatedAt: number }>;
      }>;
    };
    assert.ok(heartbeatBody.count >= 1);
    const self = heartbeatBody.members.find(
      (member) => member.name === "손님" && member.isSelf,
    );
    assert.equal(self?.transfers[0]?.id, "route-upload");
    assert.ok(Number.isSafeInteger(self?.transfers[0]?.updatedAt));
    assert.equal(heartbeat.headers.get("Cache-Control"), "private, no-store");

    const secondTab = await call(route.POST, true, {
      tabId: "tab_route_02",
      transfers: [
        {
          id: "route-download",
          kind: "download",
          name: "route-two.bin",
          transferred: 3,
          total: 9,
        },
      ],
    });
    assert.equal(secondTab.status, 200);
    const secondTabBody = (await secondTab.json()) as {
      members: Array<{
        isSelf: boolean;
        transfers: Array<{ id: string }>;
      }>;
    };
    assert.deepEqual(
      secondTabBody.members
        .find((member) => member.isSelf)
        ?.transfers.map((transfer) => transfer.id)
        .sort(),
      ["route-download", "route-upload"],
    );

    const completed = await call(route.POST, true, {
      tabId: "tab_route_01",
      transfers: [],
    });
    assert.equal(completed.status, 200);
    const completedBody = (await completed.json()) as {
      members: Array<{ isSelf: boolean; transfers: unknown[] }>;
    };
    assert.deepEqual(
      completedBody.members
        .find((member) => member.isSelf)
        ?.transfers.map((transfer) =>
          (transfer as { id: string }).id,
        ),
      ["route-download"],
    );

    const loggedOut = await call(route.DELETE);
    assert.equal(loggedOut.status, 200);
    const loggedOutBody = (await loggedOut.json()) as {
      members: Array<{ isSelf: boolean }>;
    };
    assert.ok(!loggedOutBody.members.some((member) => member.isSelf));
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
