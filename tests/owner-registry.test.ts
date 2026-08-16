import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const SESSION_SECRET = "owner-registry-test-session-secret";

function session(userId: string): string {
  const body = Buffer.from(
    JSON.stringify({
      t: "user",
      sub: userId,
      iat: Math.floor(Date.now() / 1000),
    }),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET)
    .update(Buffer.from(body, "base64url"))
    .digest("base64url");
  return `${body}.${signature}`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("테스트 포트를 만들지 못했습니다"));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolve(address.port),
      );
    });
  });
}

async function waitForServer(
  origin: string,
  child: ChildProcess,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Next 테스트 서버가 종료됐습니다 (${child.exitCode})\n${output()}`,
      );
    }
    try {
      const response = await fetch(origin, { redirect: "manual" });
      if (response.status < 500) return;
    } catch {
      // 개발 서버가 포트를 열 때까지 다시 확인한다.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Next 테스트 서버가 준비되지 않았습니다\n${output()}`);
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
}

async function writeUsers(root: string, adminStatus = "approved") {
  const stateDir = path.join(root, ".sharedesk");
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "users.json"),
    JSON.stringify({
      version: 2,
      rev: adminStatus === "approved" ? 1 : 2,
      users: [
        {
          id: "admin-sub",
          email: "admin@example.com",
          name: "관리자",
          status: adminStatus,
          isAdmin: true,
          createdAt: "2026-08-01T00:00:00.000Z",
          invitationId: null,
          sessionsValidFrom: 0,
          sessionVersion: 0,
          sessions: [],
        },
        {
          id: "member-sub",
          email: "member@example.com",
          name: "일반 사용자",
          status: "approved",
          isAdmin: false,
          createdAt: "2026-08-01T00:00:00.000Z",
          invitationId: null,
          sessionsValidFrom: 0,
          sessionVersion: 0,
          sessions: [],
        },
      ],
      invitations: [],
    }),
    "utf8",
  );
}

async function startNext(
  storageRoot: string,
  registryEnv: Record<string, string>,
) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const nextBin = path.join(
    process.cwd(),
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );
  let output = "";
  const child = spawn(process.execPath, [nextBin, "dev", "-p", String(port)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_ROOT: storageRoot,
      SESSION_SECRET,
      ADMIN_EMAILS: "admin@example.com",
      ACCESS_KEYS: "",
      NEXT_TELEMETRY_DISABLED: "1",
      ...registryEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-8_000);
  });
  child.stderr?.on("data", (chunk) => {
    output = (output + chunk.toString()).slice(-8_000);
  });
  await waitForServer(origin, child, () => output);
  return { child, origin };
}

