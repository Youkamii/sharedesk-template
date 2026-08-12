#!/usr/bin/env node
// ShareDesk 최초 설정 — 주인 1회 실행.
// OAuth 동의 → refresh token 획득 → 드라이브에 루트 폴더 생성 → .env.local 기록.
// 브라우저를 자동으로 열지 않는다: URL을 출력하면 사용자가 직접 연다.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

const ENV_PATH = path.resolve(process.cwd(), ".env.local");
const ENV_EXAMPLE_PATH = path.resolve(process.cwd(), ".env.example");
// 1단계가 만든 state/PKCE를 2단계가 이어받는다. 콜백을 기다리는 서버를 띄우지 않으므로
// 장시간 대기 프로세스가 필요 없다 — 대기 중 프로세스가 죽어 설정이 날아가던 문제를 없앤다.
const PENDING_PATH = path.resolve(process.cwd(), ".setup-pending.json");
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
// drive.file: 이 앱이 만든 파일만 접근 / openid·userinfo: 주인이 누구인지 확인해 관리자로 등록
export const HOST_OAUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/drive.file",
];
const SCOPE = HOST_OAUTH_SCOPES.join(" ");
export const CALLBACK_URL_SECURITY_WARNING = [
  "주의: callback URL에는 Google이 발급한 짧게 유효한 일회용 인증 코드가 들어 있습니다.",
  "이 주소는 이 컴퓨터의 터미널에만 붙여넣고 채팅, 이슈, 스크린샷에 공유하지 마세요.",
].join("\n");
export const GOOGLE_AUTH_PLATFORM_GUIDANCE = [
  "Google Cloud Console에서 ShareDesk용 프로젝트를 선택한 뒤 아래 순서대로 설정하세요:",
  "  0. 운영 배포라면 먼저 README의 '내 ShareDesk 만들기'에서 내 저장소와 Vercel 프로젝트를 만들고",
  "     비밀값 없는 1차 배포로 고정 Production 도메인을 확인합니다.",
  "  1. APIs & Services > Library에서 Google Drive API를 사용 설정합니다.",
  "  2. Google Auth Platform > Branding에서 앱 이름, 사용자 지원 이메일, 개발자 연락처를 입력합니다.",
  "  3. Google Auth Platform > Audience에서 User type을 External로 정합니다.",
  "  4. Google Auth Platform > Data Access > Add or remove scopes에서 아래 4개 scope를 추가합니다:",
  "       openid",
  "       https://www.googleapis.com/auth/userinfo.email",
  "       https://www.googleapis.com/auth/userinfo.profile",
  "       https://www.googleapis.com/auth/drive.file",
  "  5. Audience가 Testing일 때만 Publish app을 눌러 In production으로 전환합니다.",
  "     이미 In production이면 상태와 기존 refresh token을 그대로 둡니다.",
  "     ShareDesk 호스트 연결은 drive.file과 offline access를 함께 요청하므로,",
  "     Testing 상태에서 받은 refresh token은 7일 뒤 만료됩니다. 운영 setup보다 먼저 전환하세요.",
  "  6. Google Auth Platform > Clients > Create client에서 Application type을 Web application으로 고릅니다.",
  "     Authorized JavaScript origins는 비워 두고, Authorized redirect URIs에 아래 3개를 등록합니다:",
  `       ${REDIRECT}`,
  "       http://localhost:3000/api/auth/google/callback",
  "       https://<고정된-운영-도메인>/api/auth/google/callback",
  "     운영 URI는 Vercel의 커밋별 Preview URL이 아니라 고정 Production 도메인을 사용하세요.",
  "  7. 생성 직후 표시되는 Client ID와 Client secret을 안전한 곳에 복사합니다.",
  "     Client secret은 다시 표시되지 않을 수 있습니다.",
  "  8. npm run setup -- --prepare-env를 먼저 실행한 뒤,",
  "     .env.local의 GOOGLE_CLIENT_ID와 GOOGLE_CLIENT_SECRET에 두 값을 넣고 setup을 다시 실행합니다.",
].join("\n");
export const SETUP_COMPLETION_NEXT_STEPS = [
  "이 setup은 이 저장소와 배포에 연결되는 독립 ShareDesk 하나를 준비했습니다.",
  "다른 사람의 ShareDesk와 OAuth, Drive, 사용자 정보가 섞이지 않습니다.",
  "다음 단계:",
  "  1. npm run dev 실행 → http://localhost:3000 에서 호스트 Google 계정으로 로그인하세요.",
  "  2. 내 Vercel 프로젝트의 Production 환경에 .env.local의 운영 필수 값을 안전하게 옮기세요.",
  "     비밀값을 채팅이나 명령 인자에 출력하지 마세요.",
  "  3. Vercel의 고정 Production 도메인은 VERCEL_PROJECT_PRODUCTION_URL을 자동으로 사용합니다.",
  "     Vercel Settings > Environment Variables에서 Automatically expose System Environment Variables를 켜세요.",
  "     사용자 지정 도메인은 PUBLIC_BASE_URL=https://<고정된-운영-도메인>으로 고정하세요.",
  "  4. Google Auth Platform > Clients에 아래 운영 redirect URI가 있는지 확인하세요:",
  "     https://<고정된-운영-도메인>/api/auth/google/callback",
  "     커밋별 Preview URL은 등록하지 않습니다.",
  "  5. Vercel Production 환경 변수를 저장하거나 바꾼 뒤에는 반드시 Redeploy하세요.",
  "     환경 변수 변경은 이미 만들어진 배포에 자동으로 반영되지 않습니다.",
  "  6. 운영 확인 뒤 /admin에서 받을 사람의 이름과 Google 이메일, 유효 기간을 정해 1회용 초대 코드를 만드세요.",
  "     참여자는 지정된 Google 계정으로 먼저 로그인한 뒤 받은 코드를 입력하며 OAuth를 따로 발급받지 않습니다.",
  "     자기 데스크가 필요한 사람은 ShareDesk 템플릿으로 별도 설치를 진행합니다.",
].join("\n");
const FOLDER_MIME = "application/vnd.google-apps.folder";
const STATE_DIR = ".sharedesk";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const CORE_STATE_FILES = [
  {
    name: "users.json",
    value: {
      version: 2,
      rev: 0,
      users: [],
      invitations: [],
    },
  },
  {
    name: "drive-shares.json",
    value: {
      version: 2,
      rev: 0,
      permissions: [],
    },
  },
];

