#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

export const MANIFEST_FILE = "sharedesk-release.json";
export const UPDATE_SOURCE_REPOSITORY = "Youkamii/sharedesk-template";
export const UPDATE_WORKFLOW_PATH = ".github/workflows/sharedesk-update.yml";
export const AUTO_UPDATE_WORKFLOW_PATH =
  ".github/workflows/sharedesk-auto-update.yml";
// 매니페스트의 bootstrapFiles 계약이다. 배포된 구버전 업데이터가 이 목록과
// 길이가 다른 매니페스트를 거부하므로, 여기 새 항목을 더하면 기존 설치의
// 업데이트가 전부 깨진다 — 새 core 파일은 부트스트랩의 선택 설치 경로
// (OPTIONAL_BOOTSTRAP_PATHS)로만 더한다.
export const BOOTSTRAP_CORE_PATHS = [
  "scripts/sharedesk-bootstrap.mjs",
  "scripts/sharedesk-update.mjs",
  UPDATE_WORKFLOW_PATH,
];
export const AUTOMATIC_CORE_PATHS = BOOTSTRAP_CORE_PATHS.filter(
  (corePath) => corePath !== UPDATE_WORKFLOW_PATH,
);

const SEMVER_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const execFileAsync = promisify(execFile);

function normalizeVersion(value) {
  const match = typeof value === "string" ? SEMVER_PATTERN.exec(value) : null;
  if (!match || match[4]) return null;
  return value.replace(/^v/, "");
}

function parsedVersion(value) {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

export function compareSemver(left, right) {
  const parsedLeft = parsedVersion(left);
  const parsedRight = parsedVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (parsedLeft[index] < parsedRight[index]) return -1;
    if (parsedLeft[index] > parsedRight[index]) return 1;
  }
  return 0;
}

export function assertNotDowngrade(currentVersion, nextVersion) {
  if (compareSemver(nextVersion, currentVersion) < 0) {
    throw new Error(
      `Refusing to downgrade ShareDesk from ${currentVersion} to ${nextVersion}.`,
    );
  }
}

export function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isUtf8Text(content) {
  if (content.includes(0)) return false;
  const decoded = content.toString("utf8");
  return Buffer.from(decoded, "utf8").equals(content);
}

function releaseFileEntry(relativePath, content, normalizeWorkingTree = false) {
  let canonical = content;
  const accepted = new Set();
  if (isUtf8Text(content)) {
    const text = content.toString("utf8");
    if (normalizeWorkingTree) {
      canonical = Buffer.from(text.replace(/\r\n/g, "\n"), "utf8");
    }
    const canonicalText = canonical.toString("utf8");
    accepted.add(
      sha256(Buffer.from(canonicalText.replace(/(?<!\r)\n/g, "\r\n"), "utf8")),
    );
    accepted.add(sha256(content));
  }
  const canonicalHash = sha256(canonical);
  accepted.delete(canonicalHash);
  return {
    path: relativePath,
    sha256: canonicalHash,
    ...(accepted.size > 0 ? { acceptedSha256: [...accepted].sort() } : {}),
  };
}

export function isProtectedPath(filePath) {
  const normalized = filePath.toLowerCase();
  const parts = normalized.split("/");
  return (
    normalized === MANIFEST_FILE ||
    // 자동 업데이트 설정 기록 — 릴리스가 덮어쓸 수 없다.
    normalized === "sharedesk-auto-update.json" ||
    BOOTSTRAP_CORE_PATHS.some(
      (corePath) => normalized === corePath.toLowerCase(),
    ) ||
    // 워크플로 주입 차단 — .github 아래는 어떤 경로도 관리 대상이 될 수 없다.
    parts[0] === ".github" ||
    parts.some(
      (part, index) =>
        (part.startsWith(".env") &&
          !(part === ".env.example" && index === parts.length - 1)) ||
        part === ".git" ||
        part === ".vercel" ||
        part === ".sharedesk-updater",
    )
  );
}

export function validateManagedPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes(":") ||
    /[<>"|?*\u0001-\u001f]/.test(value) ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`Unsafe managed path: ${String(value)}`);
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        part.endsWith(" ") ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(
          part.split(".", 1)[0].trimEnd(),
        ),
    )
  ) {
    throw new Error(`Unsafe managed path: ${value}`);
  }
  if (isProtectedPath(value)) {
    throw new Error(`Protected path cannot be managed: ${value}`);
  }
  return value;
}

