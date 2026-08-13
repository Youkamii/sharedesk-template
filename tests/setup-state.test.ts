import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CALLBACK_URL_SECURITY_WARNING,
  GOOGLE_AUTH_PLATFORM_GUIDANCE,
  HOST_OAUTH_SCOPES,
  REFRESH_TOKEN_RECOVERY_GUIDANCE,
  SETUP_COMPLETION_NEXT_STEPS,
  browserOpenCommand,
  ensureCoreStateFiles,
  openBrowser,
  parseCallbackUrl,
  parseWhoamiUserSid,
  prepareEnvFile,
  protectPrivateDirectory,
  writePrivateFile,
} from "../scripts/setup.mjs";

function runSetupScript(cwd: string, args: string[] = []) {
  const setupPath = path.resolve("scripts/setup.mjs");
  return new Promise<{
    error: Error | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    execFile(
      process.execPath,
      [setupPath, ...args],
      {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          GOOGLE_CLIENT_ID: "",
          GOOGLE_CLIENT_SECRET: "",
        },
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("whoami CSV는 사용자 이름이 아니라 정확한 두 번째 SID 열만 읽는다", () => {
  const actualSid = "S-1-5-21-822406868-2165732658-1317598319-1001";
  assert.equal(
    parseWhoamiUserSid(`"S-1-1-0\\user","${actualSid}"\r\n`),
    actualSid,
  );
  assert.equal(
    parseWhoamiUserSid(`"domain\\evil""S-1-1-0","${actualSid}"`),
    actualSid,
  );
  for (const malformed of [
    `"user","${actualSid}","extra"`,
    `"user","not-a-sid"`,
    `S-1-1-0\\user,"${actualSid}"`,
  ]) {
    assert.throws(
      () => parseWhoamiUserSid(malformed),
      /Windows 현재 사용자 SID를 확인하지 못했습니다/,
    );
  }
});

function runWindowsAclCommand(executable: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      args,
      { encoding: "utf8", windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(new Error("Windows ACL 검사 명령이 실패했습니다."));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function inspectWindowsAcl(filePath: string, outputPath: string) {
  const windowsRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const whoami = path.join(windowsRoot, "System32", "whoami.exe");
  const icacls = path.join(windowsRoot, "System32", "icacls.exe");
  const identity = await runWindowsAclCommand(whoami, [
    "/user",
    "/fo",
    "csv",
    "/nh",
  ]);
  const sid = identity.match(/S-\d-(?:\d+-)+\d+/)?.[0];
  assert.ok(sid, "현재 Windows 사용자 SID를 읽어야 합니다.");
  await runWindowsAclCommand(icacls, [filePath, "/save", outputPath, "/q"]);
  const savedAcl = await readFile(outputPath, "utf16le");
  const descriptor = savedAcl
    .split(/\r?\n/)
    .find((line) => line.startsWith("D:"));
  assert.ok(descriptor, "icacls가 저장한 DACL 설명자를 읽어야 합니다.");
  return { descriptor, sid };
}

function isPrivateWindowsAcl(
  descriptor: string,
  sid: string,
  inheritToChildren = false,
) {
  const firstAce = descriptor.indexOf("(");
  const flags = firstAce >= 0 ? descriptor.slice(2, firstAce) : "";
  const aces = [...descriptor.matchAll(/\(([^()]*)\)/g)].map((match) =>
    match[1].split(";"),
  );
  const onlyAce = aces[0];
  return (
    flags.includes("P") &&
    aces.length === 1 &&
    onlyAce?.[0] === "A" &&
    onlyAce?.[2] === "FA" &&
    onlyAce?.[5]?.toUpperCase() === sid.toUpperCase() &&
    (!inheritToChildren ||
      (onlyAce?.[1]?.includes("OI") && onlyAce?.[1]?.includes("CI")))
  );
}

test("setup 비밀 파일은 기존 권한도 소유자 전용으로 조인다", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-setup-mode-"));
  const target = path.join(root, ".env.local");
  let stagingProtectedBeforeChildren = false;
  try {
    await writeFile(target, "old", { encoding: "utf8", mode: 0o644 });
    await writePrivateFile(target, "secret", {
      protectDirectory: async (stagingPath: string) => {
        assert.deepEqual(
          await readdir(stagingPath),
          [],
          "staging은 자식 파일을 만들기 전에 먼저 보호해야 합니다.",
        );
        await protectPrivateDirectory(stagingPath);
        if (process.platform === "win32") {
          const { descriptor, sid } = await inspectWindowsAcl(
            stagingPath,
            path.join(root, "saved-staging-acl"),
          );
          assert.equal(
            isPrivateWindowsAcl(descriptor, sid, true),
            true,
            "Windows staging DACL은 현재 사용자만 허용하고 자식에게 상속돼야 합니다.",
          );
        } else {
          assert.equal((await stat(stagingPath)).mode & 0o777, 0o700);
        }
        stagingProtectedBeforeChildren = true;
      },
    });
    assert.equal(stagingProtectedBeforeChildren, true);
    if (process.platform === "win32") {
      const { descriptor, sid } = await inspectWindowsAcl(
        target,
        path.join(root, "saved-acl"),
      );
      assert.equal(
        isPrivateWindowsAcl(descriptor, sid),
        true,
        "Windows DACL은 상속 없이 현재 사용자 한 명에게만 모든 권한을 줘야 합니다.",
      );
      t.diagnostic("icacls /save로 Windows 전용 DACL을 확인했습니다");
    } else {
      assert.equal((await stat(target)).mode & 0o777, 0o600);
    }
    assert.equal(await readFile(target, "utf8"), "secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup은 빈 임시 파일을 먼저 보호하고 나서 비밀을 기록한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-setup-order-"));
  const target = path.join(root, ".env.local");
  const protectedContents: string[] = [];
  try {
    await writePrivateFile(target, "secret", {
      protectFile: async (protectedPath: string) => {
        protectedContents.push(await readFile(protectedPath, "utf8"));
      },
    });
    assert.deepEqual(protectedContents, ["", "secret"]);
    assert.equal(await readFile(target, "utf8"), "secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("임시 파일 권한 설정이 실패하면 비밀을 쓰지 않고 정리한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-setup-denied-"));
  const target = path.join(root, ".env.local");
  let contentsBeforeFailure = "not-inspected";
  try {
    await assert.rejects(
      writePrivateFile(target, "must-not-remain", {
        protectFile: async (protectedPath: string) => {
          contentsBeforeFailure = await readFile(protectedPath, "utf8");
          throw new Error("simulated ACL setup failure");
        },
      }),
      /비밀 파일을 안전하게 저장하지 못해 설정을 중단했습니다/,
    );
    assert.equal(contentsBeforeFailure, "");
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("원자 교체 뒤 권한 확인이 실패하면 기존 비밀 파일을 복원한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-setup-rollback-"));
  const target = path.join(root, ".env.local");
  let protectionCount = 0;
  const protectedContents: string[] = [];
  try {
    await writeFile(target, "old-secret", { encoding: "utf8" });
    await assert.rejects(
      writePrivateFile(target, "new-secret", {
        protectFile: async (protectedPath: string) => {
          protectionCount += 1;
          protectedContents.push(await readFile(protectedPath, "utf8"));
          if (protectionCount === 4) {
            throw new Error("simulated ACL verification failure");
          }
        },
      }),
      /비밀 파일을 안전하게 저장하지 못해 설정을 중단했습니다/,
    );
    assert.deepEqual(protectedContents, ["old-secret", "", "", "new-secret"]);
    assert.equal(await readFile(target, "utf8"), "old-secret");
    assert.deepEqual(await readdir(root), [".env.local"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("커밋 뒤 백업 삭제가 실패해도 새 파일과 이전 백업을 훼손하지 않는다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-setup-cleanup-"));
  const target = path.join(root, ".env.local");
  try {
    await writeFile(target, "old-secret", { encoding: "utf8" });
    await assert.rejects(
      writePrivateFile(target, "new-secret", {
        removeFile: async () => {
          const error = new Error("simulated persistent cleanup failure");
          Object.assign(error, { code: "EBUSY" });
          throw error;
        },
      }),
      /비밀 파일 저장은 끝났지만 보호된 이전 파일을 정리하지 못했습니다/,
    );

    const names = await readdir(root);
    const stagingName = names.find((name) =>
      name.startsWith(".sharedesk-private-"),
    );
    assert.ok(stagingName, "보호된 작업 폴더를 남겨야 합니다.");
    const stagingPath = path.join(root, stagingName);
    const stagingNames = await readdir(stagingPath);
    assert.deepEqual(stagingNames, ["previous"]);
    assert.equal(await readFile(target, "utf8"), "new-secret");
    assert.equal(await readFile(path.join(stagingPath, "previous"), "utf8"), "old-secret");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepare-env는 보호한 파일을 private staging writer로 채운다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-prepare-env-"));
  const envPath = path.join(root, ".env.local");
  const examplePath = path.join(root, ".env.example");
  let privateWriterCalled = false;
  try {
    await writeFile(examplePath, "STORAGE_DRIVER=local\n", "utf8");
    const result = await prepareEnvFile({
      envPath,
      examplePath,
      privateWriter: async (targetPath: string, contents: Buffer) => {
        privateWriterCalled = true;
        await writePrivateFile(targetPath, contents);
      },
    });
    assert.equal(result, "created");
    assert.equal(privateWriterCalled, true);
    assert.equal(await readFile(envPath, "utf8"), "STORAGE_DRIVER=local\n");
    if (process.platform === "win32") {
      const { descriptor, sid } = await inspectWindowsAcl(
        envPath,
        path.join(root, "saved-env-acl"),
      );
      assert.equal(isPrivateWindowsAcl(descriptor, sid), true);
    } else {
      assert.equal((await stat(envPath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prepare-env는 기존 환경 파일을 덮어쓰지 않고 권한만 보호한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-prepare-existing-"));
  const envPath = path.join(root, ".env.local");
  const examplePath = path.join(root, ".env.example");
  try {
    await writeFile(envPath, "EXISTING_SECRET=keep\n", "utf8");
    await writeFile(examplePath, "REPLACEMENT=must-not-write\n", "utf8");
    const result = await prepareEnvFile({
      envPath,
      examplePath,
      privateWriter: async () => {
        throw new Error("existing env must not invoke writer");
      },
    });
    assert.equal(result, "protected");
    assert.equal(await readFile(envPath, "utf8"), "EXISTING_SECRET=keep\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bare setup은 .env.local이 없으면 prepare-env를 자동 수행한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-bare-setup-"));
  const example = [
    "GOOGLE_CLIENT_ID=",
    "GOOGLE_CLIENT_SECRET=",
    "STORAGE_DRIVER=local",
    "",
  ].join("\n");
  try {
    await writeFile(path.join(root, ".env.example"), example, "utf8");
    const result = await runSetupScript(root);

    assert.ok(result.error, "OAuth 값이 없으면 안내 후 중단해야 합니다.");
    assert.match(result.stdout, /.env\.local이 없어[^]*자동 준비/);
    assert.match(result.stderr, /GOOGLE_CLIENT_ID \/ GOOGLE_CLIENT_SECRET/);
    assert.equal(await readFile(path.join(root, ".env.local"), "utf8"), example);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("--prepare-env는 환경 파일만 미리 준비하는 호환 옵션으로 남는다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sharedesk-explicit-prepare-"));
  try {
    await writeFile(
      path.join(root, ".env.example"),
      "GOOGLE_CLIENT_ID=\nGOOGLE_CLIENT_SECRET=\n",
      "utf8",
    );
    const result = await runSetupScript(root, ["--prepare-env"]);

    assert.equal(result.error, null);
    assert.match(result.stdout, /.env\.local을[^]*준비했습니다/);
    assert.equal(result.stderr, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("setup은 기존 핵심 상태 파일을 보존하고 누락 파일만 multipart로 만든다", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const messages: string[] = [];
  const files = [{ id: "users-file", name: "users.json" }];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    requests.push({ url, init });
    if (!init?.method || init.method === "GET") {
      return jsonResponse({ files });
    }
    files.push({ id: "shares-file", name: "drive-shares.json" });
    return jsonResponse({ id: "shares-file", name: "drive-shares.json" });
  };

  await ensureCoreStateFiles({
    accessToken: "test-token",
    stateFolderId: "state-folder",
    fetchImpl,
    log: { info: (message: string) => messages.push(message) },
  });

  const uploads = requests.filter((request) => request.init?.method === "POST");
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].url, /uploadType=multipart/);
  const contentType = new Headers(uploads[0].init?.headers).get("Content-Type");
  assert.match(contentType ?? "", /^multipart\/related; boundary=sharedesk_/);
  const body = String(uploads[0].init?.body);
  assert.match(body, /"name":"drive-shares\.json"/);
  assert.match(body, /"permissions": \[\]/);
  assert.deepEqual(messages, [
    "기존 상태 파일을 보존합니다: users.json",
    "핵심 상태 파일을 만들었습니다: drive-shares.json",
  ]);
});

test("setup은 같은 이름의 핵심 상태 파일이 여러 개면 생성 전에 중단한다", async () => {
  let uploadCount = 0;
  const fetchImpl = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (init?.method === "POST") {
      uploadCount += 1;
      return jsonResponse({ id: "unexpected" });
    }
    return jsonResponse({
      files: [
        { id: "users-a", name: "users.json" },
        { id: "users-b", name: "users.json" },
      ],
    });
  };

  await assert.rejects(
    ensureCoreStateFiles({
      accessToken: "test-token",
      stateFolderId: "state-folder",
      fetchImpl,
      log: { info() {} },
    }),
    /users\.json 파일이 여러 개/,
  );
  assert.equal(uploadCount, 0);
});

test("setup은 생성 직후 동명 상태 파일이 늘어나도 중단한다", async () => {
  let listCount = 0;
  const fetchImpl = async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (init?.method === "POST") {
      return jsonResponse({ id: "created-users", name: "users.json" });
    }
    listCount += 1;
    return listCount === 1
      ? jsonResponse({ files: [{ id: "shares", name: "drive-shares.json" }] })
      : jsonResponse({
          files: [
            { id: "created-users", name: "users.json" },
            { id: "racing-users", name: "users.json" },
            { id: "shares", name: "drive-shares.json" },
          ],
        });
  };

  await assert.rejects(
    ensureCoreStateFiles({
      accessToken: "test-token",
      stateFolderId: "state-folder",
      fetchImpl,
      log: { info() {} },
    }),
    /users\.json 파일이 여러 개/,
  );
});

test("setup 안내는 상세 절차를 설치 문서에 맡기고 현장에서 필요한 값만 보여준다", () => {
  assert.match(GOOGLE_AUTH_PLATFORM_GUIDANCE, /docs\/INSTALL\.md/);
  assert.match(GOOGLE_AUTH_PLATFORM_GUIDANCE, /.env\.local이 없으면 npm run setup이[^]*자동 준비/);
  assert.match(GOOGLE_AUTH_PLATFORM_GUIDANCE, /Client ID와 Client secret을 직접 입력[^]*npm run setup을 다시 실행/);
  assert.match(GOOGLE_AUTH_PLATFORM_GUIDANCE, /npm run setup -- --prepare-env도[^]*사용/);
  assert.deepEqual(HOST_OAUTH_SCOPES, [
    "openid",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/drive.file",
  ]);
  for (const redirectUri of [
    "http://127.0.0.1:53682/callback",
    "http://localhost:3000/api/auth/google/callback",
    "https://<고정된-운영-도메인>/api/auth/google/callback",
  ]) {
    assert.ok(GOOGLE_AUTH_PLATFORM_GUIDANCE.includes(redirectUri));
  }
  assert.match(GOOGLE_AUTH_PLATFORM_GUIDANCE, /비밀값이나 callback URL/);
  assert.match(GOOGLE_AUTH_PLATFORM_GUIDANCE, /채팅, 이슈, 스크린샷에 공유하지 마세요/);
  assert.doesNotMatch(
    GOOGLE_AUTH_PLATFORM_GUIDANCE,
    /Authorized JavaScript origins|Publish app|In production|7일 뒤 만료/,
  );
});

test("인증 URL은 Windows·macOS·Linux에서 쉘 문자열 없이 기본 브라우저로 전달된다", () => {
  const url = "https://accounts.google.com/o/oauth2/v2/auth?state=a&code_challenge=b";

  assert.deepEqual(browserOpenCommand(url, "win32", { ...process.env, SystemRoot: "C:\\Windows" }), {
    executable: "C:\\Windows\\System32\\rundll32.exe",
    args: ["url.dll,FileProtocolHandler", url],
  });
  assert.deepEqual(browserOpenCommand(url, "darwin"), {
    executable: "open",
    args: [url],
  });
  assert.deepEqual(browserOpenCommand(url, "linux"), {
    executable: "xdg-open",
    args: [url],
  });
  assert.equal(browserOpenCommand(url, "aix"), null);
});

test("브라우저 자동 열기 실패는 setup을 중단시키지 않는다", async () => {
  const opened = await openBrowser(
    "https://accounts.google.com/",
    ((_executable: string, _args: string[], _options: unknown, callback: (error: Error | null) => void) => {
      callback(new Error("browser unavailable"));
    }) as typeof execFile,
  );
  assert.equal(opened, false);

  const threw = await openBrowser(
    "https://accounts.google.com/",
    (() => {
      throw new Error("spawn unavailable");
    }) as unknown as typeof execFile,
  );
  assert.equal(threw, false);
});

test("setup 시작과 finish에서 재사용하는 callback 경고는 공유 금지 대상을 명시한다", () => {
  assert.match(CALLBACK_URL_SECURITY_WARNING, /일회용 인증 코드/);
  for (const destination of ["채팅", "이슈", "스크린샷"]) {
    assert.ok(CALLBACK_URL_SECURITY_WARNING.includes(destination));
  }
  assert.match(CALLBACK_URL_SECURITY_WARNING, /이 컴퓨터의 터미널에만/);
});

test("잘못된 callback URL 오류에는 사용자가 붙여넣은 값이 포함되지 않는다", () => {
  const pastedSecret = "not-a-url?code=one-time-secret-value";
  assert.throws(
    () => parseCallbackUrl(pastedSecret),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /callback URL 형식이 올바르지 않습니다/);
      assert.doesNotMatch(error.message, /one-time-secret-value/);
      return true;
    },
  );
});

test("올바른 callback URL은 인증 코드와 state를 그대로 읽는다", () => {
  const callback = parseCallbackUrl(
    "http://127.0.0.1:53682/callback?code=test-code&state=test-state",
  );
  assert.equal(callback.origin, "http://127.0.0.1:53682");
  assert.equal(callback.pathname, "/callback");
  assert.equal(callback.searchParams.get("code"), "test-code");
  assert.equal(callback.searchParams.get("state"), "test-state");
});

test("refresh token 복구 안내는 기존 연결을 무조건 폐기하지 않는다", () => {
  assert.match(REFRESH_TOKEN_RECOVERY_GUIDANCE, /기존 연결과 Audience 상태를 먼저 확인/);
  assert.match(
    REFRESH_TOKEN_RECOVERY_GUIDANCE,
    /새 토큰이 실제로 필요하고 기존 연결 때문에 발급되지 않는 경우에만/,
  );
});

test("setup 완료 안내는 설치 문서의 다음 단계와 남은 현장 검증만 가리킨다", () => {
  assert.match(SETUP_COMPLETION_NEXT_STEPS, /호스트의 Google Drive 저장 공간[^]*여러 사람이 함께/);
  assert.match(SETUP_COMPLETION_NEXT_STEPS, /docs\/INSTALL\.md/);
  assert.match(SETUP_COMPLETION_NEXT_STEPS, /Vercel Production 환경 변수와 재배포/);
  assert.match(SETUP_COMPLETION_NEXT_STEPS, /비밀값을 Production 환경에 안전하게 옮긴 뒤 재배포/);
  assert.match(SETUP_COMPLETION_NEXT_STEPS, /초대 코드를 만들어 한 사람을 초대/);
  assert.match(SETUP_COMPLETION_NEXT_STEPS, /두 계정에서 같은 파일이 보이는지/);
  assert.match(SETUP_COMPLETION_NEXT_STEPS, /Firewall[^]*기능 확인이 끝난 뒤/);
  assert.doesNotMatch(
    SETUP_COMPLETION_NEXT_STEPS,
    /PUBLIC_BASE_URL=|VERCEL_PROJECT_PRODUCTION_URL|Fixed Window|\/api\/invitations\/code|IP당 60초/,
  );
});
