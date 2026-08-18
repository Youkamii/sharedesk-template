#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const SOURCE_REPOSITORY = "Youkamii/sharedesk-template";
const MANIFEST_FILE = "sharedesk-release.json";
const UPDATER_PATH = "scripts/sharedesk-update.mjs";
const CORE_PATHS = [
  "scripts/sharedesk-bootstrap.mjs",
  UPDATER_PATH,
  ".github/workflows/sharedesk-update.yml",
];
// 매니페스트 계약(bootstrapFiles)에 없는 추가 core 파일. 구버전 업데이터의
// 매니페스트 검증을 깨지 않으면서 새 설치에만 넣는다 — 받기에 실패해도
// 부트스트랩 전체는 계속된다(예전 릴리스에는 이 파일이 없다).
const OPTIONAL_BOOTSTRAP_PATHS = [
  ".github/workflows/sharedesk-auto-update.yml",
];
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const STABLE_SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * @typedef {{
 *   rootDir: string,
 *   manifest: unknown,
 *   fetchFile: (relativePath: string) => Promise<unknown>,
 *   assertClean?: (rootDir: string) => Promise<void>,
 *   applyBootstrap?: (options: {
 *     rootDir: string,
 *     manifest: any,
 *     fetchFile: (relativePath: string) => Promise<unknown>,
 *   }) => Promise<any>,
 * }} BootstrapOptions
 */

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function compareStableSemver(left, right) {
  const leftMatch = STABLE_SEMVER_PATTERN.exec(left);
  const rightMatch = STABLE_SEMVER_PATTERN.exec(right);
  if (!leftMatch || !rightMatch) throw new Error("Invalid stable release version.");
  for (let index = 1; index <= 3; index += 1) {
    const leftPart = BigInt(leftMatch[index]);
    const rightPart = BigInt(rightMatch[index]);
    if (leftPart < rightPart) return -1;
    if (leftPart > rightPart) return 1;
  }
  return 0;
}

export function selectStableRelease(releases) {
  if (!Array.isArray(releases)) return null;
  let latest = null;
  for (const release of releases) {
    if (
      release?.draft === true ||
      release?.prerelease === true ||
      typeof release?.tag_name !== "string" ||
      !STABLE_SEMVER_PATTERN.test(release.tag_name)
    ) {
      continue;
    }
    if (!latest || compareStableSemver(release.tag_name, latest.tag_name) > 0) {
      latest = release;
    }
  }
  return latest;
}

function validateBootstrapManifest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    typeof value.version !== "string" ||
    !STABLE_SEMVER_PATTERN.test(value.version) ||
    !Array.isArray(value.files) ||
    !Array.isArray(value.bootstrapFiles)
  ) {
    throw new Error("Release manifest is not valid for bootstrapping.");
  }
  if (
    value.bootstrapFiles.length !== CORE_PATHS.length ||
    CORE_PATHS.some(
      (corePath) =>
        !value.bootstrapFiles.some(
          (entry) =>
            entry?.path === corePath &&
            typeof entry.sha256 === "string" &&
            HASH_PATTERN.test(entry.sha256) &&
            Array.isArray(entry.acceptedSha256 ?? []) &&
            (entry.acceptedSha256 ?? []).every(
              (hash) => typeof hash === "string" && HASH_PATTERN.test(hash),
            ),
        ),
    )
  ) {
    throw new Error("Release manifest does not contain the complete bootstrap core.");
  }
  return value;
}

export async function assertCleanGitRepository(rootDir) {
  const absoluteRoot = path.resolve(rootDir);
  let repositoryRoot;
  try {
    const result = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: absoluteRoot, encoding: "utf8", windowsHide: true },
    );
    repositoryRoot = result.stdout.trim();
  } catch {
    throw new Error("Run the bootstrap command inside a Git repository.");
  }

  const [actualRoot, requestedRoot] = await Promise.all([
    realpath(repositoryRoot),
    realpath(absoluteRoot),
  ]);
  if (path.normalize(actualRoot).toLowerCase() !== path.normalize(requestedRoot).toLowerCase()) {
    throw new Error("Run the bootstrap command at the repository root.");
  }

  const status = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: absoluteRoot, encoding: "utf8", windowsHide: true },
  );
  if (status.stdout.trim()) {
    throw new Error(
      "The repository has local changes. Commit or stash them before bootstrapping ShareDesk.",
    );
  }
}

