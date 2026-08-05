export const ROOT_ID = "root";

export interface Entry {
  id: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  modifiedAt: string | null;
  mimeType: string | null;
}

export interface DownloadResult {
  stream: ReadableStream<Uint8Array>;
  name: string;
  size: number | null;
  mimeType: string;
}

export type UploadSession = { mode: "direct"; url: string } | { mode: "proxy" };

export type StorageErrorCode =
  | "NOT_FOUND"
  | "BAD_ID"
  | "BAD_NAME"
  | "CONFLICT"
  | "UPSTREAM";

export class StorageError extends Error {
  constructor(
    public code: StorageErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const INVALID_NAME_CHARS = new RegExp("[/\\\\\\u0000-\\u001f]");

export function assertValidName(name: string): string {
  const trimmed = name.trim();
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.length > 255 ||
    INVALID_NAME_CHARS.test(trimmed)
  ) {
    throw new StorageError("BAD_NAME", "사용할 수 없는 이름입니다");
  }
  return trimmed;
}

export interface StorageAdapter {
  list(folderId: string): Promise<Entry[]>;
  createFolder(parentId: string, name: string): Promise<Entry>;
  rename(id: string, name: string): Promise<Entry>;
  remove(id: string): Promise<void>;
  download(id: string): Promise<DownloadResult>;
  upload(
    parentId: string,
    name: string,
    mimeType: string,
    data: ReadableStream<Uint8Array>,
  ): Promise<Entry>;
  createUploadSession(
    parentId: string,
    name: string,
    mimeType: string,
    size: number,
    origin: string,
  ): Promise<UploadSession>;
}

// 두 어댑터가 같은 충돌 정책을 쓰도록 계약으로 못 박는다: 같은 폴더에 같은 이름이
// 이미 있으면 덮어쓰지 않고 CONFLICT로 거부한다 (mkdir·rename·upload 공통).
export function conflictError(): StorageError {
  return new StorageError("CONFLICT", "같은 이름이 이미 있습니다");
}
