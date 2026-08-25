import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename as fsRename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { currentSpaceFolderId } from "@/lib/space-store";
import { guessMime, officePreviewImport } from "@/lib/preview";
import { createOfficePreviewFallback } from "@/lib/office-preview-fallback";
import {
  DownloadResult,
  EmptyTrashResult,
  Entry,
  ROOT_ID,
  SPACES_DIR,
  STATE_DIR,
  StateRead,
  StorageAdapter,
  StorageError,
  StoragePermission,
  StorageUsage,
  TEMPORARY_FILE_PREFIX,
  ShareRole,
  TrashDeleteTarget,
  TrashEntry,
  UploadSession,
  assertUserName,
  assertValidName,
  conflictError,
  stateAccessDenied,
} from "./types";

// 개발·검증용 어댑터 — 로컬 폴더를 드라이브처럼 취급한다.
// id는 루트 기준 상대경로의 base64url. 경로 탈출(..)은 디코드 직후 차단한다.

function rootDir(): string {
  const base = path.resolve(
    /* turbopackIgnore: true */
    process.cwd(),
    process.env.LOCAL_STORAGE_ROOT || ".devstorage",
  );
  // 멀티 데스크(#12): 스페이스 문맥이 있으면 그 스페이스의 하위 폴더가 루트다.
  // 이 아래의 모든 경로·상태 해석이 자동으로 그 스페이스에 갇힌다.
  const spaceRel = currentSpaceFolderId();
  if (!spaceRel) return base;
  const scoped = path.resolve(base, spaceRel);
  if (scoped !== base && !scoped.startsWith(base + path.sep)) {
    throw new StorageError("BAD_ID", "스페이스 루트가 저장소 밖을 가리킵니다");
  }
  return scoped;
}

function idToRel(id: string): string {
  if (id === ROOT_ID || id === "") return "";
  const rel = Buffer.from(id, "base64url").toString("utf8");
  const segments = rel.split("/");
  if (
    !rel ||
    rel.includes("\\") ||
    segments.some((seg) => !seg || seg === "." || seg === "..")
  ) {
    throw new StorageError("BAD_ID", "잘못된 id입니다");
  }
  // 로컬 id는 경로의 base64url이라 누구나 계산할 수 있다. 앱 내부 영역
  // (.sharedesk = 명단, .spaces = 다른 스페이스 저장소)은 파일 API로 열람·수정·
  // 삭제할 수 없어야 한다. .spaces를 빼먹으면 기본 데스크 사용자가
  // base64url(".spaces/sea/secret.pdf")로 남의 스페이스 파일에 그대로 닿는다.
  const firstSegment =
    process.platform === "win32"
      ? segments[0].split(":", 1)[0].replace(/[ .]+$/g, "").toLowerCase()
      : segments[0].toLowerCase();
  if (firstSegment === STATE_DIR || firstSegment === SPACES_DIR) {
    throw stateAccessDenied();
  }
  return rel;
}

function relToId(rel: string): string {
  return rel ? Buffer.from(rel, "utf8").toString("base64url") : ROOT_ID;
}

function absOf(rel: string): string {
  const root = rootDir();
  const abs = path.resolve(/* turbopackIgnore: true */ root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new StorageError("BAD_ID", "잘못된 경로입니다");
  }
  return abs;
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot =
    process.platform === "win32" ? root.toLowerCase() : root;
  const normalizedTarget =
    process.platform === "win32" ? target.toLowerCase() : target;
  const rel = path.relative(normalizedRoot, normalizedTarget);
  return (
    rel === "" ||
    (!path.isAbsolute(rel) && !rel.startsWith(`..${path.sep}`) && rel !== "..")
  );
}

async function assertSafeRealTarget(
  realRoot: string,
  realTarget: string,
  allowState: boolean,
): Promise<void> {
  if (!isInside(realRoot, realTarget)) {
    throw new StorageError("BAD_ID", "저장소 밖의 경로입니다");
  }
  if (allowState) return;

  // 상태 폴더와 스페이스 컨테이너 안으로 실제 경로가 떨어지면 거부한다.
  // .spaces를 빼면 심볼릭 링크로 남의 스페이스 파일에 닿을 수 있다.
  for (const guarded of [STATE_DIR, SPACES_DIR]) {
    const realGuarded = await realpath(
      path.join(/* turbopackIgnore: true */ realRoot, guarded),
    ).catch((error: unknown) => {
      if (isNoEnt(error)) return null;
      throw error;
    });
    if (realGuarded && isInside(realGuarded, realTarget)) {
      throw stateAccessDenied();
    }
  }
}

async function assertNotStateAlias(
  realRoot: string,
  rel: string,
  allowState: boolean,
): Promise<void> {
  if (allowState || !rel) return;
  const firstSegment = rel.split("/", 1)[0];
  // 심볼릭 링크가 이름만 바꿔 .sharedesk나 .spaces를 가리키는 우회를 inode
  // 비교로 잡는다. idToRel은 이름으로만 막으므로 별칭은 여기서 걸러야 한다.
  const [stateStats, spacesStats, firstStats] = await Promise.all([
    stat(path.join(/* turbopackIgnore: true */ realRoot, STATE_DIR)).catch(
      (error: unknown) => {
        if (isNoEnt(error)) return null;
        throw error;
      },
    ),
    stat(path.join(/* turbopackIgnore: true */ realRoot, SPACES_DIR)).catch(
      (error: unknown) => {
        if (isNoEnt(error)) return null;
        throw error;
      },
    ),
    stat(path.join(/* turbopackIgnore: true */ realRoot, firstSegment)).catch(
      (error: unknown) => {
        if (isNoEnt(error)) return null;
        throw error;
      },
    ),
  ]);
  const aliases = (
    [stateStats, spacesStats].filter(Boolean) as import("node:fs").Stats[]
  );
  if (
    firstStats &&
    aliases.some(
      (target) =>
        target.dev === firstStats.dev && target.ino === firstStats.ino,
    )
  ) {
    throw stateAccessDenied();
  }
}

