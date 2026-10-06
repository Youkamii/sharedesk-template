#!/usr/bin/env node
// 데스크톱 위젯 껍데기 발행 — 빌드·서명·latest.json 병합·릴리스 업로드를 한 번에.
//
// 위젯은 공개 템플릿 저장소(Youkamii/sharedesk-template)의 고정 릴리스 `widget`
// (prerelease)에 산다. 웹의 업데이트 확인은 prerelease와 semver가 아닌 태그를 걸러
// 이 릴리스를 안정 버전으로 오인하지 않는다 (tests/update-flow.test.ts가 고정).
// 껍데기의 업데이터는 그 릴리스의 latest.json을 보고 새 버전을 안다.
//
//   node scripts/widget-release.mjs --dry-run     # 빌드·서명·latest.json 생성까지만
//   node scripts/widget-release.mjs               # 위 + 릴리스 업로드 (gh 로그인 필요)
//   node scripts/widget-release.mjs --skip-build  # 이미 빌드된 산출물로 진행
//
// 서명 비밀키: TAURI_SIGNING_PRIVATE_KEY(내용) 또는 TAURI_SIGNING_PRIVATE_KEY_PATH,
// 둘 다 없으면 ~/.tauri/sharedesk-widget.key. 비밀키는 저장소에 넣지 않는다.
// 이 스크립트는 실행한 플랫폼의 항목만 만든다 — 맥 항목은 맥에서 같은 명령을 돌린다.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WIDGET_RELEASE_REPOSITORY = "Youkamii/sharedesk-template";
export const WIDGET_RELEASE_TAG = "widget";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WIDGET_DIR = path.join(ROOT, "widget");
const TAURI_DIR = path.join(WIDGET_DIR, "src-tauri");
const OUT_DIR = path.join(WIDGET_DIR, "release-out");

export function readWidgetVersion(rootDir = ROOT) {
  const conf = JSON.parse(readFileSync(path.join(rootDir, "widget/src-tauri/tauri.conf.json"), "utf8"));
  const cargo = readFileSync(path.join(rootDir, "widget/src-tauri/Cargo.toml"), "utf8");
  const cargoVersion = /^version = "([^"]+)"$/m.exec(cargo)?.[1];
  const pkg = JSON.parse(readFileSync(path.join(rootDir, "widget/package.json"), "utf8"));
  if (conf.version !== cargoVersion || conf.version !== pkg.version) {
    throw new Error(
      `위젯 버전이 어긋납니다: tauri.conf.json ${conf.version}, Cargo.toml ${cargoVersion}, package.json ${pkg.version}`,
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(conf.version)) {
    throw new Error(`위젯 버전은 X.Y.Z 꼴이어야 합니다: ${conf.version}`);
  }
  return conf.version;
}

// Tauri 업데이터가 읽는 플랫폼 키와 번들 위치. 자산 이름은 공백 없이 고정한다
// (GitHub는 공백을 점으로 바꾼다).
export function platformTarget(platform = process.platform, arch = process.arch) {
  if (platform === "win32" && arch === "x64") {
    return {
      key: "windows-x86_64",
      bundleDir: "nsis",
      pattern: /-setup\.exe$/i,
      assetName: (version) => `sharedesk-widget-${version}-windows-x64-setup.exe`,
      latestAlias: "sharedesk-widget-windows-x64-setup.exe",
    };
  }
  // 맥: 업데이터 자산(.app.tar.gz + .sig)과 사람이 받는 설치 파일(.dmg)이 다르다. Windows는 setup.exe가
  // 둘 다라 installer가 없다. dmg에는 서명 파일이 없다(업데이터가 보지 않는다).
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    const suffix = arch === "arm64" ? "arm64" : "x64";
    return {
      key: arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64",
      bundleDir: "macos",
      pattern: /\.app\.tar\.gz$/i,
      assetName: (version) => `sharedesk-widget-${version}-macos-${suffix}.app.tar.gz`,
      latestAlias: `sharedesk-widget-macos-${suffix}.app.tar.gz`,
      installer: {
        bundleDir: "dmg",
        pattern: /\.dmg$/i,
        assetName: (version) => `sharedesk-widget-${version}-macos-${suffix}.dmg`,
        latestAlias: `sharedesk-widget-macos-${suffix}.dmg`,
      },
    };
  }
  throw new Error(`지원하지 않는 플랫폼입니다: ${platform}/${arch}`);
}

