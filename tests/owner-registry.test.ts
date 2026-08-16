import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const SESSION_SECRET = "owner-registry-test-session-secret";
const INSTALLATION_SECRET = Buffer.alloc(32, 0x5a).toString("base64url");
const INSTALLATION_ID = `sd1_${createHash("sha256")
  .update("sharedesk-installation-id-v1:", "utf8")
  .update(Buffer.from(INSTALLATION_SECRET, "base64url"))
  .digest("base64url")}`;
const GUEST_KEY = "owner-registry-guest-key";
const FEEDBACK_ID = "11111111-1111-4111-8111-111111111111";

function signedSession(payload: Record<string, unknown>): string {
  const body = Buffer.from(
    JSON.stringify(payload),
    "utf8",
  ).toString("base64url");
  const signature = createHmac("sha256", SESSION_SECRET)
    .update(Buffer.from(body, "base64url"))
    .digest("base64url");
  return `${body}.${signature}`;
}

function session(userId: string): string {
  return signedSession({
    t: "user",
    sub: userId,
    iat: Math.floor(Date.now() / 1000),
  });
}

function guestSession(accessKey: string): string {
  return signedSession({
    t: "key",
    k: createHash("sha256").update(accessKey).digest("hex").slice(0, 32),
    iat: Math.floor(Date.now() / 1000),
  });
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

async function writeUsers(
  root: string,
  adminStatus = "approved",
  memberName = "일반 사용자",
) {
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
          name: memberName,
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

test("설치별 증명으로 등록하고 승인된 Google 사용자가 피드백을 보낸다", async (t) => {
  const [
    source,
    routeSource,
    feedbackRouteSource,
    adminSource,
    adminPageSource,
    envSource,
  ] = await Promise.all([
    readFile(
      new URL("../src/lib/owner-registry.ts", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../src/app/api/admin/owner-registry/route.ts", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/app/api/feedback/route.ts", import.meta.url), "utf8"),
    readFile(
      new URL("../src/app/admin/AdminView.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../src/app/admin/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);
  assert.match(source, /^import "server-only";/);
  assert.doesNotMatch(source, /NEXT_PUBLIC_/);
  assert.match(source, /export function isOwnerRegistryConfigured\(/);
  assert.match(source, /\^\[A-Za-z0-9_-\]\{43\}\$/);
  assert.doesNotMatch(source, /env\.SHAREDESK_INSTALLATION_ID/);
  assert.equal(
    routeSource.match(/requireAdmin\(\{ fresh: true \}\)/g)?.length,
    2,
  );
  assert.match(routeSource, /Object\.keys\(body\)\.join\("\\n"\) !== "confirm"/);
  assert.match(feedbackRouteSource, /requireSession\(\{ fresh: true \}\)/);
  assert.doesNotMatch(feedbackRouteSource, /requireAdmin/);
  assert.match(
    feedbackRouteSource,
    /"feedbackId\\nmessage\\nsubject"/,
  );
  assert.match(source, /feedbackId: feedback\.feedbackId/);
  assert.match(adminPageSource, /return <AdminView \/>/);
  assert.doesNotMatch(adminSource, /피드백|\/api\/feedback/);
  assert.match(adminSource, /"현재 설치 등록"/);
  assert.match(
    adminSource,
    /fetch\("\/api\/admin\/owner-registry", \{\s*method: "POST",\s*headers: \{ "Content-Type": "application\/json" \},\s*body: JSON\.stringify\(\{ confirm: true \}\)/,
  );
  assert.doesNotMatch(envSource, /SHAREDESK_INSTALLATION_ID/);
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
    SHAREDESK_OWNER_REGISTRY_SECRET: "collector-secret",
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
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
          Origin: disabled.origin,
        },
        body: JSON.stringify({ confirm: true }),
      },
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
  await writeUsers(configuredRoot, "approved", ` ${"가".repeat(140)} `);
  const configured = await startNext(configuredRoot, {
    ACCESS_KEYS: GUEST_KEY,
    PUBLIC_BASE_URL: "https://desk.example.com",
    SHAREDESK_GITHUB_REPOSITORY: "owner/installed-repo",
    SHAREDESK_OWNER_REGISTRY_ENDPOINT: endpoint,
    SHAREDESK_OWNER_REGISTRY_SECRET: INSTALLATION_SECRET,
    SHAREDESK_INSTALLATION_ID: "legacy-id-must-be-ignored",
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
    assert.ok(!JSON.stringify(status).includes(INSTALLATION_SECRET));
    assert.ok(!JSON.stringify(status).includes(INSTALLATION_ID));
    assert.doesNotMatch(JSON.stringify(status), /legacy-id|127\.0\.0\.1/);

    const missingOrigin = await fetch(
      `${configured.origin}/api/admin/owner-registry`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: adminCookie },
        body: JSON.stringify({ confirm: true }),
      },
    );
    assert.equal(missingOrigin.status, 403);

    const crossOrigin = await fetch(
      `${configured.origin}/api/admin/owner-registry`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
          Origin: "https://attacker.example",
        },
        body: JSON.stringify({ confirm: true }),
      },
    );
    assert.equal(crossOrigin.status, 403);

    const wrongContentType = await fetch(
      `${configured.origin}/api/admin/owner-registry`,
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          Cookie: adminCookie,
          Origin: configured.origin,
        },
        body: JSON.stringify({ confirm: true }),
      },
    );
    assert.equal(wrongContentType.status, 415);

    const unexpectedBody = await fetch(
      `${configured.origin}/api/admin/owner-registry`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
          Origin: configured.origin,
        },
        body: JSON.stringify({ confirm: true, extra: "never-send" }),
      },
    );
    assert.equal(unexpectedBody.status, 400);
    assert.equal(received.length, 0);

    const oversizedConfirmation = await fetch(
      `${configured.origin}/api/admin/owner-registry`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
          Origin: configured.origin,
        },
        body: `${" ".repeat(65)}{"confirm":true}`,
      },
    );
    assert.equal(oversizedConfirmation.status, 413);

    const recordResponse = await fetch(
      `${configured.origin}/api/admin/owner-registry`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
          Origin: configured.origin,
        },
        body: JSON.stringify({ confirm: true }),
      },
    );
    assert.equal(recordResponse.status, 200);
    const result = (await recordResponse.json()) as Record<string, unknown>;
    assert.equal(result.ok, true);
    assert.doesNotMatch(
      JSON.stringify(result),
      /legacy-id|never-send/,
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
    assert.equal(observation.sharedSecret, INSTALLATION_SECRET);
    assert.equal(observation.installationId, INSTALLATION_ID);
    assert.equal(observation.site, "https://desk.example.com");
    assert.equal(observation.repository, "owner/installed-repo");
    assert.equal(observation.version, status.version);
    assert.equal(observation.observedByEmail, "admin@example.com");
    assert.ok(
      typeof observation.observedAt === "string" &&
        Number.isFinite(Date.parse(observation.observedAt)),
    );
    assert.doesNotMatch(JSON.stringify(observation), /legacy-id|never-send/);

    const unauthorizedFeedback = await fetch(
      `${configured.origin}/api/feedback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedbackId: FEEDBACK_ID,
          subject: "제목",
          message: "내용",
        }),
      },
    );
    assert.equal(unauthorizedFeedback.status, 401);

    const guestFeedback = await fetch(
      `${configured.origin}/api/feedback`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `sharedesk_session=${guestSession(GUEST_KEY)}`,
          Origin: configured.origin,
        },
        body: JSON.stringify({
          feedbackId: FEEDBACK_ID,
          subject: "제목",
          message: "내용",
        }),
      },
    );
    assert.equal(guestFeedback.status, 403);

    const memberCookie = `sharedesk_session=${session("member-sub")}`;
    const missingOriginFeedback = await fetch(
      `${configured.origin}/api/feedback`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: memberCookie },
        body: JSON.stringify({
          feedbackId: FEEDBACK_ID,
          subject: "제목",
          message: "내용",
        }),
      },
    );
    assert.equal(missingOriginFeedback.status, 403);

    const crossOriginFeedback = await fetch(
      `${configured.origin}/api/feedback`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: memberCookie,
          Origin: "https://attacker.example",
        },
        body: JSON.stringify({
          feedbackId: FEEDBACK_ID,
          subject: "제목",
          message: "내용",
        }),
      },
    );
    assert.equal(crossOriginFeedback.status, 403);

    const nonJsonFeedback = await fetch(`${configured.origin}/api/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
        Cookie: memberCookie,
        Origin: configured.origin,
      },
      body: JSON.stringify({
        feedbackId: FEEDBACK_ID,
        subject: "제목",
        message: "내용",
      }),
    });
    assert.equal(nonJsonFeedback.status, 415);

    const invalidIdFeedback = await fetch(
      `${configured.origin}/api/feedback`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: memberCookie,
          Origin: configured.origin,
        },
        body: JSON.stringify({
          feedbackId: "not-a-uuid",
          subject: "제목",
          message: "내용",
        }),
      },
    );
    assert.equal(invalidIdFeedback.status, 400);
    assert.equal(received.length, 1);

    const spoofedFeedback = await fetch(
      `${configured.origin}/api/feedback`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: memberCookie,
          Origin: configured.origin,
        },
        body: JSON.stringify({
          feedbackId: FEEDBACK_ID,
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
      `${configured.origin}/api/feedback`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: memberCookie,
          Origin: configured.origin,
        },
        body: JSON.stringify({
          feedbackId: FEEDBACK_ID,
          subject: "제목",
          message: "가".repeat(20_000),
        }),
      },
    );
    assert.equal(oversizedFeedback.status, 413);
    assert.equal(received.length, 1);

    const sentFeedback = await fetch(
      `${configured.origin}/api/feedback`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: memberCookie,
          Origin: configured.origin,
        },
        body: JSON.stringify({
          feedbackId: FEEDBACK_ID,
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
      "feedbackId",
      "installationId",
      "kind",
      "message",
      "repository",
      "senderEmail",
      "senderName",
      "sentAt",
      "sharedSecret",
      "site",
      "subject",
      "version",
    ]);
    assert.equal(feedbackRequest.kind, "feedback");
    assert.equal(feedbackRequest.feedbackId, FEEDBACK_ID);
    assert.equal(feedbackRequest.senderEmail, "member@example.com");
    assert.equal(feedbackRequest.senderName, "가".repeat(120));
    assert.equal(feedbackRequest.subject, "파일 미리보기 제안");
    assert.equal(feedbackRequest.message, "PDF 이동을 더 빠르게 해 주세요.");
    assert.equal(feedbackRequest.sharedSecret, INSTALLATION_SECRET);
    assert.equal(feedbackRequest.installationId, INSTALLATION_ID);
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
      `${configured.origin}/api/feedback`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: adminCookie,
          Origin: configured.origin,
        },
        body: JSON.stringify({
          feedbackId: FEEDBACK_ID,
          subject: "제목",
          message: "내용",
        }),
      },
    );
    assert.equal(blockedFeedback.status, 401);
    assert.equal(received.length, 2);
  } finally {
    await stopServer(configured.child);
    await rm(configuredRoot, { recursive: true, force: true });
  }
});
