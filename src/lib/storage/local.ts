import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import {
  DownloadResult,
  Entry,
  ROOT_ID,
  STATE_DIR,
  StorageAdapter,
  StorageError,
  UploadSession,
  assertUserName,
  assertValidName,
  conflictError,
  stateAccessDenied,
} from "./types";

// 개발·검증용 어댑터 — 로컬 폴더를 드라이브처럼 취급한다.
// id는 루트 기준 상대경로의 base64url. 경로 탈출(..)은 디코드 직후 차단한다.

function rootDir(): string {
  return path.resolve(
    process.cwd(),
    process.env.LOCAL_STORAGE_ROOT || ".devstorage",
  );
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
  // 로컬 id는 경로의 base64url이라 누구나 계산할 수 있다. 앱 내부 영역(.sharedesk)은
  // 파일 API로 열람·수정·삭제할 수 없어야 한다 — 명단이 곧 접근 권한이기 때문이다.
  if (segments[0] === STATE_DIR) {
    throw stateAccessDenied();
  }
  return rel;
}

function relToId(rel: string): string {
  return rel ? Buffer.from(rel, "utf8").toString("base64url") : ROOT_ID;
}

function absOf(rel: string): string {
  const root = rootDir();
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new StorageError("BAD_ID", "잘못된 경로입니다");
  }
  return abs;
}

function joinRel(parentRel: string, name: string): string {
  return parentRel ? `${parentRel}/${name}` : name;
}

async function toEntry(rel: string, name: string): Promise<Entry> {
  const s = await stat(absOf(rel));
  return {
    id: relToId(rel),
    name,
    isFolder: s.isDirectory(),
    size: s.isDirectory() ? null : s.size,
    modifiedAt: s.mtime.toISOString(),
    mimeType: null,
  };
}

function isNoEnt(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

export class LocalAdapter implements StorageAdapter {
  private async ensureRoot(): Promise<void> {
    await mkdir(rootDir(), { recursive: true });
  }

  async list(folderId: string): Promise<Entry[]> {
    await this.ensureRoot();
    const rel = idToRel(folderId);
    let items;
    try {
      items = await readdir(absOf(rel), { withFileTypes: true });
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

  async createFolder(parentId: string, name: string): Promise<Entry> {
    await this.ensureRoot();
    const clean = assertUserName(name);
    const childRel = joinRel(idToRel(parentId), clean);
    try {
      await mkdir(absOf(childRel));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST") throw conflictError();
      if (code === "ENOENT")
        throw new StorageError("NOT_FOUND", "상위 폴더가 없습니다");
      throw e;
    }
    return toEntry(childRel, clean);
  }

  async rename(id: string, name: string): Promise<Entry> {
    const clean = assertUserName(name);
    const rel = idToRel(id);
    if (!rel)
      throw new StorageError("BAD_ID", "루트 폴더는 이름을 바꿀 수 없습니다");
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const newRel = joinRel(dir, clean);
    // fsRename은 목적지를 말없이 덮어쓴다. 이름만 바꾸는 경우(대소문자 변경 등)를
    // 제외하고 목적지가 이미 있으면 거부한다.
    if (newRel !== rel && (await stat(absOf(newRel)).catch(() => null))) {
      throw conflictError();
    }
    try {
      await fsRename(absOf(rel), absOf(newRel));
    } catch (e) {
      if (isNoEnt(e)) throw new StorageError("NOT_FOUND", "대상이 없습니다");
      throw e;
    }
    return toEntry(newRel, clean);
  }

  async remove(id: string): Promise<void> {
    const rel = idToRel(id);
    if (!rel) throw new StorageError("BAD_ID", "루트 폴더는 삭제할 수 없습니다");
    try {
      await rm(absOf(rel), { recursive: true });
    } catch (e) {
      if (isNoEnt(e)) throw new StorageError("NOT_FOUND", "대상이 없습니다");
      throw e;
    }
  }

  async download(id: string): Promise<DownloadResult> {
    const rel = idToRel(id);
    if (!rel)
      throw new StorageError("BAD_ID", "루트 폴더는 다운로드할 수 없습니다");
    const abs = absOf(rel);
    let s;
    try {
      s = await stat(abs);
    } catch (e) {
      if (isNoEnt(e)) throw new StorageError("NOT_FOUND", "파일이 없습니다");
      throw e;
    }
    if (s.isDirectory())
      throw new StorageError("BAD_ID", "폴더는 다운로드할 수 없습니다");
    return {
      stream: Readable.toWeb(
        createReadStream(abs),
      ) as ReadableStream<Uint8Array>,
      name: path.basename(rel),
      size: s.size,
      mimeType: "application/octet-stream",
    };
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
    const parentStat = await stat(absOf(parentRel)).catch(() => null);
    if (!parentStat?.isDirectory())
      throw new StorageError("NOT_FOUND", "상위 폴더가 없습니다");
    const childRel = joinRel(parentRel, clean);
    // 기존 파일을 말없이 덮어쓰지 않는다 (wx: 존재하면 EEXIST).
    try {
      await pipeline(
        Readable.fromWeb(data as import("node:stream/web").ReadableStream),
        createWriteStream(absOf(childRel), { flags: "wx" }),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") throw conflictError();
      throw e;
    }
    return toEntry(childRel, clean);
  }

  async createUploadSession(): Promise<UploadSession> {
    return { mode: "proxy" };
  }

  async readState<T>(name: string): Promise<T | null> {
    const abs = absOf(joinRel(STATE_DIR, assertValidName(name)));
    try {
      return JSON.parse(await readFile(abs, "utf8")) as T;
    } catch (e) {
      if (isNoEnt(e)) return null;
      throw e;
    }
  }

  async writeState(name: string, value: unknown): Promise<void> {
    const rel = joinRel(STATE_DIR, assertValidName(name));
    await mkdir(absOf(STATE_DIR), { recursive: true });
    // 쓰다 죽어도 반쪽 파일이 남지 않도록 임시 파일에 쓰고 교체한다.
    const tmp = absOf(rel + ".tmp");
    await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fsRename(tmp, absOf(rel));
  }
}
