#!/usr/bin/env node
// ShareDesk CLI(#34) — 터미널·AI 에이전트가 데스크의 파일을 보고, 받고, 올린다.
//
// 외부 의존성 없이 Node 20+의 fetch만 쓴다. 인증은 데스크 화면의 "CLI 연결"
// 창에서 받은 토큰을 브라우저와 똑같이 세션 쿠키로 보내는 것이 전부라, 서버에
// CLI 전용 인증 경로가 없다. 설정은 ~/.sharedesk/config.json 또는 환경변수
// SHAREDESK_URL / SHAREDESK_TOKEN(환경변수가 우선).
//
//   node cli/sharedesk.mjs login https://desk.example.com <토큰>
//   node cli/sharedesk.mjs ls [폴더 경로] [--json]
//   node cli/sharedesk.mjs get <파일 경로> [저장 위치]
//   node cli/sharedesk.mjs put <로컬 파일> [폴더 경로] [--name 이름]
//   node cli/sharedesk.mjs mkdir <폴더 경로>
//   node cli/sharedesk.mjs status
//
// 업로드는 데스크가 Google Drive 모드면 브라우저와 같은 직행(resumable) 전송 —
// 파일 본문이 ShareDesk 서버(Vercel)를 지나지 않는다. 로컬 모드면 서버가 받는다.

import { createWriteStream } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

export const COOKIE_NAME = "sharedesk_session";
export const CHUNK_SIZE = 8 * 1024 * 1024;
const CONFIG_DIR = path.join(homedir(), ".sharedesk");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const MIME_BY_EXT = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
};

export class CliError extends Error {
  constructor(message, { status, exitCode = 1 } = {}) {
    super(message);
    this.status = status;
    this.exitCode = exitCode;
  }
}

