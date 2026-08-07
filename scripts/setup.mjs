#!/usr/bin/env node
// ShareDesk 최초 설정 — 주인 1회 실행.
// OAuth 동의 → refresh token 획득 → 드라이브에 루트 폴더 생성 → .env.local 기록.
// 브라우저를 자동으로 열지 않는다: URL을 출력하면 사용자가 직접 연다.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ENV_PATH = path.resolve(process.cwd(), ".env.local");
// 1단계가 만든 state/PKCE를 2단계가 이어받는다. 콜백을 기다리는 서버를 띄우지 않으므로
// 장시간 대기 프로세스가 필요 없다 — 대기 중 프로세스가 죽어 설정이 날아가던 문제를 없앤다.
const PENDING_PATH = path.resolve(process.cwd(), ".setup-pending.json");
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
// drive.file: 이 앱이 만든 파일만 접근 / openid·email: 주인이 누구인지 확인해 관리자로 등록
const SCOPE =
  "https://www.googleapis.com/auth/drive.file openid email profile";
const FOLDER_MIME = "application/vnd.google-apps.folder";

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

async function main() {
  const raw = existsSync(ENV_PATH) ? await readFile(ENV_PATH, "utf8") : "";
  const fileEnv = parseEnv(raw);
  const get = (k) => fileEnv[k] || process.env[k] || "";

  const clientId = get("GOOGLE_CLIENT_ID");
  const clientSecret = get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    console.error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET이 .env.local에 없습니다.");
    console.error("");
    console.error("구글 클라우드 콘솔(console.cloud.google.com)에서:");
    console.error("  1. 프로젝트 생성 → Google Drive API 사용 설정");
    console.error("  2. OAuth 동의 화면 구성 (외부, 프로덕션 게시)");
    console.error("  3. 사용자 인증 정보 → OAuth 클라이언트 ID → 유형: '웹 애플리케이션'");
    console.error("     (데스크톱 앱 유형은 배포 주소를 리디렉션에 못 넣는다)");
    console.error("  4. 승인된 리디렉션 URI에 아래를 등록:");
    console.error(`       ${REDIRECT}`);
    console.error("       http://localhost:3000/api/auth/google/callback");
    console.error("  5. 발급된 클라이언트 ID/보안 비밀을 .env.local에 기입 후 재실행");
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

    await writeFile(
      PENDING_PATH,
      JSON.stringify({ state, codeVerifier, createdAt: Date.now() }, null, 2),
      "utf8",
    );

    console.log("1) 아래 URL을 브라우저에서 열어 구글 계정으로 로그인하고 동의하세요:\n");
    console.log(authUrl + "\n");
    console.log("2) 동의하면 브라우저가 127.0.0.1 주소로 이동하면서");
    console.log("   '연결할 수 없음' 같은 오류 화면이 뜹니다 — 정상입니다.");
    console.log("   그때 주소창의 주소 전체를 복사하세요.\n");
    console.log("3) 복사한 주소로 아래 명령을 실행하면 설정이 끝납니다:\n");
    console.log('   npm run setup -- --finish "<복사한 주소>"');
    return;
  }

  // --- 2단계: 붙여넣은 콜백 주소로 토큰 교환 ---
  if (!existsSync(PENDING_PATH)) {
    console.error("진행 중인 설정이 없습니다 — 먼저 npm run setup 을 실행하세요.");
    process.exit(1);
  }
  const pending = JSON.parse(await readFile(PENDING_PATH, "utf8"));
  const { state, codeVerifier } = pending;

  const pasted = process.argv[finishArg + 1];
  if (!pasted) {
    console.error('사용법: npm run setup -- --finish "<복사한 주소>"');
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
  });
  await writeFile(ENV_PATH, merged, "utf8");
  // 인증 코드는 한 번만 쓰이므로 남겨둘 이유가 없다.
  await unlink(PENDING_PATH).catch(() => {});

  console.log("\n=== 설정 완료 ===");
  console.log(".env.local 갱신됨 (refresh token은 파일에만 저장, 화면에 출력하지 않음)");
  console.log("루트 폴더 ID:", rootId);
  console.log("\n다음 단계:");
  console.log("  1. npm run dev 실행 → http://localhost:3000 에서 구글 로그인");
  console.log("  2. 다른 사람이 로그인하면 /admin 화면에서 승인하세요.");
  console.log("  3. 배포한 뒤에는 리디렉션 URI에 아래를 추가로 등록하세요:");
  console.log("     https://<배포도메인>/api/auth/google/callback");
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
