export const ROOT_ID = "root";
// 앱 내부 파일이 담기는 폴더. 탐색기 목록에서는 숨긴다.
export const STATE_DIR = ".sharedesk";
export const TEMPORARY_FILE_PREFIX = ".sharedesk-quick-";

export interface Entry {
  id: string;
  layoutKey: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  modifiedAt: string | null;
  mimeType: string | null;
  // 낙관적 동시성용 불투명 버전 (drive: v2 ETag, local: 파일 identity+mtime).
  // 이동처럼 "내가 본 상태"를 전제로 하는 변경은 이 값을 함께 보내고,
  // 그 사이 남이 바꿨으면 CONFLICT로 거부된다. 목록에만 채워질 수 있다(null 허용).
  version: string | null;
}

export interface TrashEntry extends Entry {
  version: string;
  trashedAt: string | null;
}

export interface TrashDeleteTarget {
  id: string;
  version: string;
}

export interface EmptyTrashResult {
  fileIds: string[];
  skipped: number;
  failed: number;
}

export interface DownloadResult {
  stream: ReadableStream<Uint8Array>;
  name: string;
  // 파일 전체 크기 (모를 수 있음). Range 응답이어도 전체 크기다.
  size: number | null;
  mimeType: string;
  // Range 요청을 저장소가 수용했으면 206과 함께 채워진다.
  status: 200 | 206;
  contentRange: string | null;
  contentLength: number | null;
  acceptRanges?: boolean;
  // 저장소가 직접 만든 안전한 미리보기 문서만 라우트에서 HTML로 내보낸다.
  generatedPreview?: "office-fallback";
}

export type UploadSession =
  | { mode: "direct"; url: string; reservationId?: string }
  | { mode: "proxy"; reservationId?: string };

export interface StorageUsage {
  deskUsedBytes: number;
  hostUsedBytes: number | null;
  hostLimitBytes: number | null;
}

export type ShareRole = "reader" | "writer";

export interface StoragePermission {
  permissionId: string;
  role: ShareRole;
}

export interface CreatePermissionOptions {
  sendNotificationEmail?: boolean;
}

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

// 사용자가 직접 넣는 이름에 적용한다. 점으로 시작하는 이름은 앱 내부 영역(.sharedesk)과
// 같은 공간을 쓰므로 금지한다 — 선점으로 내부 폴더를 가로채는 것을 막는다.
export function assertUserName(name: string): string {
  const clean = assertValidName(name);
  if (clean.startsWith(".")) {
    throw new StorageError(
      "BAD_NAME",
      "점(.)으로 시작하는 이름은 사용할 수 없습니다",
    );
  }
  return clean;
}

export function stateAccessDenied(): StorageError {
  // 존재 자체를 알리지 않도록 없는 것처럼 응답한다.
  return new StorageError("NOT_FOUND", "대상이 없습니다");
}