function shouldManageReleasePath(relativePath) {
  try {
    validateManagedPath(relativePath);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Protected path cannot be managed:")
    ) {
      return false;
    }
    throw error;
  }
}

async function gitOutput(rootDir, args, options = {}) {
  const result = await execFileAsync("git", args, {
    cwd: rootDir,
    encoding: options.encoding ?? "buffer",
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return result.stdout;
}

function nullSeparated(output) {
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : output;
  return text.split("\0").filter(Boolean);
}

export async function assertReleaseSourcesCommitted(rootDir) {
  try {
    await gitOutput(rootDir, [
      "diff",
      "--quiet",
      "HEAD",
      "--",
      ".",
      `:(exclude)${MANIFEST_FILE}`,
    ]);
  } catch (error) {
    if (error?.code === 1) {
      throw new Error(
        `Commit every release source except ${MANIFEST_FILE} before generating the manifest.`,
      );
    }
    throw error;
  }
  const untracked = nullSeparated(
    await gitOutput(rootDir, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ).filter((relativePath) => relativePath !== MANIFEST_FILE);
  if (untracked.length > 0) {
    throw new Error(
      `Commit every release source except ${MANIFEST_FILE} before generating the manifest: ${untracked.join(", ")}`,
    );
  }
}

async function releaseEntriesAtRef(rootDir, releaseRef, normalizeContent) {
  const commit = String(
    await gitOutput(rootDir, ["rev-parse", "--verify", `${releaseRef}^{commit}`], {
      encoding: "utf8",
    }),
  ).trim();
  const treeOutput = await gitOutput(rootDir, ["ls-tree", "-rz", commit]);
  const records = nullSeparated(treeOutput);
  const entries = [];
  for (const record of records) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Could not parse a legacy Git tree entry.");
    const [, mode, type, objectId, relativePath] = match;
    if (!shouldManageReleasePath(relativePath)) continue;
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error(`Release path is not a regular file: ${relativePath}`);
    }
    const content = await gitOutput(rootDir, ["cat-file", "blob", objectId]);
    entries.push(releaseFileEntry(relativePath, content, normalizeContent));
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

async function inheritedLegacyManifests(rootDir) {
  try {
    const existing = validateManifest(
      JSON.parse(await readFile(path.join(rootDir, MANIFEST_FILE), "utf8")),
    );
    return existing.legacyManifests.map((legacy) => ({
      schemaVersion: 1,
      version: legacy.version,
      files: legacy.files,
    }));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(
      `Existing release manifest is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function generateReleaseManifest({
  rootDir,
  legacyRef,
  sourceRef = "HEAD",
}) {
  const absoluteRoot = path.resolve(rootDir);
  const files = await releaseEntriesAtRef(absoluteRoot, sourceRef, true);
  const bootstrapFiles = [];
  for (const corePath of BOOTSTRAP_CORE_PATHS) {
    const content = await gitOutput(absoluteRoot, [
      "show",
      `${sourceRef}:${corePath}`,
    ]);
    bootstrapFiles.push(releaseFileEntry(corePath, content, true));
  }

  const packageValue = JSON.parse(
    String(
      await gitOutput(absoluteRoot, ["show", `${sourceRef}:package.json`], {
        encoding: "utf8",
      }),
    ),
  );
  const version = normalizeVersion(packageValue.version);
  if (!version) throw new Error("package.json version must be stable semver.");

  const legacyFiles = await releaseEntriesAtRef(absoluteRoot, legacyRef, false);
  const legacyPackage = legacyFiles.find((entry) => entry.path === "package.json");
  if (!legacyPackage) throw new Error("Legacy release is missing package.json.");
  const legacyPackageBytes = await gitOutput(absoluteRoot, [
    "show",
    `${legacyRef}:package.json`,
  ]);
  const legacyVersion = normalizeVersion(
    JSON.parse(legacyPackageBytes.toString("utf8")).version,
  );
  if (!legacyVersion) throw new Error("Legacy package version must be stable semver.");
  const inheritedLegacy = await inheritedLegacyManifests(absoluteRoot);
  const legacyManifests = new Map(
    inheritedLegacy.map((legacy) => [legacy.version, legacy]),
  );
  legacyManifests.set(legacyVersion, {
    schemaVersion: 1,
    version: legacyVersion,
    files: legacyFiles,
  });

  return validateManifest({
    schemaVersion: 1,
    version,
    files,
    bootstrapFiles,
    legacyManifests: [...legacyManifests.values()].sort((left, right) =>
      compareSemver(left.version, right.version),
    ),
  });
}

function validateRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes(":") ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`Unsafe managed path: ${String(value)}`);
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        part.endsWith(".") ||
        part.endsWith(" "),
    )
  ) {
    throw new Error(`Unsafe managed path: ${value}`);
  }
  return value;
}

function validateFileEntries(entries, options = {}) {
  if (!Array.isArray(entries)) {
    throw new Error(`${options.label ?? "Release manifest files"} must be an array.`);
  }
  const seen = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Release manifest file entry must be an object.");
    }
    const managedPath = options.bootstrap
      ? validateRelativePath(entry.path)
      : validateManagedPath(entry.path);
    if (options.bootstrap && !BOOTSTRAP_CORE_PATHS.includes(managedPath)) {
      throw new Error(`Unexpected bootstrap core path: ${managedPath}`);
    }
    const pathKey = managedPath.toLowerCase();
    if (seen.has(pathKey)) {
      throw new Error(`Duplicate managed path: ${managedPath}`);
    }
    seen.add(pathKey);
    if (typeof entry.sha256 !== "string" || !HASH_PATTERN.test(entry.sha256)) {
      throw new Error(`Invalid sha256 for ${managedPath}`);
    }
    if (
      !Array.isArray(entry.acceptedSha256 ?? []) ||
      (entry.acceptedSha256 ?? []).some(
        (hash) => typeof hash !== "string" || !HASH_PATTERN.test(hash),
      )
    ) {
      throw new Error(`Invalid acceptedSha256 for ${managedPath}`);
    }
    const acceptedSha256 = [
      ...new Set(
        (entry.acceptedSha256 ?? []).filter((hash) => hash !== entry.sha256),
      ),
    ];
    return {
      path: managedPath,
      sha256: entry.sha256,
      ...(acceptedSha256.length > 0 ? { acceptedSha256 } : {}),
    };
  });
}

export function validateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Release manifest must be an object.");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("Unsupported release manifest schema.");
  }
  const version = normalizeVersion(value.version);
  if (!version) throw new Error("Release manifest version must be stable semver.");
  if (Array.isArray(value.files) && Array.isArray(value.bootstrapFiles)) {
    const bootstrapPathKeys = new Set(
      value.bootstrapFiles
        .map((entry) =>
          typeof entry?.path === "string" ? entry.path.toLowerCase() : null,
        )
        .filter(Boolean),
    );
    const duplicateCore = value.files.find(
      (entry) =>
        typeof entry?.path === "string" &&
        bootstrapPathKeys.has(entry.path.toLowerCase()),
    );
    if (duplicateCore) {
      throw new Error(
        `Bootstrap core path cannot also be managed: ${duplicateCore.path}`,
      );
    }
  }
  const files = validateFileEntries(value.files);
  const bootstrapFiles = validateFileEntries(value.bootstrapFiles ?? [], {
    bootstrap: true,
    label: "Release manifest bootstrapFiles",
  });
  if (
    bootstrapFiles.length > 0 &&
    (bootstrapFiles.length !== BOOTSTRAP_CORE_PATHS.length ||
      BOOTSTRAP_CORE_PATHS.some(
        (corePath) => !bootstrapFiles.some((entry) => entry.path === corePath),
      ))
  ) {
    throw new Error("Release manifest must include every bootstrap core file.");
  }
  const managedPathKeys = new Set(files.map((entry) => entry.path.toLowerCase()));
  for (const bootstrapEntry of bootstrapFiles) {
    if (managedPathKeys.has(bootstrapEntry.path.toLowerCase())) {
      throw new Error(
        `Bootstrap core path cannot also be managed: ${bootstrapEntry.path}`,
      );
    }
  }
  if (!Array.isArray(value.legacyManifests ?? [])) {
    throw new Error("Release manifest legacyManifests must be an array.");
  }
  const seenLegacyVersions = new Set();
  const legacyManifests = (value.legacyManifests ?? []).map((legacy) => {
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
      throw new Error("Legacy release manifest must be an object.");
    }
    const legacyVersion = normalizeVersion(legacy.version);
    if (!legacyVersion || seenLegacyVersions.has(legacyVersion)) {
      throw new Error(`Invalid or duplicate legacy version: ${legacy.version}`);
    }
    seenLegacyVersions.add(legacyVersion);
    return {
      schemaVersion: 1,
      version: legacyVersion,
      files: validateFileEntries(legacy.files, {
        label: "Legacy release manifest files",
      }),
      bootstrapFiles: [],
      legacyManifests: [],
    };
  });
  return {
    schemaVersion: 1,
    version,
    files,
    bootstrapFiles,
    legacyManifests,
  };
}

async function readInstalledManifest(rootDir) {
  try {
    const raw = await readFile(path.join(rootDir, MANIFEST_FILE), "utf8");
    return validateManifest(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(
      `Installed release manifest is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function rejectSymlinkPath(rootDir, relativePath) {
  const rootInfo = await lstat(rootDir);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw new Error("Installation root must be a real directory.");
  }
  let current = rootDir;
  for (const part of relativePath.split("/")) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed: ${relativePath}`);
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
}

async function fileHash(filePath) {
  try {
    const info = await lstat(filePath);
    if (!info.isFile()) return null;
    const content = await readFile(filePath);
    if (!isUtf8Text(content)) return sha256(content);
    return sha256(
      Buffer.from(content.toString("utf8").replace(/\r\n/g, "\n"), "utf8"),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function entryAcceptsHash(entry, hash) {
  return (
    hash === entry.sha256 ||
    (Array.isArray(entry.acceptedSha256) && entry.acceptedSha256.includes(hash))
  );
}

async function resolvePreviousManifest(rootDir, installed, nextManifest) {
  if (installed) return installed;
  try {
    const packageValue = JSON.parse(
      await readFile(path.join(rootDir, "package.json"), "utf8"),
    );
    const packageVersion = normalizeVersion(packageValue?.version);
    if (!packageVersion) return null;
    return (
      nextManifest.legacyManifests.find(
        (legacy) => legacy.version === packageVersion,
      ) ?? null
    );
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function readInstalledVersion(rootDir, installedManifest) {
  if (installedManifest) return installedManifest.version;
  try {
    const packageValue = JSON.parse(
      await readFile(path.join(rootDir, "package.json"), "utf8"),
    );
    return normalizeVersion(packageValue?.version);
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

function entriesShareAcceptedHash(left, right) {
  if (!left || !right) return false;
  const leftHashes = new Set([left.sha256, ...(left.acceptedSha256 ?? [])]);
  return [right.sha256, ...(right.acceptedSha256 ?? [])].some((hash) =>
    leftHashes.has(hash),
  );
}

function assertPreservedWorkflowIsCurrent(
  previousManifest,
  nextManifest,
  bootstrapPaths,
) {
  if (bootstrapPaths.includes(UPDATE_WORKFLOW_PATH)) return;
  const previousWorkflow = previousManifest?.bootstrapFiles.find(
    (entry) => entry.path === UPDATE_WORKFLOW_PATH,
  );
  const nextWorkflow = nextManifest.bootstrapFiles.find(
    (entry) => entry.path === UPDATE_WORKFLOW_PATH,
  );
  if (!entriesShareAcceptedHash(previousWorkflow, nextWorkflow)) {
    throw new Error(
      "The ShareDesk update workflow changed. Run the one-time bootstrap in docs/UPDATE.md before updating.",
    );
  }
}

async function assertNoManagedConflicts({
  rootDir,
  previousManifest,
  writeEntries,
  removePaths,
  bootstrapPaths,
}) {
  const bootstrapPathKeys = new Set(
    bootstrapPaths.map((filePath) => filePath.toLowerCase()),
  );
  const previousEntries = [
    ...(previousManifest?.files ?? []),
    ...(previousManifest?.bootstrapFiles.filter((entry) =>
      bootstrapPathKeys.has(entry.path.toLowerCase()),
    ) ?? []),
  ];
  const previousByPath = new Map(
    previousEntries.map((entry) => [entry.path.toLowerCase(), entry]),
  );
  const conflicts = [];

  for (const nextEntry of writeEntries) {
    await rejectSymlinkPath(rootDir, nextEntry.path);
    const currentHash = await fileHash(
      path.join(rootDir, ...nextEntry.path.split("/")),
    );
    const previousEntry = previousByPath.get(nextEntry.path.toLowerCase());
    if (previousEntry) {
      if (
        !entryAcceptsHash(previousEntry, currentHash) &&
        !entryAcceptsHash(nextEntry, currentHash)
      ) {
        conflicts.push(nextEntry.path);
      }
    } else if (currentHash !== null && !entryAcceptsHash(nextEntry, currentHash)) {
      conflicts.push(nextEntry.path);
    }
  }

  for (const relativePath of removePaths) {
    await rejectSymlinkPath(rootDir, relativePath);
    const currentHash = await fileHash(
      path.join(rootDir, ...relativePath.split("/")),
    );
    const previousEntry = previousByPath.get(relativePath.toLowerCase());
    if (
      !previousEntry ||
      (currentHash !== null && !entryAcceptsHash(previousEntry, currentHash))
    ) {
      conflicts.push(relativePath);
    }
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Update conflicts with local changes: ${[...new Set(conflicts)].join(", ")}`,
    );
  }
}

export function planRelease(previousManifest, nextManifest) {
  const previous = previousManifest ? validateManifest(previousManifest) : null;
  const next = validateManifest(nextManifest);
  const previousPaths = new Map(
    previous?.files.map((entry) => [entry.path.toLowerCase(), entry.path]) ?? [],
  );
  const caseOnlyRename = next.files.find((entry) => {
    const previousPath = previousPaths.get(entry.path.toLowerCase());
    return previousPath !== undefined && previousPath !== entry.path;
  });
  if (caseOnlyRename) {
    throw new Error(
      `Case-only managed path changes are not supported: ${previousPaths.get(
        caseOnlyRename.path.toLowerCase(),
      )} -> ${caseOnlyRename.path}`,
    );
  }
  const nextPaths = new Set(
    next.files.map((entry) => entry.path.toLowerCase()),
  );
  return {
    previousVersion: previous?.version ?? null,
    nextVersion: next.version,
    write: next.files.map((entry) => entry.path),
    remove:
      previous?.files
        .map((entry) => entry.path)
        .filter((filePath) => !nextPaths.has(filePath.toLowerCase())) ?? [],
  };
}

async function stageRelease(stageDir, entries, fetchFile) {
  for (const entry of entries) {
    const content = await fetchFile(entry.path);
    const bytes =
      content instanceof Uint8Array ? content : new Uint8Array(content);
    const actualHash = sha256(bytes);
    if (actualHash !== entry.sha256) {
      throw new Error(
        `Hash verification failed for ${entry.path}: expected ${entry.sha256}, got ${actualHash}`,
      );
    }
    const stagePath = path.join(stageDir, ...entry.path.split("/"));
    await mkdir(path.dirname(stagePath), { recursive: true });
    await writeFile(stagePath, bytes);
  }
}

async function backUpTargets(rootDir, backupDir, targets) {
  const records = [];
  for (const relativePath of targets) {
    await rejectSymlinkPath(rootDir, relativePath);
    const target = path.join(rootDir, ...relativePath.split("/"));
    try {
      const info = await lstat(target);
      if (!info.isFile()) {
        throw new Error(`Managed target is not a regular file: ${relativePath}`);
      }
      const backup = path.join(backupDir, ...relativePath.split("/"));
      await mkdir(path.dirname(backup), { recursive: true });
      await copyFile(target, backup);
      records.push({ relativePath, existed: true, backup });
    } catch (error) {
      if (error?.code === "ENOENT") {
        records.push({ relativePath, existed: false, backup: null });
      } else {
        throw error;
      }
    }
  }
  return records;
}

async function replaceFile(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.sharedesk-${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    await rm(destination, { force: true });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function rollBack(rootDir, records) {
  const failures = [];
  for (const record of [...records].reverse()) {
    const target = path.join(rootDir, ...record.relativePath.split("/"));
    try {
      if (record.existed) {
        await replaceFile(record.backup, target);
      } else {
        await rm(target, { force: true });
      }
    } catch (error) {
      failures.push(`${record.relativePath}: ${error instanceof Error ? error.message : error}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Rollback failed: ${failures.join("; ")}`);
  }
}

async function applyReleaseInternal({
  rootDir,
  manifest,
  fetchFile,
  bootstrapPaths,
  requireWorkflowCompatibility = false,
}) {
  const absoluteRoot = path.resolve(rootDir);
  const nextManifest = validateManifest(manifest);
  const installedManifest = await readInstalledManifest(absoluteRoot);
  const previousManifest = await resolvePreviousManifest(
    absoluteRoot,
    installedManifest,
    nextManifest,
  );
  if (requireWorkflowCompatibility) {
    assertPreservedWorkflowIsCurrent(
      previousManifest,
      nextManifest,
      bootstrapPaths,
    );
  }
  const installedVersion = await readInstalledVersion(
    absoluteRoot,
    installedManifest,
  );
  if (installedVersion) {
    assertNotDowngrade(installedVersion, nextManifest.version);
  }
  const plan = planRelease(previousManifest, nextManifest);
  const workDir = await mkdtemp(path.join(tmpdir(), "sharedesk-update-"));
  const stageDir = path.join(workDir, "stage");
  const backupDir = path.join(workDir, "backup");
  await mkdir(stageDir, { recursive: true });
  await mkdir(backupDir, { recursive: true });

  try {
    const bootstrapPathKeys = new Set(
      bootstrapPaths.map((filePath) => filePath.toLowerCase()),
    );
    const selectedBootstrapFiles = nextManifest.bootstrapFiles.filter((entry) =>
      bootstrapPathKeys.has(entry.path.toLowerCase()),
    );
    if (
      bootstrapPaths.some(
        (corePath) =>
          !selectedBootstrapFiles.some(
            (entry) => entry.path.toLowerCase() === corePath.toLowerCase(),
          ),
      )
    ) {
      throw new Error("Release manifest does not contain the required core files.");
    }
    const writeEntries = [
      ...new Map(
        [
          ...nextManifest.files,
          ...selectedBootstrapFiles,
        ].map((entry) => [entry.path.toLowerCase(), entry]),
      ).values(),
    ];
    await stageRelease(stageDir, writeEntries, fetchFile);
    await assertNoManagedConflicts({
      rootDir: absoluteRoot,
      previousManifest,
      writeEntries,
      removePaths: plan.remove,
      bootstrapPaths,
    });

    const changedWrites = [];
    for (const entry of writeEntries) {
      await rejectSymlinkPath(absoluteRoot, entry.path);
      const target = path.join(absoluteRoot, ...entry.path.split("/"));
      if (!entryAcceptsHash(entry, await fileHash(target))) {
        changedWrites.push(entry.path);
      }
    }
    const changedRemovals = [];
    for (const relativePath of plan.remove) {
      await rejectSymlinkPath(absoluteRoot, relativePath);
      try {
        const info = await lstat(
          path.join(absoluteRoot, ...relativePath.split("/")),
        );
        if (!info.isFile()) {
          throw new Error(`Managed target is not a regular file: ${relativePath}`);
        }
        changedRemovals.push(relativePath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }

    const previousBootstrapByPath = new Map(
      previousManifest?.bootstrapFiles.map((entry) => [
        entry.path.toLowerCase(),
        entry,
      ]) ?? [],
    );
    const installedNextManifest = {
      ...nextManifest,
      bootstrapFiles: nextManifest.bootstrapFiles.map((entry) =>
        bootstrapPathKeys.has(entry.path.toLowerCase())
          ? entry
          : previousBootstrapByPath.get(entry.path.toLowerCase()) ?? entry,
      ),
    };
    const serializedManifest = `${JSON.stringify(installedNextManifest, null, 2)}\n`;
    const installedManifestPath = path.join(absoluteRoot, MANIFEST_FILE);
    const manifestChanged =
      (await readFile(installedManifestPath, "utf8").catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      })) !== serializedManifest;
    const targets = [
      ...new Set([
        ...changedWrites,
        ...changedRemovals,
        ...(manifestChanged ? [MANIFEST_FILE] : []),
      ]),
    ];
    if (targets.length === 0) {
      return { changed: false, version: nextManifest.version, written: [], removed: [] };
    }

    const records = await backUpTargets(absoluteRoot, backupDir, targets);
    try {
      for (const relativePath of changedWrites) {
        await replaceFile(
          path.join(stageDir, ...relativePath.split("/")),
          path.join(absoluteRoot, ...relativePath.split("/")),
        );
      }
      for (const relativePath of changedRemovals) {
        await rm(path.join(absoluteRoot, ...relativePath.split("/")));
      }
      if (manifestChanged) {
        const stagedManifest = path.join(workDir, MANIFEST_FILE);
        await writeFile(stagedManifest, serializedManifest, "utf8");
        await replaceFile(stagedManifest, installedManifestPath);
      }
    } catch (error) {
      try {
        await rollBack(absoluteRoot, records);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Update and rollback failed.");
      }
      throw error;
    }

    return {
      changed: true,
      version: nextManifest.version,
      written: changedWrites,
      removed: changedRemovals,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function applyRelease(options) {
  return applyReleaseInternal({ ...options, bootstrapPaths: [] });
}

export async function applyAutomaticRelease(options) {
  return applyReleaseInternal({
    ...options,
    bootstrapPaths: AUTOMATIC_CORE_PATHS,
    requireWorkflowCompatibility: true,
  });
}

export async function applyBootstrapRelease(options) {
  return applyReleaseInternal({
    ...options,
    bootstrapPaths: BOOTSTRAP_CORE_PATHS,
  });
}

export function selectStableRelease(releases) {
  if (!Array.isArray(releases)) return null;
  let latest = null;
  for (const release of releases) {
    const version = normalizeVersion(release?.tag_name);
    if (release?.draft || release?.prerelease || !version) continue;
    if (!latest || compareSemver(version, latest.version) > 0) {
      latest = { ...release, version };
    }
  }
  return latest;
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
    `https://api.github.com/repos/${UPDATE_SOURCE_REPOSITORY}/releases?per_page=100`,
  );
  const release = selectStableRelease(releases);
  if (!release) throw new Error("No stable ShareDesk release is available.");

  const manifestAsset = Array.isArray(release.assets)
    ? release.assets.find((asset) => asset?.name === MANIFEST_FILE)
    : null;
  const manifestUrl =
    typeof manifestAsset?.browser_download_url === "string"
      ? manifestAsset.browser_download_url
      : `https://raw.githubusercontent.com/${UPDATE_SOURCE_REPOSITORY}/${encodeURIComponent(
          release.tag_name,
        )}/${MANIFEST_FILE}`;
  const response = await fetch(manifestUrl);
  if (!response.ok) {
    throw new Error(`Release manifest request failed (${response.status}).`);
  }
  const manifest = validateManifest(await response.json());
  if (manifest.version !== release.version) {
    throw new Error("Release tag and manifest version do not match.");
  }
  return { release, manifest };
}

function rawFileUrl(tagName, relativePath) {
  const encodedPath = relativePath.split("/").map(encodeURIComponent).join("/");
  return `https://raw.githubusercontent.com/${UPDATE_SOURCE_REPOSITORY}/${encodeURIComponent(
    tagName,
  )}/${encodedPath}`;
}

async function runCli() {
  const args = process.argv.slice(2);
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (args[0] === "--generate-manifest") {
    if (args.length !== 2) {
      throw new Error(
        "Usage: node scripts/sharedesk-update.mjs --generate-manifest <legacy-ref>",
      );
    }
    await assertReleaseSourcesCommitted(rootDir);
    const manifest = await generateReleaseManifest({
      rootDir,
      legacyRef: args[1],
    });
    await writeFile(
      path.join(rootDir, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    process.stdout.write(
      `Generated ${MANIFEST_FILE} for ${manifest.version} with ${manifest.legacyManifests.length} legacy baseline(s).\n`,
    );
    return;
  }
  if (args.length !== 1 || (args[0] !== "--check" && args[0] !== "--apply")) {
    throw new Error(
      "Usage: node scripts/sharedesk-update.mjs --check|--apply|--generate-manifest <legacy-ref>",
    );
  }
  const { release, manifest } = await loadLatestRelease();
  const installed = await readInstalledManifest(rootDir);
  const currentVersion = installed?.version ?? JSON.parse(
    await readFile(path.join(rootDir, "package.json"), "utf8"),
  ).version;

  if (args[0] === "--check") {
    process.stdout.write(
      `${JSON.stringify({
        currentVersion,
        latestVersion: manifest.version,
        updateAvailable: compareSemver(manifest.version, currentVersion) > 0,
      })}\n`,
    );
    return;
  }

  assertNotDowngrade(currentVersion, manifest.version);
  const result = await applyAutomaticRelease({
    rootDir,
    manifest,
    fetchFile: async (relativePath) => {
      const response = await fetch(rawFileUrl(release.tag_name, relativePath));
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
