import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename as fsRename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import {
  DownloadResult,
  Entry,
  ROOT_ID,
  StorageAdapter,
  StorageError,
  UploadSession,
  assertValidName,
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
  if (
    !rel ||
    rel.includes("\\") ||
    rel.split("/").some((seg) => !seg || seg === "." || seg === "..")
  ) {
    throw new StorageError("BAD_ID", "잘못된 id입니다");
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
      throw e;
    }
    const entries = await Promise.all(
      items.map((d) => toEntry(joinRel(rel, d.name), d.name)),
    );
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
    const clean = assertValidName(name);
    const childRel = joinRel(idToRel(parentId), clean);
    try {
      await mkdir(absOf(childRel));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "EEXIST")
        throw new StorageError("CONFLICT", "같은 이름이 이미 있습니다");
      if (code === "ENOENT")
        throw new StorageError("NOT_FOUND", "상위 폴더가 없습니다");
      throw e;
    }
    return toEntry(childRel, clean);
  }

  async rename(id: string, name: string): Promise<Entry> {
    const clean = assertValidName(name);
    const rel = idToRel(id);
    if (!rel)
      throw new StorageError("BAD_ID", "루트 폴더는 이름을 바꿀 수 없습니다");
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const newRel = joinRel(dir, clean);
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
    const clean = assertValidName(name);
    const parentRel = idToRel(parentId);
    const parentStat = await stat(absOf(parentRel)).catch(() => null);
    if (!parentStat?.isDirectory())
      throw new StorageError("NOT_FOUND", "상위 폴더가 없습니다");
    const childRel = joinRel(parentRel, clean);
    await pipeline(
      Readable.fromWeb(data as import("node:stream/web").ReadableStream),
      createWriteStream(absOf(childRel)),
    );
    return toEntry(childRel, clean);
  }

  async createUploadSession(): Promise<UploadSession> {
    return { mode: "proxy" };
  }
}