export function mimeTypeFor(name) {
  return MIME_BY_EXT[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

// "a/b/파일.txt" → { folder: "a/b", name: "파일.txt" }. 끝 슬래시는 폴더만 뜻한다.
export function splitDeskPath(deskPath) {
  const trimmed = String(deskPath ?? "").replace(/\\/g, "/");
  const segments = trimmed.split("/").filter((segment) => segment && segment !== ".");
  const name = trimmed.endsWith("/") ? "" : (segments.pop() ?? "");
  return { folder: segments.join("/"), name };
}

export function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new CliError("데스크 주소가 올바르지 않습니다 (예: https://desk.example.com)");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CliError("데스크 주소는 http(s)여야 합니다");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

// Google resumable 업로드의 308 응답 Range: bytes=0-N → 다음 시작 위치 N+1.
export function resumableOffsetFromRange(range) {
  const match = /bytes=0-(\d+)/.exec(range ?? "");
  if (!match) return 0;
  const offset = Number(match[1]) + 1;
  return Number.isSafeInteger(offset) ? offset : 0;
}

export async function loadConfig({ env = process.env, configFile = CONFIG_FILE } = {}) {
  let stored = {};
  try {
    stored = JSON.parse(await readFile(configFile, "utf8"));
  } catch {
    stored = {};
  }
  const url = env.SHAREDESK_URL || stored.url;
  const token = env.SHAREDESK_TOKEN || stored.token;
  if (!url || !token) {
    throw new CliError(
      "연결 정보가 없습니다. 데스크 사이드바 'CLI 연결'에서 토큰을 받아 `login <주소> <토큰>`을 먼저 실행하세요.",
      { exitCode: 2 },
    );
  }
  return { url: normalizeBaseUrl(url), token: String(token) };
}

export async function saveConfig(config, { configFile = CONFIG_FILE } = {}) {
  await mkdir(path.dirname(configFile), { recursive: true });
  await writeFile(configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  // Windows는 mode를 무시한다 — 실패해도 조용히 넘어간다.
  await chmod(configFile, 0o600).catch(() => undefined);
}

export class DeskClient {
  constructor({ url, token, fetchImpl = globalThis.fetch }) {
    this.url = normalizeBaseUrl(url);
    this.token = token;
    this.fetch = fetchImpl;
  }

  async request(pathname, init = {}) {
    const headers = new Headers(init.headers ?? {});
    headers.set("Cookie", `${COOKIE_NAME}=${this.token}`);
    const response = await this.fetch(this.url + pathname, { ...init, headers });
    if (response.status === 401) {
      throw new CliError("토큰이 만료됐거나 끊겼습니다. 데스크에서 새 토큰을 받으세요.", {
        status: 401,
        exitCode: 3,
      });
    }
    return response;
  }

  async json(pathname, init = {}) {
    const response = await this.request(pathname, init);
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message =
        body && typeof body.error === "string" ? body.error : `요청 실패 (HTTP ${response.status})`;
      throw new CliError(message, { status: response.status });
    }
    return body;
  }

  async resolveFolder(folderPath) {
    const body = await this.json(
      `/api/drive/path?path=${encodeURIComponent("/" + (folderPath ?? ""))}`,
    );
    return body.folderId;
  }

  async list(folderPath = "") {
    const folderId = await this.resolveFolder(folderPath);
    const body = await this.json(
      `/api/drive/list?folderId=${encodeURIComponent(folderId)}&layout=0`,
    );
    return { folderId, entries: Array.isArray(body.entries) ? body.entries : [] };
  }

  async findEntry(deskPath) {
    const { folder, name } = splitDeskPath(deskPath);
    if (!name) throw new CliError("파일 경로가 필요합니다");
    const { entries } = await this.list(folder);
    const matches = entries.filter((entry) => entry.name === name);
    if (matches.length === 0) throw new CliError(`${deskPath}: 그런 항목이 없습니다`, { status: 404 });
    if (matches.length > 1) {
      throw new CliError(`${deskPath}: 같은 이름이 ${matches.length}개라 고를 수 없습니다`);
    }
    return matches[0];
  }

  async download(deskPath, destination) {
    const entry = await this.findEntry(deskPath);
    if (entry.isFolder) throw new CliError(`${deskPath}: 폴더는 받을 수 없습니다`);
    const response = await this.request(
      `/api/drive/download?id=${encodeURIComponent(entry.id)}`,
    );
    if (!response.ok || !response.body) {
      const body = await response.json().catch(() => null);
      throw new CliError(
        body && typeof body.error === "string" ? body.error : `다운로드 실패 (HTTP ${response.status})`,
        { status: response.status },
      );
    }
    let target = destination ?? entry.name;
    const info = await stat(target).catch(() => null);
    if (info?.isDirectory()) target = path.join(target, entry.name);
    await mkdir(path.dirname(path.resolve(target)), { recursive: true });
    await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
    return { entry, path: target };
  }

  async mkdir(deskPath) {
    const { folder, name } = splitDeskPath(deskPath);
    if (!name) throw new CliError("폴더 이름이 필요합니다");
    const parentId = await this.resolveFolder(folder);
    const body = await this.json("/api/drive/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parentId }),
    });
    return body.entry;
  }

  async upload(localPath, folderPath = "", { name, onProgress } = {}) {
    const info = await stat(localPath).catch(() => null);
    if (!info?.isFile()) throw new CliError(`${localPath}: 파일이 아닙니다`);
    const fileName = name || path.basename(localPath);
    const mimeType = mimeTypeFor(fileName);
    const parentId = await this.resolveFolder(folderPath);
    const session = await this.json("/api/drive/upload-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: fileName, parentId, mimeType, size: info.size }),
    });
    if (session.mode === "direct") {
      const fileId = await this.uploadResumable(session.url, localPath, info.size, onProgress);
      // 완료 보고는 파일 id가 있어야 한다. 없으면 예약이 TTL까지 남지만 파일은 올라갔다.
      if (!session.reservationId || !fileId) return { id: fileId, name: fileName, size: info.size };
      await this.json("/api/drive/upload-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationId: session.reservationId, fileId }),
      });
      return { id: fileId, name: fileName, size: info.size };
    }
    // 프록시 모드(로컬 드라이버) — 서버가 본문을 받는다. 예약이 있으면 같이 보낸다.
    const query = new URLSearchParams({ parentId, name: fileName });
    if (session.reservationId) query.set("reservationId", session.reservationId);
    const body = await readFile(localPath);
    const result = await this.json(`/api/drive/upload?${query}`, {
      method: "POST",
      headers: { "Content-Type": mimeType, "Content-Length": String(body.byteLength) },
      body,
    });
    onProgress?.(info.size, info.size);
    return result.entry;
  }

  // Google Drive resumable 세션에 8MiB 조각을 PUT한다. 308이면 서버가 알려 준
  // 위치부터 잇고, 일시 오류는 위치를 다시 물어(bytes */total) 최대 3번 재시도.
  async uploadResumable(sessionUrl, localPath, total, onProgress) {
    const handle = await open(localPath, "r");
    try {
      let offset = 0;
      let retries = 0;
      let recovering = false;
      for (;;) {
        let response;
        try {
          if (recovering || total === 0) {
            // 위치 조회 — 빈 파일은 이 한 번의 PUT이 곧 완료 요청이다.
            response = await this.fetch(sessionUrl, {
              method: "PUT",
              headers: { "Content-Range": `bytes */${total}` },
            });
          } else {
            const end = Math.min(offset + CHUNK_SIZE, total) - 1;
            const chunk = Buffer.alloc(end - offset + 1);
            await handle.read(chunk, 0, chunk.length, offset);
            response = await this.fetch(sessionUrl, {
              method: "PUT",
              headers: {
                "Content-Range": `bytes ${offset}-${end}/${total}`,
                "Content-Length": String(chunk.length),
              },
              body: chunk,
            });
          }
        } catch (error) {
          if (retries >= 3) throw new CliError(`드라이브 전송 중 네트워크 오류: ${error.message}`);
          retries += 1;
          recovering = true;
          continue;
        }
        if (response.status === 308) {
          const next = resumableOffsetFromRange(response.headers.get("range"));
          if (next > total) throw new CliError("서버의 업로드 위치가 파일 크기를 넘었습니다");
          // 위치 조회(recovering) 뒤에는 재시도 횟수를 건드리지 않는다 — 조각
          // 전송이 실패할 때마다 셌다가 조회 성공으로 0이 되면 끝없이 돈다.
          if (!recovering) {
            if (next > offset) {
              retries = 0;
            } else if (retries >= 3) {
              throw new CliError("드라이브 업로드가 더 진행되지 않습니다");
            } else {
              retries += 1;
            }
          }
          offset = next;
          recovering = false;
          onProgress?.(offset, total);
          continue;
        }
        if (response.status === 200 || response.status === 201) {
          onProgress?.(total, total);
          const body = await response.json().catch(() => null);
          // 브라우저와 같이 id가 없어도 실패로 보지 않는다 — 파일은 이미 Drive에 있다.
          return body && typeof body.id === "string" ? body.id : null;
        }
        if (response.status === 404 || response.status === 410) {
          throw new CliError("드라이브 업로드 세션이 만료되었습니다. 다시 올려 주세요.");
        }
        if (response.status === 429 || response.status >= 500) {
          if (retries >= 3) throw new CliError(`드라이브 업로드 실패 (HTTP ${response.status})`);
          retries += 1;
          recovering = true;
          continue;
        }
        throw new CliError(`드라이브 업로드 실패 (HTTP ${response.status})`);
      }
    } finally {
      await handle.close();
    }
  }
}

