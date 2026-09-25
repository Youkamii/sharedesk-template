#!/usr/bin/env node
/**
 * ShareDesk 소개 영상 렌더러
 *
 *   storyboard.html 을 1920x1080 헤드리스 크로미엄으로 열고
 *   t = 0, 1/fps, 2/fps ... 를 window.seek(t) 에 넣어 한 장씩 스크린샷을 찍은 뒤
 *   ffmpeg 로 H.264(yuv420p) 무음 MP4 를 만든다.
 *
 * 쓰는 법 (저장소 어디서나)
 *   node docs/intro-video/render.mjs                                  # 최종본
 *   node docs/intro-video/render.mjs --scale 0.5 --fps 10 --out a.mp4 # 빠른 초안
 *
 * 옵션
 *   --out <path>        결과 mp4 경로 (기본 docs/sharedesk-intro.mp4)
 *   --fps <n>           초당 프레임 수 (기본 30)
 *   --scale <f>         화면 배율 (기본 1, 0.5 면 960x540 초안)
 *   --crf <n>           H.264 품질 (기본 18, 숫자가 클수록 용량이 준다)
 *   --tool-dir <path>   playwright 가 설치된 폴더 (저장소 밖)
 *   --frames-dir <path> PNG 시퀀스를 둘 임시 폴더 (기본 OS 임시 폴더)
 *   --keep-frames       끝난 뒤 PNG 를 지우지 않는다
 *
 * 준비물
 *   - ffmpeg / ffprobe 가 PATH 에 있어야 한다.
 *   - playwright 는 저장소 밖에 따로 설치한다. 저장소 package.json 은 건드리지 않는다.
 *       cd <tool-dir> && npm init -y && npm i playwright && npx playwright install chromium
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

// 저장소 밖에 설치한 playwright 의 기본 위치. --tool-dir 로 바꿀 수 있다.
const DEFAULT_TOOL_DIR = path.resolve(
  "C:/Users/gkfkd/AppData/Local/Temp/claude/C--Users-gkfkd-Git-sharedesk-template/986a4874-9cb1-417a-a556-8d13a130917e/scratchpad/video-tool",
);

/* ------------------------------------------------------------------ */
/* 옵션 읽기                                                            */
/* ------------------------------------------------------------------ */
function parseArgs(argv) {
  const opt = {
    out: path.join(REPO_ROOT, "docs", "sharedesk-intro.mp4"),
    fps: 30,
    scale: 1,
    crf: 18,
    toolDir: DEFAULT_TOOL_DIR,
    framesDir: null,
    keepFrames: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} 에 값이 필요합니다`);
      i += 1;
      return v;
    };
    if (a === "--out") opt.out = path.resolve(next());
    else if (a === "--fps") opt.fps = Number(next());
    else if (a === "--scale") opt.scale = Number(next());
    else if (a === "--crf") opt.crf = Number(next());
    else if (a === "--tool-dir") opt.toolDir = path.resolve(next());
    else if (a === "--frames-dir") opt.framesDir = path.resolve(next());
    else if (a === "--keep-frames") opt.keepFrames = true;
    else if (a === "-h" || a === "--help") {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
      process.exit(0);
    } else throw new Error(`모르는 옵션: ${a}`);
  }
  if (!(opt.fps > 0)) throw new Error("--fps 는 0보다 커야 합니다");
  if (!(opt.scale > 0)) throw new Error("--scale 은 0보다 커야 합니다");
  return opt;
}

/* ------------------------------------------------------------------ */
/* 저장소 루트를 그대로 내려 주는 작은 정적 서버                          */
/*   file:// 로 열면 크로미엄이 글꼴(woff2)을 막는 경우가 있어             */
/*   127.0.0.1 로 잠깐 띄운다. 새 창은 뜨지 않는다.                       */
/* ------------------------------------------------------------------ */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

function startServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let rel;
      try {
        rel = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
      } catch {
        res.writeHead(400).end("bad url");
        return;
      }
      const target = path.join(root, rel);
      // 루트 밖으로 나가는 경로는 막는다.
      if (target !== root && !target.startsWith(root + path.sep)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      fs.readFile(target, (err, buf) => {
        if (err) {
          res.writeHead(404).end("not found");
          return;
        }
        res.writeHead(200, {
          "content-type": MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        res.end(buf);
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/* ------------------------------------------------------------------ */
/* 바깥 도구 불러오기                                                    */
/* ------------------------------------------------------------------ */
async function loadPlaywright(toolDir) {
  const entry = path.join(toolDir, "node_modules", "playwright", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(
      `playwright 를 찾지 못했습니다: ${entry}\n` +
        `먼저 설치하세요:  cd "${toolDir}" && npm init -y && npm i playwright && npx playwright install chromium`,
    );
  }
  const require = createRequire(pathToFileURL(path.join(toolDir, "package.json")));
  return require(entry);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", shell: false, ...opts });
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} 가 코드 ${code} 로 끝났습니다`)),
    );
  });
}