// 릴리스에 올리는 자산 이름, 올리는 순서대로: 업데이터 자산(불변 버전 이름 → 별칭) → 설치 파일(있으면,
// 같은 순서) → latest.json. 최신정보를 마지막에 올려야 앱이 아직 없는 자산을 가리키는 일이 없다.
export function releaseAssetNames(target, version) {
  const names = [target.assetName(version), target.latestAlias];
  if (target.installer) {
    names.push(target.installer.assetName(version), target.installer.latestAlias);
  }
  names.push("latest.json");
  return names;
}

export function assetUrl(assetName) {
  return `https://github.com/${WIDGET_RELEASE_REPOSITORY}/releases/download/${WIDGET_RELEASE_TAG}/${assetName}`;
}

// 기존 latest.json과 이번 플랫폼 항목을 합친다. 버전이 다른 옛 플랫폼 항목은 버린다 —
// 업데이터는 최상위 version 하나만 보므로 옛 자산이 섞이면 설치 뒤에도 계속 "새 버전"이 된다.
export function mergeLatest(previous, version, platformKey, entry, now = new Date()) {
  const platforms =
    previous && previous.version === version && previous.platforms && typeof previous.platforms === "object"
      ? { ...previous.platforms }
      : {};
  platforms[platformKey] = entry;
  return {
    version,
    notes: `ShareDesk Widget ${version}`,
    pub_date: now.toISOString(),
    platforms,
  };
}

function resolveTargetDir() {
  if (process.env.CARGO_TARGET_DIR) return process.env.CARGO_TARGET_DIR;
  return path.join(TAURI_DIR, "target");
}

