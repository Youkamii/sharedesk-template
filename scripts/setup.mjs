#!/usr/bin/env node
// ShareDesk 최초 설정 — 주인 1회 실행.
// OAuth 동의 → refresh token 획득 → 드라이브에 루트 폴더 생성 → .env.local 기록.
// 브라우저를 자동으로 열지 않는다: URL을 출력하면 사용자가 직접 연다.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ENV_PATH = path.resolve(process.cwd(), ".env.local");
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
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
    console.error("  3. 사용자 인증 정보 → OAuth 클라이언트 ID → 유형: '데스크톱 앱'");
    console.error("  4. 발급된 클라이언트 ID/보안 비밀을 .env.local에 기입 후 재실행");
    process.exit(1);
  }

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
    });

  if (process.argv.includes("--check")) {
    console.log("[check] 환경 점검 통과. 인증 URL:");
    console.log(authUrl);
    return;
  }

  console.log("아래 URL을 브라우저에서 열어 구글 계정으로 로그인하고 동의하세요:\n");
  console.log(authUrl + "\n");
  console.log(`동의가 끝나면 자동으로 돌아옵니다 (127.0.0.1:${PORT} 대기 중, Ctrl+C로 중단)...`);

  const code = await new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
      if (u.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const err = u.searchParams.get("error");
      const c = u.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        err || !c
          ? "<h3>인증이 거부되었습니다. 터미널을 확인하세요.</h3>"
          : "<h3>인증 완료 — 이 창을 닫고 터미널로 돌아가세요.</h3>",
      );
      server.close();
      if (err || !c) reject(new Error("동의가 거부되었습니다: " + (err ?? "code 없음")));
      else resolve(c);
    });
    server.on("error", (e) =>
      reject(
        e.code === "EADDRINUSE"
          ? new Error(`포트 ${PORT}가 사용 중입니다 — 이전 setup이 떠 있는지 확인하세요`)
          : e,
      ),
    );
    server.listen(PORT, "127.0.0.1");
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
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

  let accessKeys = fileEnv["ACCESS_KEYS"] || "";
  let generatedKey = null;
  if (!accessKeys) {
    generatedKey = "sd-" + randomBytes(6).toString("hex");
    accessKeys = generatedKey;
  }
  let sessionSecret = fileEnv["SESSION_SECRET"] || "";
  if (sessionSecret.length < 16) {
    sessionSecret = randomBytes(32).toString("hex");
  }

  const merged = mergeEnv(raw, {
    ACCESS_KEYS: accessKeys,
    SESSION_SECRET: sessionSecret,
    STORAGE_DRIVER: "drive",
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_REFRESH_TOKEN: tok.refresh_token,
    DRIVE_ROOT_FOLDER_ID: rootId,
  });
  await writeFile(ENV_PATH, merged, "utf8");

  console.log("\n=== 설정 완료 ===");
  console.log(".env.local 갱신됨 (refresh token은 파일에만 저장, 화면에 출력하지 않음)");
  console.log("루트 폴더 ID:", rootId);
  if (generatedKey) console.log("생성된 접속 키:", generatedKey);
  console.log("\n다음 단계: npm run dev 실행 후 http://localhost:3000 에서 키로 입장하세요.");
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