function runWindowsCommand(executable, args) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("Windows 비밀 파일 권한 명령을 실행하지 못했습니다."));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function windowsExecutable(name) {
  const windowsRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.join(windowsRoot, "System32", name);
}

let windowsUserSidPromise;

export function parseWhoamiUserSid(output) {
  const row = output.trim();
  const match = row.match(/^"((?:[^"]|"")*)","(S-\d+(?:-\d+)+)"$/);
  const sid = match?.[2];
  if (!sid || !/^S-\d+(?:-\d+)+$/.test(sid)) {
    throw new Error("Windows 현재 사용자 SID를 확인하지 못했습니다.");
  }
  return sid;
}

async function windowsUserSid() {
  windowsUserSidPromise ??= runWindowsCommand(
    windowsExecutable("whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
  ).then(parseWhoamiUserSid);
  return windowsUserSidPromise;
}

async function setWindowsPrivateAcl(filePath, sid, directory = false) {
  const permission = directory ? `*${sid}:(OI)(CI)(F)` : `*${sid}:(F)`;
  await runWindowsCommand(windowsExecutable("icacls.exe"), [
    filePath,
    "/inheritance:r",
    "/grant:r",
    permission,
    "/q",
  ]);
}

async function verifyWindowsPrivateAcl(filePath, sid) {
  const auditRoot = await mkdtemp(path.join(tmpdir(), "sharedesk-acl-"));
  const auditPath = path.join(auditRoot, "acl");
  let cleanupFailed = false;
  try {
    await setWindowsPrivateAcl(auditRoot, sid, true);
    await runWindowsCommand(windowsExecutable("icacls.exe"), [
      filePath,
      "/save",
      auditPath,
      "/q",
    ]);
    const savedAcl = await readFile(auditPath, "utf16le");
    const descriptor = savedAcl
      .split(/\r?\n/)
      .find((line) => line.startsWith("D:"));
    const firstAce = descriptor?.indexOf("(") ?? -1;
    const descriptorFlags =
      descriptor && firstAce >= 0 ? descriptor.slice(2, firstAce) : "";
    const aces = descriptor
      ? [...descriptor.matchAll(/\(([^()]*)\)/g)].map((match) =>
          match[1].split(";"),
        )
      : [];
    const onlyAce = aces[0];
    const isPrivate =
      descriptorFlags.includes("P") &&
      aces.length === 1 &&
      onlyAce?.[0] === "A" &&
      onlyAce?.[2] === "FA" &&
      onlyAce?.[5]?.toUpperCase() === sid.toUpperCase();
    if (!isPrivate) {
      throw new Error("Windows 비밀 파일 권한 확인에 실패했습니다.");
    }
  } finally {
    try {
      await rm(auditRoot, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    throw new Error("Windows 권한 확인용 임시 파일을 정리하지 못했습니다.");
  }
}

export async function protectPrivateFile(filePath) {
  try {
    if (process.platform === "win32") {
      const sid = await windowsUserSid();
      await setWindowsPrivateAcl(filePath, sid);
      await verifyWindowsPrivateAcl(filePath, sid);
      return;
    }

    await chmod(filePath, 0o600);
    if (((await stat(filePath)).mode & 0o777) !== 0o600) {
      throw new Error("잘못된 POSIX 파일 권한입니다.");
    }
  } catch {
    throw new Error("비밀 파일 권한을 소유자 전용으로 설정하지 못했습니다.");
  }
}

export async function protectPrivateDirectory(directoryPath) {
  try {
    if (process.platform === "win32") {
      const sid = await windowsUserSid();
      await setWindowsPrivateAcl(directoryPath, sid, true);
      await verifyWindowsPrivateAcl(directoryPath, sid);
      return;
    }

    await chmod(directoryPath, 0o700);
    if (((await stat(directoryPath)).mode & 0o777) !== 0o700) {
      throw new Error("잘못된 POSIX 폴더 권한입니다.");
    }
  } catch {
    throw new Error("비밀 작업 폴더 권한을 소유자 전용으로 설정하지 못했습니다.");
  }
}

async function removePrivateArtifact(filePath, removeFile = unlink) {
  try {
    await removeFile(filePath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function removePrivateDirectory(directoryPath, removeDirectory = rmdir) {
  try {
    await removeDirectory(directoryPath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

export async function writePrivateFile(
  filePath,
  contents,
  {
    createStagingDirectory = mkdtemp,
    protectDirectory = protectPrivateDirectory,
    protectFile = protectPrivateFile,
    removeFile = unlink,
    removeDirectory = rmdir,
  } = {},
) {
  let stagingPath;
  let tempPath;
  let backupPath;
  let stagingCreated = false;
  const hadExistingFile = existsSync(filePath);
  let tempCreated = false;
  let backupCreated = false;
  let backupReady = false;
  let finalReplaced = false;
  let existingContents;
  try {
    // 대상과 같은 폴더에 staging을 만들면 최종 rename이 같은 볼륨에서 이뤄진다.
    // 아직 비밀이 없을 때 폴더부터 잠가 이후 파일이 생성 순간부터 제한 ACL을 상속받게 한다.
    stagingPath = await createStagingDirectory(
      path.join(path.dirname(filePath), ".sharedesk-private-"),
    );
    stagingCreated = true;
    await protectDirectory(stagingPath);
    tempPath = path.join(stagingPath, "new");
    backupPath = path.join(stagingPath, "previous");

    if (hadExistingFile) {
      await protectFile(filePath);
      existingContents = await readFile(filePath);

      // 하드 링크를 지원하지 않는 파일 시스템에서도 되돌릴 수 있도록 별도 파일에
      // 복사한다. 백업 역시 빈 파일일 때 먼저 보호하고 나서 기존 내용을 기록한다.
      const backupHandle = await open(backupPath, "wx", 0o600);
      backupCreated = true;
      await backupHandle.close();
      await protectFile(backupPath);
      await writeFile(backupPath, existingContents, { flag: "r+" });
      backupReady = true;
      existingContents.fill(0);
      existingContents = undefined;
    }

    // 빈 파일부터 보호한 다음 내용을 쓴다. Windows에서 상속 ACL을 끊기 전에
    // refresh token이나 PKCE가 잠깐이라도 다른 계정에 노출되는 틈을 만들지 않는다.
    const handle = await open(tempPath, "wx", 0o600);
    tempCreated = true;
    await handle.close();
    await protectFile(tempPath);
    await writeFile(tempPath, contents, { encoding: "utf8", flag: "r+" });
    await rename(tempPath, filePath);
    tempCreated = false;
    finalReplaced = true;
    await protectFile(filePath);
  } catch {
    existingContents?.fill(0);

    if (finalReplaced) {
      if (backupReady) {
        try {
          await rename(backupPath, filePath);
          backupCreated = false;
          backupReady = false;
        } catch {
          throw new Error(
            "비밀 파일 교체를 되돌리지 못했습니다. 새 파일과 보호된 복구 파일은 그대로 보존했습니다.",
          );
        }
        const stagingRemoved = await removePrivateDirectory(
          stagingPath,
          removeDirectory,
        );
        if (!stagingRemoved) {
          throw new Error(
            "기존 비밀 파일은 복원했지만 빈 보호 작업 폴더를 정리하지 못했습니다.",
          );
        }
      } else {
        const removed = await removePrivateArtifact(filePath, removeFile);
        if (!removed) {
          throw new Error(
            "새 비밀 파일을 정리하지 못했습니다. 파일 권한은 현재 사용자 전용으로 제한되어 있습니다.",
          );
        }
        const stagingRemoved = await removePrivateDirectory(
          stagingPath,
          removeDirectory,
        );
        if (!stagingRemoved) {
          throw new Error(
            "새 비밀 파일은 제거했지만 빈 보호 작업 폴더를 정리하지 못했습니다.",
          );
        }
      }
    } else {
      const tempRemoved =
        !tempCreated ||
        (await removePrivateArtifact(tempPath, removeFile));
      const backupRemoved =
        !backupCreated ||
        (await removePrivateArtifact(backupPath, removeFile));
      const stagingRemoved =
        (!stagingCreated || (tempRemoved && backupRemoved)) &&
        (!stagingCreated ||
          (await removePrivateDirectory(stagingPath, removeDirectory)));
      if (!tempRemoved || !backupRemoved || !stagingRemoved) {
        throw new Error(
          "설정은 중단됐고 기존 파일은 보존됐지만 보호된 작업 파일을 정리하지 못했습니다.",
        );
      }
    }
    throw new Error("비밀 파일을 안전하게 저장하지 못해 설정을 중단했습니다.");
  }

  // 여기부터는 새 최종 파일의 권한 확인까지 끝난 커밋 이후 정리다. 백업 삭제가
  // 실패해도 성공한 최종 파일을 지우거나 백업을 되돌림 원본으로 다시 쓰지 않는다.
  if (backupCreated) {
    const removed = await removePrivateArtifact(backupPath, removeFile);
    if (!removed) {
      throw new Error(
        "비밀 파일 저장은 끝났지만 보호된 이전 파일을 정리하지 못했습니다.",
      );
    }
    backupCreated = false;
  }
  if (stagingCreated) {
    const removed = await removePrivateDirectory(stagingPath, removeDirectory);
    if (!removed) {
      throw new Error(
        "비밀 파일 저장은 끝났지만 빈 보호 작업 폴더를 정리하지 못했습니다.",
      );
    }
  }
}

export async function prepareEnvFile({
  envPath = ENV_PATH,
  examplePath = ENV_EXAMPLE_PATH,
  privateWriter = writePrivateFile,
} = {}) {
  if (existsSync(envPath)) {
    await protectPrivateFile(envPath);
    return "protected";
  }

  let created = false;
  let example;
  try {
    const handle = await open(envPath, "wx", 0o600);
    created = true;
    await handle.close();
    await protectPrivateFile(envPath);
    example = await readFile(examplePath);
    await privateWriter(envPath, example);
    example.fill(0);
    example = undefined;
    await protectPrivateFile(envPath);
    return "created";
  } catch (error) {
    example?.fill(0);
    if (error?.code === "EEXIST") {
      await protectPrivateFile(envPath);
      return "protected";
    }
    if (created) {
      await removePrivateArtifact(envPath);
    }
    throw new Error("로컬 환경 파일을 안전하게 준비하지 못했습니다.");
  }
}

function newSessionSecret() {
  return randomBytes(32).toString("hex");
}

export function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    // dotenv 관례대로 감싼 따옴표를 벗긴다 — 벗기지 않으면 앱(Next dotenv)과
    // 이 스크립트가 같은 파일을 다르게 읽는다.
    const raw = m[2].trim();
    env[m[1]] =
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
  }
  return env;
}

export function mergeEnv(text, updates) {
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && updates[m[1]] !== undefined) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  out.push("");
  return out.join("\n");
}

function assertSingleCoreStateFiles(files) {
  for (const { name } of CORE_STATE_FILES) {
    const matches = files.filter((file) => file.name === name);
    if (matches.length > 1) {
      throw new Error(
        `.sharedesk/${name} 파일이 여러 개입니다. 데이터를 확인해 하나만 남긴 뒤 다시 실행하세요.`,
      );
    }
  }
}

async function listCoreStateFiles(fetchImpl, accessToken, stateFolderId) {
  const files = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `'${stateFolderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name)",
      pageSize: "1000",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetchImpl(`${DRIVE_API}/files?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`핵심 상태 파일 조회 실패 (${response.status})`);
    }
    const body = await response.json();
    files.push(
      ...(body.files || []).filter((file) =>
        CORE_STATE_FILES.some(({ name }) => name === file.name),
      ),
    );
    pageToken = body.nextPageToken;
  } while (pageToken);
  return files;
}

async function uploadCoreStateFile(
  fetchImpl,
  accessToken,
  stateFolderId,
  stateFile,
) {
  const boundary = `sharedesk_${randomBytes(16).toString("hex")}`;
  const metadata = JSON.stringify({
    name: stateFile.name,
    mimeType: "application/json",
    parents: [stateFolderId],
  });
  const content = JSON.stringify(stateFile.value, null, 2) + "\n";
  const body = [
    `--${boundary}\r\n`,
    "Content-Type: application/json; charset=UTF-8\r\n\r\n",
    `${metadata}\r\n`,
    `--${boundary}\r\n`,
    "Content-Type: application/json; charset=UTF-8\r\n\r\n",
    `${content}\r\n`,
    `--${boundary}--\r\n`,
  ].join("");
  const response = await fetchImpl(
    `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!response.ok) {
    throw new Error(`${stateFile.name} 생성 실패 (${response.status})`);
  }
}

/**
 * @param {{
 *   accessToken: string;
 *   stateFolderId: string;
 *   fetchImpl?: typeof fetch;
 *   log?: Pick<Console, "info">;
 * }} options
 */
export async function ensureCoreStateFiles({
  accessToken,
  stateFolderId,
  fetchImpl = fetch,
  log = console,
}) {
  const existing = await listCoreStateFiles(
    fetchImpl,
    accessToken,
    stateFolderId,
  );
  assertSingleCoreStateFiles(existing);

  for (const stateFile of CORE_STATE_FILES) {
    if (existing.some((file) => file.name === stateFile.name)) {
      log.info(`기존 상태 파일을 보존합니다: ${stateFile.name}`);
      continue;
    }
    await uploadCoreStateFile(
      fetchImpl,
      accessToken,
      stateFolderId,
      stateFile,
    );
    log.info(`핵심 상태 파일을 만들었습니다: ${stateFile.name}`);
  }

  // Drive는 동명 파일을 허용한다. 생성 직후 다시 조회해 다른 setup 실행과
  // 겹쳐 둘이 된 경우도 임의로 하나를 고르지 않고 중단한다.
  const verified = await listCoreStateFiles(
    fetchImpl,
    accessToken,
    stateFolderId,
  );
  assertSingleCoreStateFiles(verified);
  for (const { name } of CORE_STATE_FILES) {
    if (!verified.some((file) => file.name === name)) {
      throw new Error(`.sharedesk/${name} 파일 생성을 확인하지 못했습니다.`);
    }
  }
}

async function main() {
  if (process.argv.includes("--prepare-env")) {
    const result = await prepareEnvFile();
    console.log(
      result === "created"
        ? ".env.local을 소유자 전용 권한으로 준비했습니다. 이제 OAuth 값을 입력하세요."
        : "기존 .env.local 내용은 건드리지 않고 소유자 전용 권한만 확인했습니다.",
    );
    return;
  }

  let raw = "";
  if (existsSync(ENV_PATH)) {
    await protectPrivateFile(ENV_PATH);
    raw = await readFile(ENV_PATH, "utf8");
  }
  const fileEnv = parseEnv(raw);
  const get = (k) => fileEnv[k] || process.env[k] || "";

  const clientId = get("GOOGLE_CLIENT_ID");
  const clientSecret = get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    console.error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET이 .env.local에 없습니다.");
    console.error("");
    console.error(GOOGLE_AUTH_PLATFORM_GUIDANCE);
    process.exit(1);
  }

  const finishArg = process.argv.indexOf("--finish");
  const isFinish = finishArg >= 0;

  // --- 1단계: 인증 URL 생성 ---
  if (!isFinish) {
    // state와 PKCE로 콜백 위조를 막는다 (RFC 8252 §8.1/§8.9).
    const state = randomBytes(16).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    const authUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

    if (process.argv.includes("--check")) {
      console.log("[check] 환경 점검 통과. 인증 URL:");
      console.log(authUrl);
      return;
    }

    await writePrivateFile(
      PENDING_PATH,
      JSON.stringify({ state, codeVerifier, createdAt: Date.now() }, null, 2),
    );

    console.log("1) 아래 URL을 브라우저에서 열어 구글 계정으로 로그인하고 동의하세요:\n");
    console.log(authUrl + "\n");
    console.log(CALLBACK_URL_SECURITY_WARNING + "\n");
    console.log("2) 동의하면 브라우저가 127.0.0.1 주소로 이동하면서");
    console.log("   '연결할 수 없음' 같은 오류 화면이 뜹니다 — 정상입니다.");
    console.log("   그때 주소창의 주소 전체를 복사하세요.\n");
    console.log("3) 아래 명령을 실행한 뒤, 물어보면 복사한 주소를 붙여넣으세요:\n");
    console.log("   npm run setup -- --finish");
    return;
  }

  // --- 2단계: 붙여넣은 콜백 주소로 토큰 교환 ---
  if (!existsSync(PENDING_PATH)) {
    console.error("진행 중인 설정이 없습니다 — 먼저 npm run setup 을 실행하세요.");
    process.exit(1);
  }
  await protectPrivateFile(PENDING_PATH);
  const pending = JSON.parse(await readFile(PENDING_PATH, "utf8"));
  const { state, codeVerifier } = pending;

  if (process.argv[finishArg + 1]) {
    console.error(
      "callback URL은 명령 기록에 남지 않도록 인자로 받지 않습니다. npm run setup -- --finish만 실행하세요.",
    );
    process.exit(1);
  }
  console.warn("\n" + CALLBACK_URL_SECURITY_WARNING + "\n");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let pasted;
  try {
    pasted = await prompt.question("브라우저 주소창의 callback URL 전체를 붙여넣으세요: ");
  } finally {
    prompt.close();
  }
  if (!pasted.trim()) {
    console.error("callback URL을 입력하지 않았습니다.");
    process.exit(1);
  }
  let callbackUrl;
  try {
    callbackUrl = new URL(pasted.trim());
  } catch {
    console.error("주소 형식이 올바르지 않습니다:", pasted.slice(0, 60));
    process.exit(1);
  }
  const err = callbackUrl.searchParams.get("error");
  if (err) {
    console.error("동의가 거부되었습니다:", err);
    process.exit(1);
  }
  const code = callbackUrl.searchParams.get("code");
  const gotState = callbackUrl.searchParams.get("state") ?? "";
  if (!code) {
    console.error("주소에 code가 없습니다 — 동의 후 이동한 주소 전체를 붙여넣었는지 확인하세요.");
    process.exit(1);
  }
  if (
    gotState.length !== state.length ||
    !timingSafeEqual(Buffer.from(gotState), Buffer.from(state))
  ) {
    console.error("state가 일치하지 않습니다 — 이 설정 회차의 주소가 아닙니다.");
    process.exit(1);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
  });
  if (!tokenRes.ok) {
    console.error("토큰 교환 실패:", await tokenRes.text());
    process.exit(1);
  }
  const tok = await tokenRes.json();
  if (!tok.refresh_token) {
    console.error(
      "refresh_token을 받지 못했습니다 — https://myaccount.google.com/permissions 에서 이 앱을 제거한 뒤 다시 실행하세요.",
    );
    process.exit(1);
  }

  // 드라이브 주인이 곧 관리자다. 이 이메일로 로그인하면 자동 승인되고 관리 화면이 열린다.
  let adminEmails = fileEnv["ADMIN_EMAILS"] || "";
  if (!adminEmails) {
    const meRes = await fetch(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: `Bearer ${tok.access_token}` } },
    );
    if (meRes.ok) {
      const me = await meRes.json();
      if (me.email) {
        adminEmails = me.email;
        console.log("관리자로 등록:", me.email);
      }
    }
    if (!adminEmails) {
      console.warn(
        "경고: 관리자 이메일을 확인하지 못했습니다 — .env.local의 ADMIN_EMAILS를 직접 채우세요",
      );
    }
  }

  let rootId = get("DRIVE_ROOT_FOLDER_ID");
  if (rootId) {
    console.log("기존 루트 폴더를 그대로 사용합니다:", rootId);
  } else {
    const folderRes = await fetch(
      "https://www.googleapis.com/drive/v3/files?fields=id",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok.access_token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ name: "ShareDesk", mimeType: FOLDER_MIME }),
      },
    );
    if (!folderRes.ok) {
      console.error("루트 폴더 생성 실패:", await folderRes.text());
      process.exit(1);
    }
    rootId = (await folderRes.json()).id;
    console.log("드라이브에 루트 폴더 'ShareDesk'를 만들었습니다:", rootId);
  }

  // 서버리스 인스턴스들이 동시에 시작하며 각자 .sharedesk를 만드는 일을 막기 위해
  // 상태 폴더도 setup에서 한 번 정하고 ID를 고정한다.
  let stateFolderId = get("DRIVE_STATE_FOLDER_ID");
  if (stateFolderId) {
    const stateRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(stateFolderId)}?fields=id,name,mimeType,parents,trashed`,
      { headers: { Authorization: `Bearer ${tok.access_token}` } },
    );
    const state = stateRes.ok ? await stateRes.json() : null;
    if (
      !state ||
      state.name !== STATE_DIR ||
      state.mimeType !== FOLDER_MIME ||
      state.trashed === true ||
      state.parents?.[0] !== rootId
    ) {
      console.error(
        "DRIVE_STATE_FOLDER_ID가 현재 ShareDesk 루트의 .sharedesk 폴더가 아닙니다.",
      );
      process.exit(1);
    }
    console.log("기존 상태 폴더를 그대로 사용합니다:", stateFolderId);
  } else {
    const listStateFolders = async () => {
      const params = new URLSearchParams({
        q: `'${rootId}' in parents and name='${STATE_DIR}' and mimeType='${FOLDER_MIME}' and trashed=false`,
        fields: "files(id,createdTime)",
        pageSize: "1000",
      });
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files?${params}`,
        { headers: { Authorization: `Bearer ${tok.access_token}` } },
      );
      if (!response.ok) {
        console.error("상태 폴더 조회 실패:", await response.text());
        process.exit(1);
      }
      const body = await response.json();
      return (body.files || []).sort(
        (a, b) =>
          (a.createdTime || "").localeCompare(b.createdTime || "") ||
          a.id.localeCompare(b.id),
      );
    };

    let stateFolders = await listStateFolders();
    if (stateFolders.length > 1) {
      console.error(
        ".sharedesk 폴더가 여러 개라 자동으로 고를 수 없습니다. 데이터 확인 후 DRIVE_STATE_FOLDER_ID를 지정하세요.",
      );
      process.exit(1);
    }
    if (stateFolders[0]) {
      stateFolderId = stateFolders[0].id;
    } else {
      const createStateRes = await fetch(
        "https://www.googleapis.com/drive/v3/files?fields=id",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tok.access_token}`,
            "Content-Type": "application/json; charset=UTF-8",
          },
          body: JSON.stringify({
            name: STATE_DIR,
            mimeType: FOLDER_MIME,
            parents: [rootId],
          }),
        },
      );
      if (!createStateRes.ok) {
        console.error("상태 폴더 생성 실패:", await createStateRes.text());
        process.exit(1);
      }
      const createdState = await createStateRes.json();
      stateFolders = await listStateFolders();
      stateFolderId = stateFolders[0]?.id;
      if (!stateFolderId) {
        console.error("생성한 상태 폴더를 확인하지 못했습니다.");
        process.exit(1);
      }
      if (createdState.id !== stateFolderId) {
        await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(createdState.id)}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${tok.access_token}`,
              "Content-Type": "application/json; charset=UTF-8",
            },
            body: JSON.stringify({ trashed: true }),
          },
        );
      }
    }
    console.log("상태 폴더 '.sharedesk'를 고정했습니다:", stateFolderId);
  }

  await ensureCoreStateFiles({
    accessToken: tok.access_token,
    stateFolderId,
  });

  // 기본 입장 경로는 구글 로그인 + 관리자 승인이다. 키는 자동 생성하지 않고,
  // 손님용 임시 입장이 필요할 때만 ACCESS_KEYS에 직접 적어 넣는다.
  const accessKeys = fileEnv["ACCESS_KEYS"] || "";
  let sessionSecret = fileEnv["SESSION_SECRET"] || "";
  if (sessionSecret.length < 16) {
    sessionSecret = newSessionSecret();
  }

  const merged = mergeEnv(raw, {
    ACCESS_KEYS: accessKeys,
    ADMIN_EMAILS: adminEmails,
    SESSION_SECRET: sessionSecret,
    STORAGE_DRIVER: "drive",
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_REFRESH_TOKEN: tok.refresh_token,
    DRIVE_ROOT_FOLDER_ID: rootId,
    DRIVE_STATE_FOLDER_ID: stateFolderId,
  });
  await writePrivateFile(ENV_PATH, merged);
  // 인증 코드는 한 번만 쓰이므로 남겨둘 이유가 없다.
  try {
    await unlink(PENDING_PATH);
  } catch {
    console.warn(
      "경고: .setup-pending.json을 삭제하지 못했습니다. 설정을 마친 뒤 직접 삭제하세요.",
    );
  }

  console.log("\n=== 설정 완료 ===");
  console.log(".env.local 갱신됨 (refresh token은 파일에만 저장, 화면에 출력하지 않음)");
  console.log("루트 폴더 ID:", rootId);
  console.log("\n" + SETUP_COMPLETION_NEXT_STEPS);
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error("설정 실패:", e.message);
    process.exit(1);
  });
}
