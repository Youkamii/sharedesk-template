import { randomBytes } from "node:crypto";
import type { SessionInfo } from "@/lib/auth";
import { roleAtLeast, resolveUserRole, type UserRole } from "@/lib/roles";
import { getAdapter } from "@/lib/storage";
import { StorageError } from "@/lib/storage/types";
import { parseOptionalByteLimit } from "@/lib/users";

// 공개 폴더(#10)의 등록부. 외부인이 로그인 없이 주소만으로 들어와 파일을
// 받고 올리는 폴더를 관리자가 만들고 관리한다.
//
// - 등록부는 별도 상태 파일 public-folders.json 하나다(share-links·spaces
//   관례). users.json에 넣지 않는 이유: 구버전 mutate가 모르는 최상위
//   필드를 통째로 버려 다운그레이드 무손실이 아니다.
// - 대상 폴더는 기본 데스크 루트 직계이며 **등록이 항상 새 폴더를 만든다**
//   — 기존 폴더 지정은 없다. 그래서 공개 폴더 안에 하위 폴더가 존재한 적이
//   없고(생성 시점 평평 보장), 이후는 mkdir·move 가드가 지킨다.
// - local 어댑터의 폴더 id는 경로 기반이라 삭제 후 같은 이름을 다시 만들면
//   id가 재사용된다 — 옛 공개 주소가 새 폴더를 여는 탈취를 막으려고 등록
//   시점의 folderIdentity(Entry.layoutKey)를 저장하고 접근 때 대조한다
//   (desktop-layout의 FolderIdentityConflict와 같은 방어).
// - 공개 종료는 "접근 판정에서 닫힘"이다. 파일은 데스크에 남는 것이 스펙
//   이라 share-links 같은 삭제 청소가 없다.

const FILE = "public-folders.json";
const MAX_ATTEMPTS = 4;
export const MAX_PUBLIC_FOLDERS = 20;
export const MAX_PUBLIC_FOLDER_NAME_LENGTH = 40;
export const MAX_PUBLIC_FOLDER_FILES = 10_000;
const TOKEN_PATTERN = /^[a-f0-9]{48}$/;

export interface PublicFolder {
  // URL 토큰. /public/<id> 로 열린다 — 48자리 hex(share-links 규약).
  id: string;
  // 대상 폴더의 저장소 id (기본 데스크, 루트 직계).
  folderId: string;
  // 등록 시점 대상 폴더의 layoutKey — local의 경로 재사용 탈취를 걸러낸다.
  folderIdentity: string;
  // 표시 이름 = 폴더 이름.
  name: string;
  enabled: boolean;
  // 공개 시간. null이면 각각 즉시·무기한. 저장은 toISOString 정규화 값.
  opensAt: string | null;
  closesAt: string | null;
  // 폴더별 상한. null=무제한. 집행은 storage-quota.reserveUpload가 한다.
  maxTotalBytes: number | null;
  maxFileBytes: number | null;
  maxFiles: number | null;
  // 접근 제한(OR 판정): null이면 완전 공개(외부인 포함 누구나).
  // 설정하면 명단 멤버 중 (역할 ≥ minRole) OR (userIds 포함)만.
  minRole: UserRole | null;
  userIds: string[];
  createdAt: string;
  createdByUserId: string;
}

interface PublicFolderFile {
  version: 1;
  folders: PublicFolder[];
}

export function parsePublicFolderToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return TOKEN_PATTERN.test(value) ? value : null;
}

/** 표시 이름 검증 — 폴더 이름으로도 쓰이므로 어댑터 이름 규칙보다 좁게. */
export function parsePublicFolderName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > MAX_PUBLIC_FOLDER_NAME_LENGTH) return null;
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return null;
  }
  if (name.includes("/") || name.includes("\\")) return null;
  if (name.startsWith(".")) return null;
  return name;
}

/** 파일 개수 상한 파싱. null=무제한, undefined=잘못된 값. */
export function parsePublicFolderFileLimit(
  value: unknown,
): number | null | undefined {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) return undefined;
  const count = value as number;
  if (count < 1 || count > MAX_PUBLIC_FOLDER_FILES) return undefined;
  return count;
}