export interface StorageAdapter {
  getEntry(id: string): Promise<Entry>;
  list(folderId: string): Promise<Entry[]>;
  // 앱 상태(사용자 명단 등)를 루트 폴더 안 숨김 경로에 JSON으로 보관한다.
  // 별도 DB를 두지 않고 저장소 자체를 쓰는 것이 이 제품의 전제다.
  readState<T>(path: string): Promise<T | null>;
  // hint: 호출자가 마지막으로 본 버전+값. 저장소가 버전만 확인해 값이 그대로면
  // 본문 전송을 생략할 수 있다 (drive: ETag만 조회 — 왕복 1회·~1초 절약).
  readStateVersioned<T>(
    path: string,
    hint?: { version: string; value: T },
  ): Promise<StateRead<T>>;
  writeState(path: string, value: unknown): Promise<void>;
  // expectedVersion이 null이면 파일이 아직 없어야 한다. 버전이 다르면 CONFLICT를 던진다.
  // 성공 시 새 버전을 돌려준다 (모르면 null) — 호출자가 재읽기 없이 캐시를 잇는다.
  compareAndSwapState(
    path: string,
    value: unknown,
    expectedVersion: string | null,
  ): Promise<string | null>;
  createFolder(parentId: string, name: string): Promise<Entry>;
  // 마지막으로 본 버전일 때만 이름을 바꾼다. 이름 변경과 본문 저장이
  // 엇갈려도 새 버전을 오래된 초안의 저장 기준으로 잘못 쓰지 않는다.
  rename(id: string, name: string, expectedVersion: string): Promise<Entry>;
  // 대상을 다른 폴더로 옮긴다. expectedVersion은 호출자가 마지막으로 본 버전 —
  // 그 사이 누가 대상을 옮기거나 바꿨으면 CONFLICT를 던진다 (늦은 쪽 명시 거부).
  move(id: string, targetFolderId: string, expectedVersion: string): Promise<Entry>;
  remove(id: string): Promise<void>;
  // 휴지통 — remove()가 보낸 항목을 열람·복원·완전삭제한다. 30일 경과 자동
  // 완전삭제는 드라이브 휴지통의 기본 정책이며 local 어댑터도 같은 계약을 따른다.
  listTrash(): Promise<TrashEntry[]>;
  restore(id: string): Promise<Entry>;
  // 완전 삭제는 목록에서 본 버전을 반드시 함께 보내야 한다. 그 사이 같은
  // 항목이 복원·변경·재삭제되면 오래된 요청을 CONFLICT로 거부한다.
  // 반환값은 공유 장부 정리에 쓸 삭제 전 파일 id다.
  purge(id: string, expectedVersion: string): Promise<string>;
  emptyTrash(targets: TrashDeleteTarget[]): Promise<EmptyTrashResult>;
  // range는 HTTP Range 헤더 원문 (동영상 탐색용). 지원 못 하면 전체를 준다.
  download(id: string, range?: string): Promise<DownloadResult>;
  // 브라우저 미리보기용 응답. 일반 미디어는 download와 같고, 문서 형식은 구현체가
  // 브라우저에서 안전하게 볼 수 있는 형식으로 변환하거나 명확한 안내문을 돌려준다.
  preview(id: string, range?: string): Promise<DownloadResult>;
  // 마지막으로 본 버전일 때만 기존 파일 본문을 통째로 바꾼다.
  // 폴더와 루트, 저장소 경계 밖 대상은 구현체가 직접 거부한다.
  replaceContent(
    id: string,
    expectedVersion: string,
    mimeType: string,
    data: ReadableStream<Uint8Array>,
  ): Promise<Entry>;
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
  // 데스크 루트 아래 숨김 파일과 휴지통까지 포함한 실제 사용량, 그리고
  // 저장소 계정 전체 사용량/한도다. 업로드 제한은 화면이 아니라 서버에서
  // 이 값을 기준으로 집행한다.
  getStorageUsage(): Promise<StorageUsage>;
  // 간이 링크 파일은 루트에 숨겨 둔 뒤, 사용자가 자동 삭제를 풀 때만
  // 원래 이름으로 바탕화면에 올린다.
  createTemporaryUploadSession(
    name: string,
    mimeType: string,
    size: number,
    origin: string,
  ): Promise<UploadSession>;
  uploadTemporary(
    name: string,
    mimeType: string,
    data: ReadableStream<Uint8Array>,
  ): Promise<Entry>;
  promoteTemporary(id: string, name: string): Promise<Entry>;
  deleteTemporary(id: string): Promise<void>;
  // 공개 폴더 링크에서 다른 데스크 항목 id를 끼워 넣지 못하게 공유
  // 폴더의 자손인지 저장소 경계에서 확인한다.
  isWithin(id: string, ancestorId: string): Promise<boolean>;
  // 직접 업로드 완료 요청이 발급된 대상 폴더의 파일을 가리키는지 확인한다.
  isDirectChild(id: string, parentId: string): Promise<boolean>;
  createPermission(
    id: string,
    email: string,
    role: ShareRole,
    options?: CreatePermissionOptions,
  ): Promise<StoragePermission>;
  updatePermission(
    id: string,
    permissionId: string,
    role: ShareRole,
  ): Promise<StoragePermission>;
  deletePermission(id: string, permissionId: string): Promise<void>;
  findPermissionByEmail?(
    id: string,
    email: string,
  ): Promise<StoragePermission | null>;
  // ShareDesk 장부에 기록된 정확한 permissionId만 회수한다. 파일이 휴지통에
  // 있거나 이미 사라져도 성공으로 끝내며, 이메일 추정 삭제는 허용하지 않는다.
  deleteTrackedPermission?(id: string, permissionId: string): Promise<void>;
}

export interface StateRead<T> {
  value: T | null;
  // 저장소 구현이 발급하는 불투명 버전이다. null은 파일이 없다는 뜻이다.
  version: string | null;
}

// 두 어댑터가 같은 충돌 정책을 쓰도록 계약으로 못 박는다: 같은 폴더에 같은 이름이
// 이미 있으면 덮어쓰지 않고 CONFLICT로 거부한다 (mkdir·rename·upload 공통).
export function conflictError(): StorageError {
  return new StorageError("CONFLICT", "같은 이름이 이미 있습니다");
}