test("비공개 설치 등록부는 설정이 완전할 때만 관리자가 직접 기록한다", async (t) => {
  const [source, routeSource, feedbackRouteSource, adminSource, adminPageSource] =
    await Promise.all([
    readFile(
      new URL("../src/lib/owner-registry.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/api/admin/owner-registry/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/api/admin/feedback/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/admin/AdminView.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/app/admin/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(source, /^import "server-only";/);
  assert.doesNotMatch(source, /NEXT_PUBLIC_/);
  assert.equal(
    routeSource.match(/requireAdmin\(\{ fresh: true \}\)/g)?.length,
    2,
  );
  assert.match(feedbackRouteSource, /requireAdmin\(\{ fresh: true \}\)/);
  assert.match(adminPageSource, /<AdminView adminEmail=\{session\.email\}/);
  assert.match(adminSource, /aria-label="피드백 메일 보내기"/);
  assert.match(adminSource, /보내는 관리자 <strong>\{adminEmail\}<\/strong>/);
  assert.doesNotMatch(adminSource, /name=["'](?:from|sender|to)["']/i);
  assert.match(adminSource, /"현재 설치 등록"/);
  assert.match(
    adminSource,
    /fetch\("\/api\/admin\/owner-registry", \{\s*method: "POST"/,
  );
  assert.equal(
    adminSource.match(/recordCurrentInstallation\(/g)?.length,
    2,
    "등록 함수는 정의와 클릭 핸들러에서만 사용한다",
  );

  const received: Array<Record<string, unknown>> = [];
  const collector = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk.toString();
    received.push(JSON.parse(raw) as Record<string, unknown>);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, created: true }));
  });
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  t.after(() => collector.close());
  const collectorAddress = collector.address();
  assert.ok(collectorAddress && typeof collectorAddress !== "string");
  const endpoint = `http://127.0.0.1:${collectorAddress.port}/collect`;

  const disabledRoot = await mkdtemp(
    path.join(tmpdir(), "sharedesk-owner-registry-disabled-"),
  );
  await writeUsers(disabledRoot);
  const disabled = await startNext(disabledRoot, {
    PUBLIC_BASE_URL: "https://desk.example.com",
    SHAREDESK_OWNER_REGISTRY_ENDPOINT: endpoint,
    SHAREDESK_OWNER_REGISTRY_SECRET: "",
    SHAREDESK_INSTALLATION_ID: "installation-test",
  });
  try {
    const adminCookie = `sharedesk_session=${session("admin-sub")}`;
    const statusResponse = await fetch(
      `${disabled.origin}/api/admin/owner-registry`,
      { headers: { Cookie: adminCookie } },
    );
    assert.equal(statusResponse.status, 200);
    assert.equal(
      ((await statusResponse.json()) as { enabled: boolean }).enabled,
      false,
    );
    const recordResponse = await fetch(
      `${disabled.origin}/api/admin/owner-registry`,
      { method: "POST", headers: { Cookie: adminCookie } },
    );
    assert.equal(recordResponse.status, 409);
    assert.equal(received.length, 0);
  } finally {
    await stopServer(disabled.child);
    await rm(disabledRoot, { recursive: true, force: true });
  }

  const configuredRoot = await mkdtemp(
    path.join(tmpdir(), "sharedesk-owner-registry-configured-"),
  );
  await writeUsers(configuredRoot);
  const configured = await startNext(configuredRoot, {
    PUBLIC_BASE_URL: "https://desk.example.com",
    SHAREDESK_GITHUB_REPOSITORY: "owner/installed-repo",
    SHAREDESK_OWNER_REGISTRY_ENDPOINT: endpoint,
    SHAREDESK_OWNER_REGISTRY_SECRET: "collector-secret",
    SHAREDESK_INSTALLATION_ID: "installation-test",
  });
  try {
    const unauthorized = await fetch(
      `${configured.origin}/api/admin/owner-registry`,
    );
    assert.equal(unauthorized.status, 401);
    const forbidden = await fetch(
      `${configured.origin}/api/admin/owner-registry`,
      { headers: { Cookie: `sharedesk_session=${session("member-sub")}` } },
    );
    assert.equal(forbidden.status, 403);

    const adminCookie = `sharedesk_session=${session("admin-sub")}`;
    const statusResponse = await fetch(
      `${configured.origin}/api/admin/owner-registry`,
      { headers: { Cookie: adminCookie } },
    );
    assert.equal(statusResponse.status, 200);
    const status = (await statusResponse.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(status).sort(), [
      "enabled",
      "error",
      "repository",
      "site",
      "version",
    ]);
    assert.equal(status.enabled, true);
    assert.equal(status.site, "https://desk.example.com");
    assert.equal(status.repository, "owner/installed-repo");
    assert.equal(status.error, null);
    assert.equal(received.length, 0, "GET 상태 조회는 수집기를 호출하지 않는다");
    assert.doesNotMatch(
      JSON.stringify(status),
      /collector-secret|installation-test|127\.0\.0\.1/,
    );

    const recordResponse = await fetch(
      `${configured.origin}/api/admin/owner-registry`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
        },
        body: JSON.stringify({
          files: ["never-send.txt"],
          users: ["never-send@example.com"],
          driveId: "never-send",
          invitation: "never-send",
          version: "999.0.0",
        }),
      },
    );
    assert.equal(recordResponse.status, 200);
    const result = (await recordResponse.json()) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.doesNotMatch(
      JSON.stringify(result),
      /collector-secret|installation-test|never-send/,
    );
    assert.equal(received.length, 1);
    const observation = received[0];
    assert.deepEqual(Object.keys(observation).sort(), [
      "installationId",
      "kind",
      "observedAt",
      "observedByEmail",
      "repository",
      "sharedSecret",
      "site",
      "version",
    ]);
    assert.equal(observation.kind, "observation");
    assert.equal(observation.sharedSecret, "collector-secret");
    assert.equal(observation.installationId, "installation-test");
    assert.equal(observation.site, "https://desk.example.com");
    assert.equal(observation.repository, "owner/installed-repo");
    assert.equal(observation.version, status.version);
    assert.equal(observation.observedByEmail, "admin@example.com");
    assert.ok(
      typeof observation.observedAt === "string" &&
        Number.isFinite(Date.parse(observation.observedAt)),
    );
    assert.doesNotMatch(JSON.stringify(observation), /never-send/);

    const unauthorizedFeedback = await fetch(
      `${configured.origin}/api/admin/feedback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "제목", message: "내용" }),
      },
    );
    assert.equal(unauthorizedFeedback.status, 401);

    const forbiddenFeedback = await fetch(
      `${configured.origin}/api/admin/feedback`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `sharedesk_session=${session("member-sub")}`,
        },
        body: JSON.stringify({ subject: "제목", message: "내용" }),
      },
    );
    assert.equal(forbiddenFeedback.status, 403);

    const spoofedFeedback = await fetch(
      `${configured.origin}/api/admin/feedback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({
          subject: "제목",
          message: "내용",
          from: "spoof@example.com",
          to: "other@example.com",
        }),
      },
    );
    assert.equal(spoofedFeedback.status, 400);
    assert.equal(received.length, 1);

    const oversizedFeedback = await fetch(
      `${configured.origin}/api/admin/feedback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ subject: "제목", message: "가".repeat(20_000) }),
      },
    );
    assert.equal(oversizedFeedback.status, 413);
    assert.equal(received.length, 1);

    const sentFeedback = await fetch(
      `${configured.origin}/api/admin/feedback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({
          subject: "파일 미리보기 제안",
          message: "PDF 이동을 더 빠르게 해 주세요.",
        }),
      },
    );
    assert.equal(sentFeedback.status, 200);
    const sentBody = (await sentFeedback.json()) as Record<string, unknown>;
    assert.equal(sentBody.ok, true);
    assert.equal(received.length, 2);
    const feedbackRequest = received[1];
    assert.deepEqual(Object.keys(feedbackRequest).sort(), [
      "adminEmail",
      "adminName",
      "installationId",
      "kind",
      "message",
      "repository",
      "sentAt",
      "sharedSecret",
      "site",
      "subject",
      "version",
    ]);
    assert.equal(feedbackRequest.kind, "feedback");
    assert.equal(feedbackRequest.adminEmail, "admin@example.com");
    assert.equal(feedbackRequest.adminName, "관리자");
    assert.equal(feedbackRequest.subject, "파일 미리보기 제안");
    assert.equal(feedbackRequest.message, "PDF 이동을 더 빠르게 해 주세요.");
    assert.equal(feedbackRequest.sharedSecret, "collector-secret");
    assert.doesNotMatch(
      JSON.stringify(feedbackRequest),
      /spoof@example\.com|other@example\.com/,
    );

    await writeUsers(configuredRoot, "blocked");
    const blockedRecord = await fetch(
      `${configured.origin}/api/admin/owner-registry`,
      { method: "POST", headers: { Cookie: adminCookie } },
    );
    assert.equal(blockedRecord.status, 401);
    const blockedFeedback = await fetch(
      `${configured.origin}/api/admin/feedback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ subject: "제목", message: "내용" }),
      },
    );
    assert.equal(blockedFeedback.status, 401);
    assert.equal(received.length, 2);
  } finally {
    await stopServer(configured.child);
    await rm(configuredRoot, { recursive: true, force: true });
  }
});