/** 공개 시각 파싱 — 유한한 시각만, toISOString으로 정규화. */
export function parsePublicFolderTime(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  return new Date(parsed).toISOString();
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

// 손으로 고쳐졌거나 옛 버전일 수 있다. 형태가 어긋난 레코드는 버리되,
// 선택 필드는 관대하게 기본값으로 정규화한다(시각 파싱 불가 → null 등).
function normalize(value: unknown): PublicFolderFile {
  const raw = value as Partial<PublicFolderFile> | null;
  const folders: PublicFolder[] = [];
  const seen = new Set<string>();
  if (raw && Array.isArray(raw.folders)) {
    for (const item of raw.folders) {
      const candidate = item as Partial<PublicFolder> | null;
      if (!candidate) continue;
      if (
        typeof candidate.id !== "string" ||
        !TOKEN_PATTERN.test(candidate.id) ||
        seen.has(candidate.id)
      ) {
        continue;
      }
      if (typeof candidate.folderId !== "string" || !candidate.folderId) continue;
      if (typeof candidate.folderIdentity !== "string") continue;
      const name = parsePublicFolderName(candidate.name);
      if (!name) continue;
      if (typeof candidate.createdByUserId !== "string") continue;
      if (
        typeof candidate.createdAt !== "string" ||
        !Number.isFinite(Date.parse(candidate.createdAt))
      ) {
        continue;
      }
      const bytes = (input: unknown): number | null => {
        const parsed = parseOptionalByteLimit(input);
        return parsed === undefined ? null : parsed;
      };
      const files = parsePublicFolderFileLimit(candidate.maxFiles);
      seen.add(candidate.id);
      folders.push({
        id: candidate.id,
        folderId: candidate.folderId,
        folderIdentity: candidate.folderIdentity,
        name,
        enabled: candidate.enabled === true,
        opensAt: isoOrNull(candidate.opensAt),
        closesAt: isoOrNull(candidate.closesAt),
        maxTotalBytes: bytes(candidate.maxTotalBytes),
        maxFileBytes: bytes(candidate.maxFileBytes),
        maxFiles: files === undefined ? null : files,
        minRole:
          candidate.minRole == null
            ? null
            : resolveUserRole(candidate.minRole),
        userIds: Array.isArray(candidate.userIds)
          ? candidate.userIds.filter(
              (id): id is string => typeof id === "string" && id.length > 0,
            )
          : [],
        createdAt: candidate.createdAt,
        createdByUserId: candidate.createdByUserId,
      });
    }
  }
  return { version: 1, folders };
}

async function mutate<T>(
  change: (file: PublicFolderFile) => { file: PublicFolderFile; result: T },
): Promise<T> {
  const adapter = getAdapter();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const state = await adapter.readStateVersioned<PublicFolderFile>(FILE);
    const changed = change(normalize(state.value));
    try {
      await adapter.compareAndSwapState(FILE, changed.file, state.version);
      return changed.result;
    } catch (error) {
      lastError = error;
      if (!(error instanceof StorageError) || error.code !== "CONFLICT") {
        throw error;
      }
    }
  }
  throw lastError;
}

export async function listPublicFolders(): Promise<PublicFolder[]> {
  const state = await getAdapter().readState<PublicFolderFile>(FILE);
  return normalize(state).folders;
}

export async function getPublicFolder(
  token: string,
): Promise<PublicFolder | null> {
  const parsed = parsePublicFolderToken(token);
  if (!parsed) return null;
  const folders = await listPublicFolders();
  return folders.find((folder) => folder.id === parsed) ?? null;
}

/** 저장소 폴더 id로 등록을 찾는다 — 업로드 상한 집행(storage-quota)용. */
export async function findPublicFolderByFolderId(
  folderId: string,
): Promise<PublicFolder | null> {
  if (!folderId) return null;
  const folders = await listPublicFolders();
  return folders.find((folder) => folder.folderId === folderId) ?? null;
}

/**
 * mkdir·move·rename 가드용 — folderId가 공개 폴더로 등록돼 있는가.
 * 주의: 등록부는 기본 데스크 전용이다. local 어댑터의 폴더 id는 상대경로
 * 기반이라 스페이스의 같은 이름 폴더와 문자열이 겹칠 수 있으므로, 호출자는
 * 반드시 기본 데스크 문맥(러너의 space === null)에서만 이 판정을 쓴다.
 */
export async function isRegisteredPublicFolder(
  folderId: string,
): Promise<boolean> {
  if (!folderId) return false;
  const folders = await listPublicFolders();
  return folders.some((folder) => folder.folderId === folderId);
}

// 공개 시각 교차 불변식 — 라우트(400)와 여기(throw) 이중 검증 관례.
function assertTimeOrder(
  opensAt: string | null,
  closesAt: string | null,
): void {
  if (
    opensAt !== null &&
    closesAt !== null &&
    Date.parse(opensAt) >= Date.parse(closesAt)
  ) {
    throw new StorageError(
      "BAD_ID",
      "공개 종료 시각은 시작 시각보다 뒤여야 합니다",
    );
  }
}