function runCapture(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err || `exit ${code}`))));
  });
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, "0")}초`;
}

/* ------------------------------------------------------------------ */
/* 본체                                                                 */
/* ------------------------------------------------------------------ */
async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const started = Date.now();

  const { chromium } = await loadPlaywright(opt.toolDir);
  const server = await startServer(REPO_ROOT);
  const port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/docs/intro-video/storyboard.html?render=1`;

  const framesDir =
    opt.framesDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), "sharedesk-intro-")));
  await fsp.mkdir(framesDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--force-color-profile=srgb", "--disable-lcd-text", "--hide-scrollbars"],
  });

  let frameCount = 0;
  try {
    const page = await browser.newPage({
      viewport: { width: 1920, height: 1080 },
      deviceScaleFactor: opt.scale,
      reducedMotion: "no-preference",
    });
    page.on("pageerror", (e) => console.error("  [페이지 오류]", e.message));
    page.on("console", (m) => {
      if (m.type() === "error") console.error("  [콘솔]", m.text());
    });

    await page.goto(pageUrl, { waitUntil: "load" });
    await page.evaluate(() => window.__ready);
    await page.evaluate(() => window.prepareRender());

    const duration = await page.evaluate(() => window.DURATION);
    frameCount = Math.round(duration * opt.fps);
    const outW = Math.round(1920 * opt.scale);
    const outH = Math.round(1080 * opt.scale);

    console.log(`스토리보드   ${pageUrl}`);
    console.log(`영상 길이    ${duration}초 · ${opt.fps}fps · ${outW}x${outH}`);
    console.log(`프레임 수    ${frameCount}장`);
    console.log(`임시 폴더    ${framesDir}`);
    console.log("");

    const logEvery = Math.max(1, Math.round(frameCount / 40));
    for (let i = 0; i < frameCount; i += 1) {
      const t = i / opt.fps;
      await page.evaluate((tt) => window.seek(tt), t);
      await page.screenshot({
        path: path.join(framesDir, `${String(i).padStart(6, "0")}.png`),
        type: "png",
        animations: "disabled",
      });
      if (i % logEvery === 0 || i === frameCount - 1) {
        const pct = (((i + 1) / frameCount) * 100).toFixed(1);
        const elapsed = Date.now() - started;
        const eta = i > 0 ? (elapsed / (i + 1)) * (frameCount - i - 1) : 0;
        console.log(
          `  프레임 ${String(i + 1).padStart(5)}/${frameCount}  ${pct.padStart(5)}%  t=${t.toFixed(2)}s  남은 시간 ${fmtDuration(eta)}`,
        );
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  console.log("\nffmpeg 로 인코딩합니다…");
  await fsp.mkdir(path.dirname(opt.out), { recursive: true });
  await run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel", "warning",
    "-stats",
    "-framerate", String(opt.fps),
    "-i", path.join(framesDir, "%06d.png"),
    "-an",
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", String(opt.crf),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    opt.out,
  ]);

  if (!opt.keepFrames) {
    await fsp.rm(framesDir, { recursive: true, force: true });
  }

  const stat = await fsp.stat(opt.out);
  let probe = "";
  try {
    probe = await runCapture("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height,r_frame_rate,nb_frames,pix_fmt",
      "-show_entries", "format=duration,size",
      "-of", "default=noprint_wrappers=1",
      opt.out,
    ]);
  } catch (e) {
    probe = `(ffprobe 실패: ${e.message})`;
  }

  console.log("\n완료");
  console.log(`  파일     ${opt.out}`);
  console.log(`  크기     ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  프레임   ${frameCount}장`);
  console.log(`  걸린 시간 ${fmtDuration(Date.now() - started)}`);
  console.log("\nffprobe");
  console.log(
    probe
      .trim()
      .split(/\r?\n/)
      .map((l) => "  " + l)
      .join("\n"),
  );
}

main().catch((e) => {
  console.error("\n실패:", e.message);
  process.exit(1);
});