async function verifiedUpdaterModule(manifest, fetchFile) {
  const updaterEntry = manifest.bootstrapFiles.find(
    (entry) => entry.path === UPDATER_PATH,
  );
  const updaterBytes = await fetchFile(UPDATER_PATH);
  const bytes =
    updaterBytes instanceof Uint8Array
      ? updaterBytes
      : new Uint8Array(updaterBytes);
  const updaterHash = sha256(bytes);
  if (
    updaterHash !== updaterEntry.sha256 &&
    !(updaterEntry.acceptedSha256 ?? []).includes(updaterHash)
  ) {
    throw new Error("Bootstrap updater hash verification failed.");
  }

  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "sharedesk-bootstrap-"),
  );
  const temporaryUpdater = path.join(temporaryDirectory, "sharedesk-update.mjs");
  try {
    await writeFile(temporaryUpdater, bytes);
    return {
      module: await import(
        `${pathToFileURL(temporaryUpdater).href}?v=${Date.now()}`
      ),
      dispose: () => rm(temporaryDirectory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

/** @param {BootstrapOptions} options */
export async function bootstrapRelease({
  rootDir,
  manifest,
  fetchFile,
  assertClean = assertCleanGitRepository,
  applyBootstrap = undefined,
}) {
  const absoluteRoot = path.resolve(rootDir);
  await assertClean(absoluteRoot);
  const validatedManifest = validateBootstrapManifest(manifest);
  let updater = null;
  try {
    const apply =
      applyBootstrap ??
      (updater = await verifiedUpdaterModule(validatedManifest, fetchFile))
        .module.applyBootstrapRelease;
    if (typeof apply !== "function") {
      throw new Error("Release updater does not support bootstrapping.");
    }
    const result = await apply({
      rootDir: absoluteRoot,
      manifest: validatedManifest,
      fetchFile,
    });
    await installOptionalBootstrapFiles(absoluteRoot, fetchFile);
    return result;
  } finally {
    await updater?.dispose();
  }
}

async function installOptionalBootstrapFiles(rootDir, fetchFile) {
  for (const optionalPath of OPTIONAL_BOOTSTRAP_PATHS) {
    const target = path.join(rootDir, optionalPath);
    try {
      // 이미 있으면 덮어쓰지 않는다 — 워크플로는 업데이트로 바뀌지 않는 영역이다.
      await access(target);
      continue;
    } catch {
      // 없음 — 새로 설치한다.
    }
    try {
      const bytes = await fetchFile(optionalPath);
      const content =
        bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      console.log(`선택 구성 요소를 설치했습니다: ${optionalPath}`);
    } catch {
      console.log(
        `선택 구성 요소를 건너뜁니다(이 릴리스에는 없습니다): ${optionalPath}`,
      );
    }
  }
}

function nextPageUrl(linkHeader) {
  if (!linkHeader) return null;
  for (const link of linkHeader.split(",")) {
    const match = /^\s*<([^>]+)>/.exec(link);
    if (match && /;\s*rel="next"(?:\s*;|\s*$)/.test(link)) return match[1];
  }
  return null;
}

export async function fetchGitHubReleasePages(initialUrl, fetchImpl = fetch) {
  const releases = [];
  const visited = new Set();
  let url = initialUrl;
  while (url) {
    if (visited.has(url)) throw new Error("GitHub release pagination loop detected.");
    visited.add(url);
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub request failed (${response.status}): ${url}`);
    }
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error("GitHub releases response is invalid.");
    releases.push(...page);
    url = nextPageUrl(response.headers.get("link"));
  }
  return releases;
}

async function loadLatestRelease() {
  const releases = await fetchGitHubReleasePages(
    `https://api.github.com/repos/${SOURCE_REPOSITORY}/releases?per_page=100`,
  );
  const release = selectStableRelease(releases);
  if (!release) throw new Error("No stable ShareDesk release is available.");
  const manifestAsset = Array.isArray(release.assets)
    ? release.assets.find((asset) => asset?.name === MANIFEST_FILE)
    : null;
  const manifestUrl =
    typeof manifestAsset?.browser_download_url === "string"
      ? manifestAsset.browser_download_url
      : rawFileUrl(release.tag_name, MANIFEST_FILE);
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`Release manifest request failed (${response.status}).`);
  }
  const manifest = validateBootstrapManifest(await response.json());
  if (manifest.version !== release.tag_name.replace(/^v/, "")) {
    throw new Error("Release tag and manifest version do not match.");
  }
  return { tagName: release.tag_name, manifest };
}

function rawFileUrl(tagName, relativePath) {
  const encodedPath = relativePath.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${SOURCE_REPOSITORY}/${encodeURIComponent(
    tagName,
  )}/${encodedPath}`;
}

async function runCli() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--apply") {
    throw new Error("Usage: node sharedesk-bootstrap.mjs --apply");
  }
  const rootDir = process.cwd();
  await assertCleanGitRepository(rootDir);
  const { tagName, manifest } = await loadLatestRelease();
  const result = await bootstrapRelease({
    rootDir,
    manifest,
    assertClean: async () => undefined,
    fetchFile: async (relativePath) => {
      const response = await fetch(rawFileUrl(tagName, relativePath));
      if (!response.ok) {
        throw new Error(`Release file request failed (${response.status}): ${relativePath}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