async function safeAbs(
  rel: string,
  allowMissing = false,
  allowState = false,
): Promise<string> {
  const abs = absOf(rel);
  const realRoot = await realpath(rootDir());
  await assertNotStateAlias(realRoot, rel, allowState);
  let missing: NodeJS.ErrnoException | null = null;
  let targetStat: Stats | null = null;

  try {
    targetStat = await lstat(abs);
  } catch (e) {
    if (!isNoEnt(e)) throw e;
    missing = e as NodeJS.ErrnoException;
  }

  if (!missing) {
    let realTarget: string | null = null;
    try {
      realTarget = await realpath(abs);
    } catch (e) {
      // 끊어진 심볼릭 링크를 "새 파일"로 취급하면 링크 바깥에 쓸 수 있다.
      if (isNoEnt(e)) {
        const current = await lstat(abs).catch((caught) => {
          if (isNoEnt(caught)) return null;
          throw caught;
        });
        if (targetStat?.isSymbolicLink() || current?.isSymbolicLink()) {
          throw new StorageError("BAD_ID", "저장소 밖의 경로입니다");
        }
        // 잠금 파일처럼 다른 요청이 방금 지운 일반 파일은 생성 가능 경로로
        // 다시 검사한다. 현재 다른 일반 파일이 생겼다면 그 대상을 처음부터 본다.
        if (allowMissing) {
          if (current) return safeAbs(rel, allowMissing, allowState);
          missing = e as NodeJS.ErrnoException;
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }
    if (!missing && realTarget) {
      await assertSafeRealTarget(realRoot, realTarget, allowState);
      return abs;
    }
  }

  if (!allowMissing) throw missing;

  // 생성 대상은 아직 없을 수 있다. 가장 가까운 기존 부모의 실제 경로를 검사한다.
  let ancestor = path.dirname(abs);
  while (true) {
    let ancestorMissing = false;
    try {
      await lstat(ancestor);
    } catch (e) {
      if (!isNoEnt(e)) throw e;
      ancestorMissing = true;
    }
    if (!ancestorMissing) {
      let realAncestor: string;
      try {
        realAncestor = await realpath(ancestor);
      } catch (e) {
        if (isNoEnt(e)) {
          throw new StorageError("BAD_ID", "저장소 밖의 경로입니다");
        }
        throw e;
      }
      await assertSafeRealTarget(realRoot, realAncestor, allowState);
      return abs;
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) {
      throw new StorageError("BAD_ID", "저장소 밖의 경로입니다");
    }
    ancestor = parent;
  }
}

function joinRel(parentRel: string, name: string): string {
  return parentRel ? `${parentRel}/${name}` : name;
}

function layoutKey(s: Stats): string {
  // 경로 기반 id와 달리 파일 시스템 identity는 이름을 바꿔도 유지된다.
  return `local:${s.dev}:${s.ino}:${s.birthtimeMs}`;
}

function entryVersion(s: Stats): string {
  return `local:${s.dev}:${s.ino}:${s.mtimeMs}`;
}


async function toEntry(rel: string, name: string): Promise<Entry> {
  const s = await stat(/* turbopackIgnore: true */ await safeAbs(rel));
  return {
    id: relToId(rel),
    layoutKey: layoutKey(s),
    name,
    isFolder: s.isDirectory(),
    size: s.isDirectory() ? null : s.size,
    modifiedAt: s.mtime.toISOString(),
    mimeType: null,
    version: entryVersion(s),
  };
}

function isNoEnt(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

function stateVersion(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LOCK_STALE_MS = 30_000;
const LOCK_ATTEMPTS = 50;

let localMutationTail: Promise<void> = Promise.resolve();

async function withLocalMutationLock<T>(
  task: () => Promise<T>,
): Promise<T> {
  const previous = localMutationTail;
  let release!: () => void;
  localMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await task();
  } finally {
    release();
  }
}

// 휴지통 — 항목을 .sharedesk/.trash/<uuid>로 옮기고 원위치를 매니페스트에 남긴다.
// 드라이브 휴지통과 같은 계약: 30일 지나면 완전 삭제(목록 조회 때 지연 청소).
const TRASH_DIR_NAME = ".trash";
const TRASH_MANIFEST = "trash.json";
const TRASH_PREFIX = "trash:";
const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOCAL_PERMISSIONS_STATE = "local-drive-permissions.json";
const TRASH_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface LocalPermission extends StoragePermission {
  fileId: string;
  email: string;
}

interface LocalPermissionFile {
  version: 1;
  rev: number;
  permissions: LocalPermission[];
}

function normalizeLocalPermissions(raw: unknown): LocalPermissionFile {
  const file = raw as Partial<LocalPermissionFile> | null;
  return {
    version: 1,
    rev: typeof file?.rev === "number" ? file.rev : 0,
    permissions: Array.isArray(file?.permissions)
      ? file.permissions.filter(
          (item): item is LocalPermission =>
            !!item &&
            typeof item.permissionId === "string" &&
            typeof item.fileId === "string" &&
            typeof item.email === "string" &&
            (item.role === "reader" || item.role === "writer"),
        )
      : [],
  };
}

interface TrashRecord {
  key: string;
  name: string;
  parentRel: string;
  isFolder: boolean;
  size: number | null;
  deletedAt: string;
}

function trashRecordFileId(record: TrashRecord): string {
  return relToId(joinRel(record.parentRel, record.name));
}

function trashKeyOf(id: string): string {
  const key = id.startsWith(TRASH_PREFIX) ? id.slice(TRASH_PREFIX.length) : "";
  if (!TRASH_KEY_PATTERN.test(key)) {
    throw new StorageError("BAD_ID", "잘못된 휴지통 항목입니다");
  }
  return key;
}

export class LocalAdapter implements StorageAdapter {
  private async ensureRoot(): Promise<void> {
    await mkdir(rootDir(), { recursive: true });
  }

  async getEntry(id: string): Promise<Entry> {
    await this.ensureRoot();
    const rel = idToRel(id);
    try {
      const name = rel ? path.basename(rel) : path.basename(rootDir());
      return await toEntry(rel, name);
    } catch (e) {
      if (isNoEnt(e)) throw new StorageError("NOT_FOUND", "대상이 없습니다");
      throw e;
    }
  }

  async isRoot(id: string): Promise<boolean> {
    return idToRel(id) === "";
  }

  async list(folderId: string): Promise<Entry[]> {
    await this.ensureRoot();
    const rel = idToRel(folderId);
    let items;
    try {
      items = await readdir(/* turbopackIgnore: true */ await safeAbs(rel), {
        withFileTypes: true,
      });
    } catch (e) {
      if (isNoEnt(e)) throw new StorageError("NOT_FOUND", "폴더가 없습니다");
      if ((e as NodeJS.ErrnoException)?.code === "ENOTDIR") {
        throw new StorageError("BAD_ID", "폴더가 아닙니다");
      }
      throw e;
    }
    // 목록을 만드는 사이 다른 세션이 항목을 지울 수 있다. 그 항목만 빼고 나머지는 보여준다.
    const settled = await Promise.all(
      items.map((d) =>
        toEntry(joinRel(rel, d.name), d.name).catch(() => null),
      ),
    );
    const entries = settled
      .filter((e): e is Entry => e !== null)
      .filter((e) => !e.name.startsWith("."));
    entries.sort((a, b) =>
      a.isFolder === b.isFolder
        ? a.name.localeCompare(b.name, "ko")
        : a.isFolder
          ? -1
          : 1,
    );
    return entries;
  }

  async getStorageUsage(): Promise<StorageUsage> {
    await this.ensureRoot();
    const root = rootDir();
    const sizeOf = async (
      directory: string,
      isDeskRoot = false,
    ): Promise<number> => {
      const items = await readdir(directory, { withFileTypes: true });
      let total = 0;
      for (const item of items) {
        // 데스크 루트에서는 상태 폴더와 스페이스 컨테이너를 뺀다. .spaces를
        // 합산하면 스페이스가 채운 용량 때문에 기본 데스크 업로드가 한도
        // 초과로 막힌다 — 스페이스는 자기 용량을 자기 문맥에서 따로 센다.
        if (isDeskRoot && (item.name === STATE_DIR || item.name === SPACES_DIR)) {
          continue;
        }
        const target = path.join(directory, item.name);
        if (item.isDirectory()) total += await sizeOf(target);
        else total += (await lstat(target)).size;
      }
      return total;
    };
    const [deskUsedBytes, disk] = await Promise.all([
      sizeOf(root, true),
      statfs(root),
    ]);
    const hostLimitBytes = disk.blocks * disk.bsize;
    const hostFreeBytes = disk.bavail * disk.bsize;
    return {
      deskUsedBytes,
      hostUsedBytes: Math.max(0, hostLimitBytes - hostFreeBytes),
      hostLimitBytes,
    };
  }

  async isWithin(id: string, ancestorId: string): Promise<boolean> {
    const rel = idToRel(id);
    const ancestor = idToRel(ancestorId);
    const [targetAbs, ancestorAbs] = await Promise.all([
      safeAbs(rel),
      safeAbs(ancestor),
    ]);
    const [targetPath, ancestorPath] = await Promise.all([
      realpath(targetAbs),
      realpath(ancestorAbs),
    ]);
    return isInside(ancestorPath, targetPath);
  }

  async isDirectChild(id: string, parentId: string): Promise<boolean> {
    const rel = idToRel(id);
    const parent = idToRel(parentId);
    if (!rel) return false;
    const separator = rel.lastIndexOf("/");
    return (separator >= 0 ? rel.slice(0, separator) : "") === parent;
  }

  async createSpaceRoot(slug: string): Promise<string> {
    // 반드시 기본(설치 루트) 문맥에서 부른다 — 스페이스 문맥이면 스페이스
    // 안에 스페이스가 중첩된다.
    if (currentSpaceFolderId()) {
      throw new StorageError(
        "BAD_ID",
        "스페이스 루트는 기본 데스크에서만 만들 수 있습니다",
      );
    }
    // 슬러그는 등록부 단계에서 이미 검증되지만, 저장 경계라 방어적으로 다시
    // 잡는다 — 여기서 뚫리면 경로 조작이 된다.
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(slug)) {
      throw new StorageError("BAD_ID", "스페이스 주소가 올바르지 않습니다");
    }
    await this.ensureRoot();
    const rel = `.spaces/${slug}`;
    return withLocalMutationLock(async () => {
      await mkdir(absOf(rel), { recursive: true });
      return rel;
    });
  }

  async createFolder(parentId: string, name: string): Promise<Entry> {
    await this.ensureRoot();
    const clean = assertUserName(name);
    const childRel = joinRel(idToRel(parentId), clean);
    return withLocalMutationLock(async () => {
      try {
        await mkdir(await safeAbs(childRel, true));
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === "EEXIST") throw conflictError();
        if (code === "ENOENT")
          throw new StorageError("NOT_FOUND", "상위 폴더가 없습니다");
        throw e;
      }
      return toEntry(childRel, clean);
    });
  }

  async rename(
    id: string,
    name: string,
    expectedVersion: string,
  ): Promise<Entry> {
    if (!expectedVersion || expectedVersion.length > 1024) {
      throw new StorageError("BAD_ID", "잘못된 파일 버전입니다");
    }
    const clean = assertUserName(name);
    const rel = idToRel(id);
    if (!rel)
      throw new StorageError("BAD_ID", "루트 폴더는 이름을 바꿀 수 없습니다");
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const newRel = joinRel(dir, clean);
    return withLocalMutationLock(async () => {
      let current: Stats;
      try {
        current = await stat(/* turbopackIgnore: true */ await safeAbs(rel));
      } catch (error) {
        if (isNoEnt(error)) {
          throw new StorageError("NOT_FOUND", "대상이 없습니다");
        }
        throw error;
      }
      if (entryVersion(current) !== expectedVersion) {
        throw new StorageError("CONFLICT", "다른 사람이 먼저 파일을 수정했습니다");
      }
      // fsRename은 목적지를 말없이 덮어쓴다. 이름만 바꾸는 경우(대소문자 변경 등)를
      // 제외하고 목적지가 이미 있으면 거부한다.
      if (
        newRel !== rel &&
        (await stat(
          /* turbopackIgnore: true */ await safeAbs(newRel, true),
        ).catch(() => null))
      ) {
        throw conflictError();
      }
      try {
        await fsRename(await safeAbs(rel), await safeAbs(newRel, true));
      } catch (e) {
        if (isNoEnt(e)) throw new StorageError("NOT_FOUND", "대상이 없습니다");
        throw e;
      }
      return toEntry(newRel, clean);
    });
  }

  async move(
    id: string,
    targetFolderId: string,
    expectedVersion: string,
  ): Promise<Entry> {
    await this.ensureRoot();
    const rel = idToRel(id);
    if (!rel) throw new StorageError("BAD_ID", "루트 폴더는 옮길 수 없습니다");
    const targetRel = idToRel(targetFolderId);
    if (targetRel === rel || targetRel.startsWith(`${rel}/`)) {
      throw new StorageError(
        "BAD_ID",
        "폴더를 자기 안쪽 폴더로 옮길 수 없습니다",
      );
    }
    return withLocalMutationLock(async () => {
      let targetStat: Stats;
      try {
        targetStat = await stat(
          /* turbopackIgnore: true */ await safeAbs(targetRel),
        );
      } catch (e) {
        if (isNoEnt(e))
          throw new StorageError("NOT_FOUND", "대상 폴더가 없습니다");
        throw e;
      }
      if (!targetStat.isDirectory()) {
        throw new StorageError("BAD_ID", "폴더가 아닙니다");
      }

      let s: Stats;
      try {
        s = await stat(/* turbopackIgnore: true */ await safeAbs(rel));
      } catch (e) {
        if (isNoEnt(e)) throw new StorageError("NOT_FOUND", "대상이 없습니다");
        throw e;
      }
      // 호출자가 마지막으로 본 버전일 때만 진행 — 드라이브 어댑터의 If-Match와
      // 같은 계약이다 (경로 기반 id라 대부분의 경쟁은 NOT_FOUND로도 걸리지만,
      // 같은 자리에서 내용이 바뀐 경우를 여기서 거른다).
      if (entryVersion(s) !== expectedVersion) {
        throw new StorageError(
          "CONFLICT",
          "다른 사람이 먼저 옮기거나 수정했습니다",
        );
      }

      const name = path.basename(rel);
      const newRel = joinRel(targetRel, name);
      if (newRel === rel) return toEntry(rel, name);
      if (
        await stat(
          /* turbopackIgnore: true */ await safeAbs(newRel, true),
        ).catch(() => null)
      ) {
        throw conflictError();
      }
      try {
        await fsRename(await safeAbs(rel), await safeAbs(newRel, true));
      } catch (e) {
        if (isNoEnt(e)) throw new StorageError("NOT_FOUND", "대상이 없습니다");
        throw e;
      }
      return toEntry(newRel, name);
    });
  }

  async remove(id: string): Promise<void> {
    const rel = idToRel(id);
    if (!rel) throw new StorageError("BAD_ID", "루트 폴더는 삭제할 수 없습니다");
    await this.ensureTrashDir();
    await withLocalMutationLock(async () => {
      let s: Stats;
      try {
        s = await stat(/* turbopackIgnore: true */ await safeAbs(rel));
      } catch (e) {
        if (isNoEnt(e)) throw new StorageError("NOT_FOUND", "대상이 없습니다");
        throw e;
      }
      const key = randomUUID();
      const record: TrashRecord = {
        key,
        name: path.basename(rel),
        parentRel: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
        isFolder: s.isDirectory(),
        size: s.isDirectory() ? null : s.size,
        deletedAt: new Date().toISOString(),
      };
      await this.withStateLock(TRASH_MANIFEST, async () => {
        try {
          await fsRename(await safeAbs(rel), await this.trashItemAbs(key));
        } catch (e) {
          if (isNoEnt(e)) throw new StorageError("NOT_FOUND", "대상이 없습니다");
          throw e;
        }
        const records = await this.readTrashRecords();
        records.push(record);
        await this.writeStateAtomic(
          joinRel(STATE_DIR, TRASH_MANIFEST),
          records,
        );
      });
    });
  }

  private async ensureTrashDir(): Promise<void> {
    await this.ensureStateDir();
    await mkdir(
      await safeAbs(joinRel(STATE_DIR, TRASH_DIR_NAME), true, true),
      { recursive: true },
    );
  }

  private async trashItemAbs(key: string): Promise<string> {
    return safeAbs(`${STATE_DIR}/${TRASH_DIR_NAME}/${key}`, true, true);
  }

  private async readTrashRecords(): Promise<TrashRecord[]> {
    try {
      const text = await readFile(
        /* turbopackIgnore: true */ await safeAbs(
          joinRel(STATE_DIR, TRASH_MANIFEST),
          true,
          true,
        ),
        "utf8",
      );
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? (parsed as TrashRecord[]) : [];
    } catch (e) {
      if (isNoEnt(e)) return [];
      throw e;
    }
  }

  async listTrash(): Promise<TrashEntry[]> {
    await this.ensureTrashDir();
    return this.withStateLock(TRASH_MANIFEST, async () => {
      const records = await this.readTrashRecords();
      const now = Date.now();
      const kept: TrashRecord[] = [];
      const entries: TrashEntry[] = [];
      let changed = false;
      for (const record of records) {
        const abs = await this.trashItemAbs(record.key);
        const exists = await stat(/* turbopackIgnore: true */ abs).catch(
          () => null,
        );
        if (!exists) {
          changed = true;
          continue;
        }
        // 드라이브 휴지통과 같은 30일 계약 — 지난 항목은 여기서 청소한다.
        if (now - Date.parse(record.deletedAt) > TRASH_TTL_MS) {
          await rm(abs, { recursive: true, force: true });
          changed = true;
          continue;
        }
        kept.push(record);
        entries.push({
          id: `${TRASH_PREFIX}${record.key}`,
          layoutKey: `${TRASH_PREFIX}${record.key}`,
          name: record.name,
          isFolder: record.isFolder,
          size: record.size,
          modifiedAt: record.deletedAt,
          mimeType: null,
          version: entryVersion(exists),
          trashedAt: record.deletedAt,
        });
      }
      if (changed) {
        await this.writeStateAtomic(joinRel(STATE_DIR, TRASH_MANIFEST), kept);
      }
      return entries.sort((a, b) =>
        (b.trashedAt ?? "").localeCompare(a.trashedAt ?? ""),
      );
    });
  }

  async restore(id: string): Promise<Entry> {
    const key = trashKeyOf(id);
    await this.ensureTrashDir();
    return withLocalMutationLock(() =>
      this.withStateLock(TRASH_MANIFEST, async () => {
        const records = await this.readTrashRecords();
        const record = records.find((r) => r.key === key);
        if (!record) {
          throw new StorageError("NOT_FOUND", "휴지통에 없는 항목입니다");
        }
        // 원래 폴더가 사라졌으면 루트로 복원한다.
        const parentOk = await stat(
          /* turbopackIgnore: true */ await safeAbs(record.parentRel, true),
        )
          .then((s) => s.isDirectory())
          .catch(() => false);
        const destParent = parentOk ? record.parentRel : "";
        const destRel = joinRel(destParent, record.name);
        if (
          await stat(
            /* turbopackIgnore: true */ await safeAbs(destRel, true),
          ).catch(() => null)
        ) {
          throw conflictError();
        }
        await fsRename(
          await this.trashItemAbs(key),
          await safeAbs(destRel, true),
        );
        await this.writeStateAtomic(
          joinRel(STATE_DIR, TRASH_MANIFEST),
          records.filter((r) => r.key !== key),
        );
        return toEntry(destRel, record.name);
      }),
    );
  }

  async purge(id: string, expectedVersion: string): Promise<string> {
    const key = trashKeyOf(id);
    await this.ensureTrashDir();
    return this.withStateLock(TRASH_MANIFEST, async () => {
      const records = await this.readTrashRecords();
      const record = records.find((item) => item.key === key);
      if (!record) {
        throw new StorageError("NOT_FOUND", "휴지통에 없는 항목입니다");
      }
      const abs = await this.trashItemAbs(key);
      const current = await stat(/* turbopackIgnore: true */ abs).catch(
        () => null,
      );
      if (!current) {
        throw new StorageError("NOT_FOUND", "휴지통에 없는 항목입니다");
      }
      if (entryVersion(current) !== expectedVersion) {
        throw new StorageError(
          "CONFLICT",
          "휴지통 항목이 목록을 연 뒤 변경되었습니다",
        );
      }
      await rm(abs, { recursive: true, force: false });
      await this.writeStateAtomic(
        joinRel(STATE_DIR, TRASH_MANIFEST),
        records.filter((r) => r.key !== key),
      );
      return trashRecordFileId(record);
    });
  }

  async emptyTrash(targets: TrashDeleteTarget[]): Promise<EmptyTrashResult> {
    await this.ensureTrashDir();
    return this.withStateLock(TRASH_MANIFEST, async () => {
      const records = await this.readTrashRecords();
      const targetByKey = new Map(
        targets.map((target) => [trashKeyOf(target.id), target.version]),
      );
      const selected = records.filter((record) => targetByKey.has(record.key));
      const deletable: TrashRecord[] = [];
      let skipped = targetByKey.size - selected.length;
      for (const record of selected) {
        const abs = await this.trashItemAbs(record.key);
        const current = await stat(/* turbopackIgnore: true */ abs).catch(
          () => null,
        );
        if (!current || entryVersion(current) !== targetByKey.get(record.key)) {
          skipped += 1;
          continue;
        }
        deletable.push(record);
      }
      const deleted: TrashRecord[] = [];
      let failed = 0;
      for (const record of deletable) {
        try {
          await rm(await this.trashItemAbs(record.key), {
            recursive: true,
            force: false,
          });
          deleted.push(record);
        } catch (error) {
          failed += 1;
          console.error("[local] 휴지통 항목 완전 삭제 실패", {
            key: record.key,
            error,
          });
        }
      }
      const deletedKeys = new Set(deleted.map((record) => record.key));
      await this.writeStateAtomic(
        joinRel(STATE_DIR, TRASH_MANIFEST),
        records.filter((record) => !deletedKeys.has(record.key)),
      );
      return {
        fileIds: deleted.map(trashRecordFileId),
        skipped,
        failed,
      };
    });
  }

  async download(id: string, range?: string): Promise<DownloadResult> {
    const rel = idToRel(id);
    if (!rel)
      throw new StorageError("BAD_ID", "루트 폴더는 다운로드할 수 없습니다");
    const abs = await safeAbs(rel);
    let s;
    try {
      s = await stat(/* turbopackIgnore: true */ abs);
    } catch (e) {
      if (isNoEnt(e)) throw new StorageError("NOT_FOUND", "파일이 없습니다");
      throw e;
    }
    if (s.isDirectory())
      throw new StorageError("BAD_ID", "폴더는 다운로드할 수 없습니다");

    const name = path.basename(rel);
    // 개발용이지만 미리보기가 동작하도록 확장자로 mime을 추정한다.
    const mimeType = guessMime(name);

    // Range 파싱 — 형식이 어긋나면 무시하고 전체를 준다.
    const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
    if (match && (match[1] || match[2]) && s.size > 0) {
      let start = match[1] ? Number(match[1]) : s.size - Number(match[2]);
      let end = match[1] && match[2] ? Number(match[2]) : s.size - 1;
      start = Math.max(0, start);
      end = Math.min(end, s.size - 1);
      if (start <= end && start < s.size) {
        return {
          stream: Readable.toWeb(
            createReadStream(/* turbopackIgnore: true */ abs, { start, end }),
          ) as ReadableStream<Uint8Array>,
          name,
          size: s.size,
          mimeType,
          status: 206,
          contentRange: `bytes ${start}-${end}/${s.size}`,
          contentLength: end - start + 1,
        };
      }
    }
    return {
      stream: Readable.toWeb(
        createReadStream(/* turbopackIgnore: true */ abs),
      ) as ReadableStream<Uint8Array>,
      name,
      size: s.size,
      mimeType,
      status: 200,
      contentRange: null,
      contentLength: s.size,
    };
  }

  async preview(id: string, range?: string): Promise<DownloadResult> {
    const entry = await this.getEntry(id);
    if (!officePreviewImport(entry)) return this.download(id, range);

    return createOfficePreviewFallback({
      id,
      name: entry.name,
      reason:
        "로컬 저장소 모드에는 Office 문서를 PDF로 바꾸는 변환기가 없습니다.",
    });
  }

  async replaceContent(
    id: string,
    expectedVersion: string,
    mimeType: string,
    data: ReadableStream<Uint8Array>,
  ): Promise<Entry> {
    await this.ensureRoot();
    if (!expectedVersion || expectedVersion.length > 1024) {
      throw new StorageError("BAD_ID", "잘못된 파일 버전입니다");
    }
    if (!mimeType || mimeType.length > 255 || /[\r\n\0]/.test(mimeType)) {
      throw new StorageError("BAD_ID", "잘못된 파일 형식입니다");
    }
    const rel = idToRel(id);
    if (!rel) {
      throw new StorageError("BAD_ID", "루트 폴더는 수정할 수 없습니다");
    }
    await this.ensureStateDir();
    return withLocalMutationLock(async () => {
      const abs = await safeAbs(rel);
      let before: Stats;
      try {
        before = await stat(/* turbopackIgnore: true */ abs);
      } catch (error) {
        if (isNoEnt(error)) {
          throw new StorageError("NOT_FOUND", "파일이 없습니다");
        }
        throw error;
      }
      if (!before.isFile()) {
        throw new StorageError("BAD_ID", "파일이 아닙니다");
      }
      if (entryVersion(before) !== expectedVersion) {
        throw new StorageError("CONFLICT", "다른 사람이 먼저 파일을 수정했습니다");
      }

      const tempRel = joinRel(STATE_DIR, `.content-${randomUUID()}`);
      const tempAbs = await safeAbs(tempRel, true, true);
      try {
        await pipeline(
          Readable.fromWeb(data as import("node:stream/web").ReadableStream),
          createWriteStream(tempAbs, { flags: "wx" }),
        );
        // ShareDesk 밖에서 파일이 바뀌는 경우도 교체 직전에 다시 거른다.
        let current: Stats;
        try {
          current = await stat(/* turbopackIgnore: true */ abs);
        } catch (error) {
          if (isNoEnt(error)) {
            throw new StorageError(
              "CONFLICT",
              "다른 사람이 먼저 파일을 수정했습니다",
            );
          }
          throw error;
        }
        if (!current.isFile() || entryVersion(current) !== expectedVersion) {
          throw new StorageError(
            "CONFLICT",
            "다른 사람이 먼저 파일을 수정했습니다",
          );
        }
        await fsRename(tempAbs, abs);
      } finally {
        await rm(tempAbs, { force: true }).catch(() => {});
      }
      return toEntry(rel, path.basename(rel));
    });
  }

  async upload(
    parentId: string,
    name: string,
    _mimeType: string,
    data: ReadableStream<Uint8Array>,
  ): Promise<Entry> {
    await this.ensureRoot();
    const clean = assertUserName(name);
    const parentRel = idToRel(parentId);
    const childRel = joinRel(parentRel, clean);
    return withLocalMutationLock(async () => {
      const parentStat = await stat(
        /* turbopackIgnore: true */ await safeAbs(parentRel),
      ).catch(() => null);
      if (!parentStat?.isDirectory())
        throw new StorageError("NOT_FOUND", "상위 폴더가 없습니다");
      // 기존 파일을 말없이 덮어쓰지 않는다 (wx: 존재하면 EEXIST).
      const target = await safeAbs(childRel, true);
      try {
        await pipeline(
          Readable.fromWeb(data as import("node:stream/web").ReadableStream),
          createWriteStream(target, { flags: "wx" }),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === "EEXIST") throw conflictError();
        await rm(target, { force: true }).catch(() => undefined);
        throw e;
      }
      return toEntry(childRel, clean);
    });
  }

  async uploadTemporary(
    name: string,
    _mimeType: string,
    data: ReadableStream<Uint8Array>,
  ): Promise<Entry> {
    await this.ensureRoot();
    assertUserName(name);
    const temporaryName = `${TEMPORARY_FILE_PREFIX}${randomUUID()}`;
    return withLocalMutationLock(async () => {
      const target = await safeAbs(temporaryName, true);
      try {
        await pipeline(
          Readable.fromWeb(data as import("node:stream/web").ReadableStream),
          createWriteStream(target, { flags: "wx" }),
        );
      } catch (error) {
        await rm(target, { force: true }).catch(() => undefined);
        throw error;
      }
      return toEntry(temporaryName, temporaryName);
    });
  }

  async promoteTemporary(id: string, name: string): Promise<Entry> {
    const rel = idToRel(id);
    const clean = assertUserName(name);
    if (rel.includes("/") || !rel.startsWith(TEMPORARY_FILE_PREFIX)) {
      throw new StorageError("BAD_ID", "간이 링크 파일이 아닙니다");
    }
    return withLocalMutationLock(async () => {
      const target = await safeAbs(clean, true);
      if (await stat(/* turbopackIgnore: true */ target).catch(() => null)) {
        throw conflictError();
      }
      try {
        await fsRename(await safeAbs(rel), target);
      } catch (error) {
        if (isNoEnt(error)) {
          throw new StorageError("NOT_FOUND", "대상이 없습니다");
        }
        throw error;
      }
      return toEntry(clean, clean);
    });
  }

  async deleteTemporary(id: string): Promise<void> {
    const rel = idToRel(id);
    if (rel.includes("/") || !rel.startsWith(TEMPORARY_FILE_PREFIX)) {
      throw new StorageError("BAD_ID", "간이 링크 파일이 아닙니다");
    }
    await rm(await safeAbs(rel), { force: true });
  }

  async listTemporary(): Promise<Entry[]> {
    await this.ensureRoot();
    const items = await readdir(rootDir(), { withFileTypes: true });
    const entries = await Promise.all(
      items
        .filter((item) => item.name.startsWith(TEMPORARY_FILE_PREFIX))
        .map((item) => toEntry(item.name, item.name).catch(() => null)),
    );
    return entries.filter(
      (entry): entry is Entry => entry !== null && !entry.isFolder,
    );
  }

  async createUploadSession(): Promise<UploadSession> {
    return { mode: "proxy" };
  }

  async createTemporaryUploadSession(): Promise<UploadSession> {
    return { mode: "proxy" };
  }

  private async mutateLocalPermissions<T>(
    fn: (file: LocalPermissionFile) => T,
  ): Promise<T> {
    for (let attempt = 0; attempt <= 3; attempt++) {
      const before = await this.readStateVersioned<LocalPermissionFile>(
        LOCAL_PERMISSIONS_STATE,
      );
      const draft = normalizeLocalPermissions(before.value);
      const result = fn(draft);
      draft.rev += 1;
      try {
        await this.compareAndSwapState(
          LOCAL_PERMISSIONS_STATE,
          draft,
          before.version,
        );
        return result;
      } catch (error) {
        if (
          error instanceof StorageError &&
          error.code === "CONFLICT" &&
          attempt < 3
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new StorageError("CONFLICT", "공유 권한이 계속 변경되고 있습니다");
  }

  async createPermission(
    id: string,
    email: string,
    role: ShareRole,
  ): Promise<StoragePermission> {
    if (id === ROOT_ID) {
      throw new StorageError("BAD_ID", "루트 폴더 자체는 공유할 수 없습니다");
    }
    await this.getEntry(id);
    const permission: LocalPermission = {
      permissionId: randomUUID(),
      fileId: id,
      role,
      email,
    };
    await this.mutateLocalPermissions((file) => {
      if (
        file.permissions.some(
          (item) => item.fileId === id && item.email === email,
        )
      ) {
        throw new StorageError("CONFLICT", "이미 공유된 사용자입니다");
      }
      file.permissions.push(permission);
    });
    return { permissionId: permission.permissionId, role: permission.role };
  }

  async updatePermission(
    id: string,
    permissionId: string,
    role: ShareRole,
  ): Promise<StoragePermission> {
    if (id === ROOT_ID) {
      throw new StorageError("BAD_ID", "루트 폴더 자체는 공유할 수 없습니다");
    }
    await this.getEntry(id);
    await this.mutateLocalPermissions((file) => {
      const permission = file.permissions.find(
        (item) => item.fileId === id && item.permissionId === permissionId,
      );
      if (!permission) {
        throw new StorageError(
          "NOT_FOUND",
          "관리할 수 있는 직접 권한이 없습니다",
        );
      }
      permission.role = role;
    });
    return { permissionId, role };
  }

  async deletePermission(id: string, permissionId: string): Promise<void> {
    await this.getEntry(id);
    await this.mutateLocalPermissions((file) => {
      const index = file.permissions.findIndex(
        (item) => item.fileId === id && item.permissionId === permissionId,
      );
      if (index < 0) {
        throw new StorageError(
          "NOT_FOUND",
          "관리할 수 있는 직접 권한이 없습니다",
        );
      }
      file.permissions.splice(index, 1);
    });
  }

  async findPermissionByEmail(
    id: string,
    email: string,
  ): Promise<StoragePermission | null> {
    if (id === ROOT_ID) {
      throw new StorageError("BAD_ID", "루트 폴더 자체는 공유할 수 없습니다");
    }
    await this.getEntry(id);
    const state = await this.readStateVersioned<LocalPermissionFile>(
      LOCAL_PERMISSIONS_STATE,
    );
    const permission = normalizeLocalPermissions(state.value).permissions.find(
      (item) => item.fileId === id && item.email === email,
    );
    return permission
      ? { permissionId: permission.permissionId, role: permission.role }
      : null;
  }

  async deleteTrackedPermission(
    id: string,
    permissionId: string,
  ): Promise<void> {
    await this.mutateLocalPermissions((file) => {
      const index = file.permissions.findIndex(
        (item) => item.fileId === id && item.permissionId === permissionId,
      );
      if (index >= 0) file.permissions.splice(index, 1);
    });
  }

  private async stateRel(name: string): Promise<string> {
    await this.ensureRoot();
    return joinRel(STATE_DIR, assertValidName(name));
  }

  private async ensureStateDir(): Promise<void> {
    await this.ensureRoot();
    await mkdir(await safeAbs(STATE_DIR, true, true), { recursive: true });
    await safeAbs(STATE_DIR, false, true);
  }

  private async withStateLock<T>(
    name: string,
    task: () => Promise<T>,
  ): Promise<T> {
    await this.ensureStateDir();
    const lockName = `.lock-${createHash("sha256").update(name).digest("hex")}`;
    const lockAbs = await safeAbs(joinRel(STATE_DIR, lockName), true, true);
    let handle: Awaited<ReturnType<typeof open>> | null = null;

    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
      try {
        handle = await open(/* turbopackIgnore: true */ lockAbs, "wx");
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e;
        const lockStat = await stat(
          /* turbopackIgnore: true */ lockAbs,
        ).catch(() => null);
        if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          await rm(lockAbs, { force: true }).catch(() => {});
          continue;
        }
        await wait(Math.min(10 + attempt * 2, 50));
      }
    }

    if (!handle) {
      throw new StorageError("CONFLICT", "상태 파일이 사용 중입니다");
    }
    try {
      return await task();
    } finally {
      await handle.close();
      await rm(lockAbs, { force: true });
    }
  }

  private async writeStateAtomic(rel: string, value: unknown): Promise<string> {
    const text = JSON.stringify(value, null, 2);
    const tempName = `.tmp-${randomUUID()}`;
    const tempAbs = await safeAbs(joinRel(STATE_DIR, tempName), true, true);
    try {
      await writeFile(tempAbs, text, { encoding: "utf8", flag: "wx" });
      await fsRename(tempAbs, await safeAbs(rel, true, true));
    } finally {
      await rm(tempAbs, { force: true }).catch(() => {});
    }
    return stateVersion(text);
  }

  async readState<T>(name: string): Promise<T | null> {
    return (await this.readStateVersioned<T>(name)).value;
  }

  async readStateVersioned<T>(name: string): Promise<StateRead<T>> {
    // 로컬 파일은 읽기가 싸서 hint 최적화가 필요 없다.
    const rel = await this.stateRel(name);
    const abs = await safeAbs(rel, true, true);
    try {
      const text = await readFile(/* turbopackIgnore: true */ abs, "utf8");
      return { value: JSON.parse(text) as T, version: stateVersion(text) };
    } catch (e) {
      if (isNoEnt(e)) return { value: null, version: null };
      throw e;
    }
  }

  async writeState(name: string, value: unknown): Promise<void> {
    const rel = await this.stateRel(name);
    await this.withStateLock(name, () => this.writeStateAtomic(rel, value));
  }

  async compareAndSwapState(
    name: string,
    value: unknown,
    expectedVersion: string | null,
  ): Promise<string | null> {
    const rel = await this.stateRel(name);
    return this.withStateLock(name, async () => {
      const abs = await safeAbs(rel, true, true);
      let text: string | null;
      try {
        text = await readFile(/* turbopackIgnore: true */ abs, "utf8");
      } catch (e) {
        if (!isNoEnt(e)) throw e;
        text = null;
      }
      const currentVersion = text === null ? null : stateVersion(text);
      if (currentVersion !== expectedVersion) throw conflictError();
      return this.writeStateAtomic(rel, value);
    });
  }
}