export async function addPublicFolder(input: {
  folderId: string;
  folderIdentity: string;
  name: string;
  createdByUserId: string;
  enabled?: boolean;
  opensAt?: string | null;
  closesAt?: string | null;
  maxTotalBytes?: number | null;
  maxFileBytes?: number | null;
  maxFiles?: number | null;
  minRole?: UserRole | null;
  userIds?: string[];
}): Promise<PublicFolder> {
  const name = parsePublicFolderName(input.name);
  if (!name) {
    throw new StorageError("BAD_NAME", "공개 폴더 이름을 확인해 주세요");
  }
  const opensAt = input.opensAt ?? null;
  const closesAt = input.closesAt ?? null;
  assertTimeOrder(opensAt, closesAt);
  const folder: PublicFolder = {
    id: randomBytes(24).toString("hex"),
    folderId: input.folderId,
    folderIdentity: input.folderIdentity,
    name,
    enabled: input.enabled !== false,
    opensAt,
    closesAt,
    maxTotalBytes: input.maxTotalBytes ?? null,
    maxFileBytes: input.maxFileBytes ?? null,
    maxFiles: input.maxFiles ?? null,
    minRole: input.minRole ?? null,
    userIds: input.userIds ?? [],
    createdAt: new Date().toISOString(),
    createdByUserId: input.createdByUserId,
  };
  return mutate((file) => {
    if (file.folders.length >= MAX_PUBLIC_FOLDERS) {
      throw new StorageError("CONFLICT", "공개 폴더가 너무 많습니다");
    }
    if (file.folders.some((existing) => existing.folderId === folder.folderId)) {
      throw new StorageError("CONFLICT", "이미 공개 폴더로 등록된 폴더입니다");
    }
    return {
      file: { version: 1, folders: [...file.folders, folder] },
      result: folder,
    };
  });
}

export type PublicFolderPatch = Partial<
  Pick<
    PublicFolder,
    | "name"
    | "enabled"
    | "opensAt"
    | "closesAt"
    | "maxTotalBytes"
    | "maxFileBytes"
    | "maxFiles"
    | "minRole"
    | "userIds"
  >
>;

export async function updatePublicFolder(
  id: string,
  patch: PublicFolderPatch,
): Promise<PublicFolder | null> {
  const parsed = parsePublicFolderToken(id);
  if (!parsed) return null;
  return mutate((file) => {
    const target = file.folders.find((folder) => folder.id === parsed);
    if (!target) return { file, result: null };
    const updated: PublicFolder = { ...target, ...patch };
    assertTimeOrder(updated.opensAt, updated.closesAt);
    return {
      file: {
        version: 1,
        folders: file.folders.map((folder) =>
          folder.id === parsed ? updated : folder,
        ),
      },
      result: updated,
    };
  });
}

/** 등록만 해제한다. 폴더·파일은 데스크에 남는다(spaces 관례). */
export async function removePublicFolder(id: string): Promise<boolean> {
  const parsed = parsePublicFolderToken(id);
  if (!parsed) return false;
  return mutate((file) => {
    const remaining = file.folders.filter((folder) => folder.id !== parsed);
    return {
      file: { version: 1, folders: remaining },
      result: remaining.length !== file.folders.length,
    };
  });
}

/**
 * 접근 판정 (#10). 닫힘 사유는 구분하지 않는다 — 라우트·페이지는 전부
 * 같은 404로 접는다(존재 비노출 관례).
 *
 * - enabled·공개 시간(opensAt <= now < closesAt)을 먼저 본다.
 * - minRole이 null이면 완전 공개 — 비로그인 외부인 포함 누구나.
 * - minRole이 설정되면 "명단 멤버" 제한 공개: 관리자는 통과, 손님(접속
 *   키)은 명단에 없으므로 거부, 그 외에는 (역할 ≥ minRole) OR (userIds
 *   포함) — 요구사항의 "역할 최소선 + 개인 지정 둘 다, OR 판정".
 */
export function publicFolderAccess(
  folder: Pick<
    PublicFolder,
    "enabled" | "opensAt" | "closesAt" | "minRole" | "userIds"
  >,
  session: Pick<SessionInfo, "userId" | "role" | "isAdmin" | "isGuest"> | null,
  now: Date = new Date(),
): "open" | "closed" {
  if (!folder.enabled) return "closed";
  const time = now.getTime();
  if (folder.opensAt !== null && time < Date.parse(folder.opensAt)) {
    return "closed";
  }
  if (folder.closesAt !== null && time >= Date.parse(folder.closesAt)) {
    return "closed";
  }
  if (folder.minRole === null) return "open";
  if (!session) return "closed";
  if (session.isAdmin) return "open";
  if (session.isGuest) return "closed";
  if (roleAtLeast(session.role, folder.minRole)) return "open";
  if (folder.userIds.includes(session.userId)) return "open";
  return "closed";
}
