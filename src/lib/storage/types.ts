export const ROOT_ID = "root";
// 앱 내부 파일이 담기는 폴더. 탐색기 목록에서는 숨긴다.
export const STATE_DIR = ".sharedesk";

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
  // 앱 상태(사용자 명단 등)를 루트 폴더 안 숨김 경로에 JSON으로 보관한다.
  // 별도 DB를 두지 않고 저장소 자체를 쓰는 것이 이 제품의 전제다.
  readState<T>(path: string): Promise<T | null>;
  writeState(path: string, value: unknown): Promise<void>;
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