// Tauri CLI의 번들러는 키 파일 경로가 아니라 내용(TAURI_SIGNING_PRIVATE_KEY)만 읽는다.
function signingEnv() {
  const env = { ...process.env };
  if (!env.TAURI_SIGNING_PRIVATE_KEY) {
    const keyPath = env.TAURI_SIGNING_PRIVATE_KEY_PATH || path.join(homedir(), ".tauri", "sharedesk-widget.key");
    if (!existsSync(keyPath)) {
      throw new Error(
        `서명 비밀키가 없습니다. TAURI_SIGNING_PRIVATE_KEY(내용)나 TAURI_SIGNING_PRIVATE_KEY_PATH를 주거나 ${keyPath}에 두세요.`,
      );
    }
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8").trim();
  }
  if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} 실패 (${result.status})`);
}

// gh.exe는 PATH에서 바로 찾히므로 셸을 끼우지 않는다 — 셸을 끼우면 Node가 인자를 따옴표 없이 이어 붙여
// "--title ShareDesk Widget"이 두 인자로 갈라진다. npm(.cmd)만 셸이 필요하다.
function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" });
}

function findBundle(target, version, { signed = true } = {}) {
  const dir = path.join(resolveTargetDir(), "release", "bundle", target.bundleDir);
  if (!existsSync(dir)) throw new Error(`번들 폴더가 없습니다: ${dir}`);
  const files = readdirSync(dir);
  // Windows 설치 파일 이름에는 버전이 들어가고(…_0.1.0_x64-setup.exe), macOS 업데이터 자산은 버전 없이
  // "ShareDesk Widget.app.tar.gz"다 — 버전이 든 이름이 있으면 그것을, 없으면 패턴만으로 고른다.
  const candidates = files.filter((name) => target.pattern.test(name));
  const artifact = candidates.find((name) => name.includes(version)) ?? candidates[0];
  if (!artifact) throw new Error(`${dir}에서 ${version} 번들을 찾지 못했습니다: ${files.join(", ")}`);
  if (!signed) return { artifactPath: path.join(dir, artifact), signaturePath: null };
  const signature = `${artifact}.sig`;
  if (!files.includes(signature)) {
    throw new Error(`서명 파일이 없습니다: ${signature} (createUpdaterArtifacts와 서명키를 확인하세요)`);
  }
  return { artifactPath: path.join(dir, artifact), signaturePath: path.join(dir, signature) };
}

// 번들을 release-out에 불변 버전 이름과 별칭으로 복사하고 두 경로를 돌려준다
function stage(artifactPath, target, version) {
  const versioned = path.join(OUT_DIR, target.assetName(version));
  const alias = path.join(OUT_DIR, target.latestAlias);
  copyFileSync(artifactPath, versioned);
  copyFileSync(artifactPath, alias);
  return [versioned, alias];
}

function downloadPreviousLatest() {
  try {
    const json = gh([
      "release", "view", WIDGET_RELEASE_TAG, "-R", WIDGET_RELEASE_REPOSITORY,
      "--json", "assets,isPrerelease",
    ]);
    const release = JSON.parse(json);
    if (!release.isPrerelease) {
      throw new Error(
        `${WIDGET_RELEASE_REPOSITORY}의 ${WIDGET_RELEASE_TAG} 릴리스는 반드시 prerelease여야 합니다 — 웹 업데이트 확인이 이 릴리스를 안정 버전으로 읽게 됩니다.`,
      );
    }
    const hasLatest = release.assets?.some((asset) => asset.name === "latest.json");
    if (!hasLatest) return { exists: true, previous: null };
    const tmp = path.join(OUT_DIR, "previous-latest.json");
    gh(["release", "download", WIDGET_RELEASE_TAG, "-R", WIDGET_RELEASE_REPOSITORY, "--pattern", "latest.json", "--output", tmp, "--clobber"]);
    return { exists: true, previous: JSON.parse(readFileSync(tmp, "utf8")) };
  } catch (error) {
    if (/release not found|Not Found|404/i.test(String(error.message ?? error))) {
      return { exists: false, previous: null };
    }
    throw error;
  }
}

async function main(argv) {
  const dryRun = argv.includes("--dry-run");
  const skipBuild = argv.includes("--skip-build");
  const version = readWidgetVersion();
  const target = platformTarget();
  mkdirSync(OUT_DIR, { recursive: true });

  if (!skipBuild) {
    console.log(`[widget-release] ${version} 빌드·서명 (${target.key})`);
    run("npm", ["run", "build"], { cwd: WIDGET_DIR, env: signingEnv() });
  }
  const { artifactPath, signaturePath } = findBundle(target, version);
  const assetName = target.assetName(version);
  const staged = stage(artifactPath, target, version);
  // 맥: 사람이 받는 dmg는 업데이터 자산 뒤에, latest.json 앞에 올린다 (releaseAssetNames와 같은 순서)
  if (target.installer) {
    const { artifactPath: installerPath } = findBundle(target.installer, version, { signed: false });
    staged.push(...stage(installerPath, target.installer, version));
  }

  const entry = { signature: readFileSync(signaturePath, "utf8").trim(), url: assetUrl(assetName) };
  let previous = null;
  let releaseExists = false;
  if (!dryRun) {
    ({ exists: releaseExists, previous } = downloadPreviousLatest());
  }
  const latest = mergeLatest(previous, version, target.key, entry);
  const latestPath = path.join(OUT_DIR, "latest.json");
  writeFileSync(latestPath, `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`[widget-release] latest.json → ${latestPath}`);
  console.log(JSON.stringify({ ...latest, platforms: Object.fromEntries(Object.entries(latest.platforms).map(([k, v]) => [k, { url: v.url, signature: `${v.signature.slice(0, 16)}…` }])) }, null, 2));

  if (dryRun) {
    console.log(`[widget-release] dry-run: 업로드 생략. 올릴 파일: ${releaseAssetNames(target, version).join(", ")}`);
    return;
  }
  if (!releaseExists) {
    gh([
      "release", "create", WIDGET_RELEASE_TAG, "-R", WIDGET_RELEASE_REPOSITORY,
      "--prerelease", "--title", "ShareDesk Widget",
      "--notes", "ShareDesk 데스크톱 위젯 내려받기. 앱은 이 릴리스의 latest.json을 보고 스스로 갱신합니다.",
    ]);
  }
  // 불변 자산(버전 이름) → 사람용 별칭 → (맥) 설치 파일 둘 → latest.json 순서(releaseAssetNames).
  // 최신정보를 마지막에 올려야 앱이 아직 없는 자산을 가리키는 일이 없다.
  for (const file of [...staged, latestPath]) {
    gh(["release", "upload", WIDGET_RELEASE_TAG, "-R", WIDGET_RELEASE_REPOSITORY, file, "--clobber"]);
  }
  console.log(`[widget-release] 발행 완료: ${assetUrl(assetName)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[widget-release] ${error.message ?? error}`);
    process.exit(1);
  });
}
