import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// CLI(#34)는 의존성 없는 ESM 한 파일이다 — 여기서 그대로 불러 가짜 데스크
// 서버에 붙여 본다. 직행(resumable) 업로드는 실제 Drive 없이 308/200 흐름을
// 흉내 낸 서버로 검증한다.
const cliUrl = new URL("../cli/sharedesk.mjs", import.meta.url);
type Cli = typeof import("../cli/sharedesk.mjs");

const asEnv = (value: Record<string, string>) => value as NodeJS.ProcessEnv;

async function loadCli(): Promise<Cli> {
  return (await import(cliUrl.href)) as Cli;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

type FakeDesk = {
  url: string;
  close: () => Promise<void>;
  log: string[];
  putRanges: string[];
};

// 가짜 데스크: path·list·upload-session·upload·upload-complete·download·mkdir과
// Drive resumable 세션(/resumable)을 한 서버에 둔다.
async function startFakeDesk(options: {
  mode: "direct" | "proxy";
  token: string;
  failFirstChunk?: boolean;
}): Promise<FakeDesk> {
  const log: string[] = [];
  const putRanges: string[] = [];
  let received = 0;
  let firstChunkFailed = false;
  let base = "";
  const entries = [
    { id: "f1", layoutKey: "k1", name: "보고서.txt", isFolder: false, size: 5, modifiedAt: null, mimeType: "text/plain", version: null },
    { id: "d1", layoutKey: "k2", name: "자료", isFolder: true, size: null, modifiedAt: null, mimeType: null, version: null },
  ];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    log.push(`${req.method} ${url.pathname}`);
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    if (url.pathname.startsWith("/api/") && req.headers.cookie !== `sharedesk_session=${options.token}`) {
      return send(401, { error: "인증이 필요합니다" });
    }
    if (url.pathname === "/api/drive/path") {
      const p = url.searchParams.get("path") ?? "/";
      if (p === "/" || p === "") return send(200, { folderId: "root", crumbs: [] });
      if (p === "/자료") return send(200, { folderId: "d1", crumbs: [] });
      return send(404, { error: `${p.slice(1)} 폴더가 없습니다`, code: "NOT_FOUND" });
    }
    if (url.pathname === "/api/drive/list") {
      return send(200, { entries: url.searchParams.get("folderId") === "root" ? entries : [] });
    }
    if (url.pathname === "/api/drive/download") {
      res.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": "attachment" });
      return res.end("hello");
    }
    if (url.pathname === "/api/drive/mkdir") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      return send(201, { entry: { id: "new", name: body.name, isFolder: true, parentId: body.parentId } });
    }
    if (url.pathname === "/api/drive/upload-session") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      log.push(`session ${body.name} ${body.parentId} ${body.size} ${body.mimeType}`);
      return options.mode === "direct"
        ? send(200, { mode: "direct", url: `${base}/resumable`, reservationId: "r1" })
        : send(200, { mode: "proxy", reservationId: "r1" });
    }
    if (url.pathname === "/api/drive/upload") {
      const body = await readBody(req);
      log.push(`upload ${url.searchParams.get("name")} ${url.searchParams.get("parentId")} ${url.searchParams.get("reservationId")} ${req.headers["content-length"]} ${req.headers["content-type"]}`);
      return send(201, { entry: { id: "p1", name: url.searchParams.get("name"), isFolder: false, size: body.byteLength } });
    }
    if (url.pathname === "/api/drive/upload-complete") {
      const body = JSON.parse((await readBody(req)).toString("utf8"));
      log.push(`complete ${body.reservationId} ${body.fileId}`);
      return send(200, { ok: true });
    }
    if (url.pathname === "/resumable") {
      const range = String(req.headers["content-range"] ?? "");
      putRanges.push(range);
      const body = await readBody(req);
      const total = Number(/\/(\d+)$/.exec(range)?.[1] ?? 0);
      if (range.startsWith("bytes */")) {
        // 위치 조회.
        if (received >= total) return send(200, { id: "drive-file-1" });
        res.writeHead(308, { Range: received > 0 ? `bytes=0-${received - 1}` : "" });
        return res.end();
      }
      if (options.failFirstChunk && !firstChunkFailed) {
        firstChunkFailed = true;
        return send(503, { error: "일시 오류" });
      }
      received += body.byteLength;
      if (received >= total) return send(200, { id: "drive-file-1" });
      res.writeHead(308, { Range: `bytes=0-${received - 1}` });
      return res.end();
    }
    send(404, { error: "없음" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  base = `http://127.0.0.1:${address.port}`;
  return {
    url: base,
    log,
    putRanges,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("CLI: 경로 나누기·주소 정규화·Range 해석", async () => {
  const cli = await loadCli();
  assert.deepEqual(cli.splitDeskPath("자료/2026/요약.pdf"), { folder: "자료/2026", name: "요약.pdf" });
  assert.deepEqual(cli.splitDeskPath("자료/"), { folder: "자료", name: "" });
  assert.deepEqual(cli.splitDeskPath("요약.pdf"), { folder: "", name: "요약.pdf" });
  assert.deepEqual(cli.splitDeskPath("a\\b\\c.txt"), { folder: "a/b", name: "c.txt" });
  assert.equal(cli.normalizeBaseUrl("https://desk.example.com/"), "https://desk.example.com");
  assert.equal(cli.normalizeBaseUrl("http://localhost:3000"), "http://localhost:3000");
  assert.throws(() => cli.normalizeBaseUrl("desk.example.com"), /올바르지 않습니다/);
  assert.throws(() => cli.normalizeBaseUrl("ftp://x"), /http/);
  assert.equal(cli.resumableOffsetFromRange("bytes=0-1048575"), 1048576);
  assert.equal(cli.resumableOffsetFromRange(null), 0);
  assert.equal(cli.mimeTypeFor("a.PNG"), "image/png");
  assert.equal(cli.mimeTypeFor("a.unknown"), "application/octet-stream");
  assert.deepEqual(cli.parseArgs(["put", "x.txt", "자료", "--name", "y.txt", "--json"]), {
    positional: ["put", "x.txt", "자료"],
    flags: { name: "y.txt", json: true },
  });
});

test("CLI: 설정 파일은 환경변수가 우선하고 없으면 login을 안내한다", async () => {
  const cli = await loadCli();
  const dir = await mkdtemp(path.join(tmpdir(), "sharedesk-cli-"));
  const configFile = path.join(dir, "config.json");
  await assert.rejects(cli.loadConfig({ env: asEnv({}), configFile }), (error: { exitCode: number; message: string }) => {
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /login/);
    return true;
  });
  await cli.saveConfig({ url: "https://desk.example.com/", token: "t1" }, { configFile });
  const saved = JSON.parse(await readFile(configFile, "utf8"));
  assert.equal(saved.token, "t1");
  assert.deepEqual(await cli.loadConfig({ env: asEnv({}), configFile }), { url: "https://desk.example.com", token: "t1" });
  assert.deepEqual(
    await cli.loadConfig({ env: asEnv({ SHAREDESK_URL: "http://localhost:3000/", SHAREDESK_TOKEN: "t2" }), configFile }),
    { url: "http://localhost:3000", token: "t2" },
  );
});

test("CLI: 토큰은 세션 쿠키로 가고, 목록·받기·폴더 만들기가 데스크 API를 그대로 쓴다", async () => {
  const cli = await loadCli();
  const desk = await startFakeDesk({ mode: "proxy", token: "tok" });
  try {
    const client = new cli.DeskClient({ url: desk.url, token: "tok" });
    const { entries } = await client.list("");
    assert.deepEqual(entries.map((entry: { name: string }) => entry.name), ["보고서.txt", "자료"]);
    const dir = await mkdtemp(path.join(tmpdir(), "sharedesk-cli-"));
    const got = await client.download("보고서.txt", dir);
    assert.equal(got.path, path.join(dir, "보고서.txt"));
    assert.equal(await readFile(got.path, "utf8"), "hello");
    const made = await client.mkdir("자료/새 폴더");
    assert.equal(made.name, "새 폴더");
    assert.equal(made.parentId, "d1");
    await assert.rejects(client.download("없음/x.txt"), /폴더가 없습니다/);
    await assert.rejects(client.download("자료"), /폴더는 받을 수 없습니다/);
    const wrong = new cli.DeskClient({ url: desk.url, token: "bad" });
    await assert.rejects(wrong.list(""), (error: { exitCode: number; status: number }) => {
      assert.equal(error.status, 401);
      assert.equal(error.exitCode, 3);
      return true;
    });
  } finally {
    await desk.close();
  }
});

test("CLI: 프록시 모드 업로드는 예약 id·크기·형식을 실어 서버로 보낸다", async () => {
  const cli = await loadCli();
  const desk = await startFakeDesk({ mode: "proxy", token: "tok" });
  try {
    const dir = await mkdtemp(path.join(tmpdir(), "sharedesk-cli-"));
    const local = path.join(dir, "메모.md");
    const content = "# 제목\n";
    const bytes = Buffer.byteLength(content);
    await writeFile(local, content);
    const client = new cli.DeskClient({ url: desk.url, token: "tok" });
    const entry = await client.upload(local, "자료", { name: "이름바꿈.md" });
    assert.equal(entry.name, "이름바꿈.md");
    assert.ok(desk.log.includes(`session 이름바꿈.md d1 ${bytes} text/markdown`), desk.log.join("\n"));
    assert.ok(desk.log.includes(`upload 이름바꿈.md d1 r1 ${bytes} text/markdown`), desk.log.join("\n"));
  } finally {
    await desk.close();
  }
});

test("CLI: 직행 모드 업로드는 조각을 PUT하고 308을 이어 가며 완료를 보고한다", async () => {
  const cli = await loadCli();
  const desk = await startFakeDesk({ mode: "direct", token: "tok", failFirstChunk: true });
  try {
    const dir = await mkdtemp(path.join(tmpdir(), "sharedesk-cli-"));
    const local = path.join(dir, "big.bin");
    // 조각 크기의 2.5배 — 세 번 PUT, 마지막은 짧다.
    const size = Math.floor(cli.CHUNK_SIZE * 2.5);
    await writeFile(local, Buffer.alloc(size, 7));
    const client = new cli.DeskClient({ url: desk.url, token: "tok" });
    const progress: number[] = [];
    const entry = await client.upload(local, "", { onProgress: (sent: number) => progress.push(sent) });
    assert.equal(entry.id, "drive-file-1");
    assert.equal(entry.size, size);
    // 첫 조각은 503 → 위치 조회(bytes */total) → 처음부터 다시 — 그 뒤 세 조각.
    assert.deepEqual(desk.putRanges, [
      `bytes 0-${cli.CHUNK_SIZE - 1}/${size}`,
      `bytes */${size}`,
      `bytes 0-${cli.CHUNK_SIZE - 1}/${size}`,
      `bytes ${cli.CHUNK_SIZE}-${cli.CHUNK_SIZE * 2 - 1}/${size}`,
      `bytes ${cli.CHUNK_SIZE * 2}-${size - 1}/${size}`,
    ]);
    assert.ok(desk.log.includes("complete r1 drive-file-1"), desk.log.join("\n"));
    assert.ok(!desk.log.some((line) => line.startsWith("POST /api/drive/upload?")), "직행 모드는 서버로 본문을 보내지 않는다");
    assert.equal(progress.at(-1), size);
  } finally {
    await desk.close();
  }
});

test("CLI 토큰 발급과 화면 배선 (#34)", async () => {
  const [route, users, dialog, filesView, pkg] = await Promise.all([
    readFile(new URL("../src/app/api/me/cli-token/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/users.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/CliTokenDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/app/files/FilesView.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  // 손님 차단, 기본 데스크 명단에 세션 추가, 토큰은 기존 서명기로.
  assert.match(route, /session\.isGuest/);
  assert.match(route, /runWithSpace\(null, \(\) =>\s*issueUserSession/);
  assert.match(route, /createUserSession\(/);
  assert.match(route, /"Cache-Control": "no-store"/);
  // 명단 함수는 승인된 멤버만, 기기 세션 상한(normalizeSessions)을 그대로 탄다.
  assert.match(users, /export async function issueUserSession/);
  assert.match(users, /user\.status !== "approved"\) return null/);
  // 창: 토큰 입력은 읽기 전용, 사이드바 항목은 손님에게 없다.
  assert.match(dialog, /\/api\/me\/cli-token/);
  assert.match(dialog, /readOnly/);
  assert.match(filesView, /\{!isGuest && cliTokenOpen && \(/);
  // 실행 진입점.
  assert.equal(JSON.parse(pkg).bin.sharedesk, "cli/sharedesk.mjs");
  assert.equal(path.basename(fileURLToPath(cliUrl)), "sharedesk.mjs");
});
