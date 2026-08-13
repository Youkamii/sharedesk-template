import { createHash } from "node:crypto";
import { getAdapter } from "@/lib/storage";
import {
  type Entry,
  type StorageAdapter,
  StorageError,
} from "@/lib/storage/types";

const FILE_VERSION = 1;
const MAX_FOLDER_ID_LENGTH = 1024;
export const MAX_FOLDER_NOTE_BYTES = 100 * 1024;

interface FolderNoteFile {
  version: 1;
  folderKey: string;
  content: string;
}

export interface FolderNoteSnapshot {
  content: string;
  version: string | null;
}

function assertFolderId(folderId: string): void {
  if (!folderId || folderId.length > MAX_FOLDER_ID_LENGTH) {
    throw new StorageError("BAD_ID", "잘못된 폴더 id입니다");
  }
}

function assertFolder(entry: Entry): void {
  if (!entry.isFolder) {
    throw new StorageError("BAD_ID", "폴더가 아닙니다");
  }
}

function assertContent(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_FOLDER_NOTE_BYTES) {
    throw new StorageError("BAD_ID", "폴더 메모는 100 KiB까지 저장할 수 있습니다");
  }
}

function assertExpectedVersion(expectedVersion: string | null): void {
  if (
    expectedVersion !== null &&
    (!expectedVersion || expectedVersion.length > 1024)
  ) {
    throw new StorageError("BAD_ID", "잘못된 메모 버전입니다");
  }
}

function stateFileName(folderKey: string): string {
  const hash = createHash("sha256").update(folderKey).digest("hex");
  return `folder-note-${hash.slice(0, 32)}.json`;
}

function normalize(raw: unknown, folderKey: string): FolderNoteFile | null {
  if (raw === null) return null;
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    (raw as Partial<FolderNoteFile>).version !== FILE_VERSION ||
    (raw as Partial<FolderNoteFile>).folderKey !== folderKey ||
    typeof (raw as Partial<FolderNoteFile>).content !== "string"
  ) {
    throw new StorageError("UPSTREAM", "폴더 메모 상태가 손상되었습니다");
  }
  const file = raw as FolderNoteFile;
  if (Buffer.byteLength(file.content, "utf8") > MAX_FOLDER_NOTE_BYTES) {
    throw new StorageError("UPSTREAM", "폴더 메모 상태가 손상되었습니다");
  }
  return file;
}

async function verifiedFolder(
  adapter: StorageAdapter,
  folderId: string,
): Promise<Entry> {
  assertFolderId(folderId);
  const folder = await adapter.getEntry(folderId);
  assertFolder(folder);
  return folder;
}

export async function getFolderNote(
  folderId: string,
  adapter: StorageAdapter = getAdapter(),
): Promise<FolderNoteSnapshot> {
  const folder = await verifiedFolder(adapter, folderId);
  const stored = await adapter.readStateVersioned<unknown>(
    stateFileName(folder.layoutKey),
  );
  const file = normalize(stored.value, folder.layoutKey);
  return { content: file?.content ?? "", version: stored.version };
}

export async function updateFolderNote(
  folderId: string,
  content: string,
  expectedVersion: string | null,
  adapter: StorageAdapter = getAdapter(),
): Promise<FolderNoteSnapshot> {
  assertContent(content);
  assertExpectedVersion(expectedVersion);
  const folder = await verifiedFolder(adapter, folderId);
  const name = stateFileName(folder.layoutKey);
  const before = await adapter.readStateVersioned<unknown>(name);
  normalize(before.value, folder.layoutKey);
  if (before.version !== expectedVersion) {
    throw new StorageError("CONFLICT", "다른 사람이 먼저 폴더 메모를 수정했습니다");
  }

  let version: string | null;
  try {
    version = await adapter.compareAndSwapState(
      name,
      { version: FILE_VERSION, folderKey: folder.layoutKey, content },
      expectedVersion,
    );
  } catch (error) {
    if (error instanceof StorageError && error.code === "CONFLICT") {
      throw new StorageError(
        "CONFLICT",
        "다른 사람이 먼저 폴더 메모를 수정했습니다",
      );
    }
    throw error;
  }

  // 구현체가 쓰기 응답에서 새 버전을 주지 못하면 한 번 읽어 다음 CAS에 쓸 값을 확보한다.
  if (version === null) {
    version = (await adapter.readStateVersioned<unknown>(name)).version;
  }
  if (version === null) {
    throw new StorageError("UPSTREAM", "폴더 메모 버전을 확인하지 못했습니다");
  }
  return { content, version };
}