function formatSize(size) {
  if (size === null || size === undefined) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  return `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--json") flags.json = true;
    else if (arg === "--name") flags.name = argv[++index];
    else if (arg.startsWith("--name=")) flags.name = arg.slice("--name=".length);
    else if (arg === "--help" || arg === "-h") flags.help = true;
    else positional.push(arg);
  }
  return { positional, flags };
}

const USAGE = `ShareDesk CLI

  login <주소>                     데스크에 연결한다 (토큰은 물어볼 때 붙여 넣거나 SHAREDESK_TOKEN 환경변수로)
  status                           연결 상태를 확인한다
  ls [폴더 경로] [--json]          폴더 안 항목을 본다 (기본: 바탕화면)
  get <파일 경로> [저장 위치]      파일을 받는다
  put <로컬 파일> [폴더 경로] [--name 이름]   파일을 올린다
  mkdir <폴더 경로>                폴더를 만든다

환경변수 SHAREDESK_URL / SHAREDESK_TOKEN 이 설정 파일(~/.sharedesk/config.json)보다 우선한다.
경로는 바탕화면 기준이며 '/'로 나눈다. 예: 보고서/2026/요약.pdf`;

// 터미널이면 화면에 안 보이게 한 줄을 읽고, 파이프면 stdin 한 줄을 그대로 읽는다.
async function readSecret(prompt) {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) {
    let data = "";
    stdin.setEncoding("utf8");
    for await (const chunk of stdin) data += chunk;
    return data.split(/\r?\n/)[0].trim();
  }
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  let line = "";
  try {
    for await (const chunk of stdin) {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stderr.write("\n");
          return line.trim();
        }
        if (ch === "\u0003") throw new CliError("취소했습니다", { exitCode: 130 });
        if (ch === "\u007f" || ch === "\b") line = line.slice(0, -1);
        else line += ch;
      }
    }
    return line.trim();
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

const defaultIo = { out: console.log, err: console.error, secret: readSecret };

export async function main(argv = process.argv.slice(2), io = defaultIo) {
  const { positional, flags } = parseArgs(argv);
  const [command, ...rest] = positional;
  if (!command || flags.help) {
    io.out(USAGE);
    return 0;
  }
  const emit = (data, text) => io.out(flags.json ? JSON.stringify(data) : text);

  if (command === "login") {
    const [url, argToken] = rest;
    if (!url) throw new CliError("사용법: login <주소>  (토큰은 물어보거나 SHAREDESK_TOKEN 환경변수로)", { exitCode: 2 });
    // 토큰은 인자보다 환경변수·입력으로 받는 쪽을 권한다 — 인자로 주면 셸
    // 기록과 프로세스 목록에 남는다. 인자도 받지만 경고한다.
    let token = process.env.SHAREDESK_TOKEN || argToken;
    if (argToken && !process.env.SHAREDESK_TOKEN) {
      io.err("주의: 토큰을 명령 인자로 주면 셸 기록에 남습니다. 다음부터는 `login <주소>`만 치고 물어볼 때 붙여 넣으세요.");
    }
    if (!token) token = await io.secret("토큰: ");
    if (!token) throw new CliError("토큰이 비어 있습니다", { exitCode: 2 });
    const client = new DeskClient({ url, token });
    if (client.url.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(client.url)) {
      io.err("주의: http 주소라 토큰이 암호화되지 않은 채 전송됩니다.");
    }
    await client.list("");
    await saveConfig({ url: client.url, token });
    emit({ ok: true, url: client.url }, `연결됐습니다: ${client.url}`);
    return 0;
  }

  const config = await loadConfig();
  const client = new DeskClient(config);

  switch (command) {
    case "status": {
      const { entries } = await client.list("");
      emit({ ok: true, url: client.url, rootEntries: entries.length }, `연결 정상: ${client.url} (바탕화면 항목 ${entries.length}개)`);
      return 0;
    }
    case "ls": {
      const { entries } = await client.list(rest[0] ?? "");
      const sorted = [...entries].sort((a, b) =>
        a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1,
      );
      emit(
        sorted.map(({ id, name, isFolder, size, modifiedAt, mimeType }) => ({ id, name, isFolder, size, modifiedAt, mimeType })),
        sorted.length === 0
          ? "(비어 있음)"
          : sorted
              .map((entry) =>
                `${entry.isFolder ? "[폴더]" : "      "} ${entry.name}${entry.isFolder ? "" : `  ${formatSize(entry.size)}`}${entry.modifiedAt ? `  ${entry.modifiedAt}` : ""}`,
              )
              .join("\n"),
      );
      return 0;
    }
    case "get": {
      if (!rest[0]) throw new CliError("사용법: get <파일 경로> [저장 위치]", { exitCode: 2 });
      const result = await client.download(rest[0], rest[1]);
      emit({ ok: true, path: result.path, entry: result.entry }, `받았습니다: ${result.path} (${formatSize(result.entry.size)})`);
      return 0;
    }
    case "put": {
      if (!rest[0]) throw new CliError("사용법: put <로컬 파일> [폴더 경로] [--name 이름]", { exitCode: 2 });
      const entry = await client.upload(rest[0], rest[1] ?? "", {
        name: flags.name,
        onProgress: flags.json
          ? undefined
          : (sent, total) => {
              if (total > CHUNK_SIZE) io.err(`  ${formatSize(sent)} / ${formatSize(total)}`);
            },
      });
      emit({ ok: true, entry }, `올렸습니다: ${entry.name}${rest[1] ? ` → ${rest[1]}` : ""}`);
      return 0;
    }
    case "mkdir": {
      if (!rest[0]) throw new CliError("사용법: mkdir <폴더 경로>", { exitCode: 2 });
      const entry = await client.mkdir(rest[0]);
      emit({ ok: true, entry }, `만들었습니다: ${rest[0]}`);
      return 0;
    }
    default:
      throw new CliError(`모르는 명령입니다: ${command}\n\n${USAGE}`, { exitCode: 2 });
  }
}

// bin 심볼릭 링크(node_modules/.bin/sharedesk)로 불려도 실경로로 비교한다.
function samePath(candidate) {
  try {
    return realpathSync(candidate) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
const invokedDirectly = Boolean(process.argv[1]) && samePath(process.argv[1]);
if (invokedDirectly) {
  // process.exit 대신 exitCode — 파이프로 보낸 큰 --json 출력이 잘리지 않게.
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const json = parseArgs(process.argv.slice(2)).flags.json === true;
      const message = error instanceof CliError ? error.message : `오류: ${error?.message ?? error}`;
      if (json) console.log(JSON.stringify({ ok: false, error: message, status: error?.status ?? null }));
      else console.error(message);
      process.exitCode = error instanceof CliError ? error.exitCode : 1;
    },
  );
}
