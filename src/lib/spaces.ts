import { getAdapter } from "@/lib/storage";
import { StorageError } from "@/lib/storage/types";

// 멀티 데스크(#12)의 등록부. 한 설치 주소 안에 데스크(스페이스)를 여러 개 두고
// URL 첫 세그먼트로 가른다 — /A/files 는 A 스페이스의 바탕화면이다.
//
// 등록부는 설치 루트의 .sharedesk/spaces.json 하나뿐이고, 각 스페이스의 실체는
// 루트 아래 자기 폴더 + 그 안의 .sharedesk 한 벌이다. 기존 단일 데스크는
// 마이그레이션으로 첫 스페이스가 된다 — 그 스페이스의 folderId가 null이면
// "설치 루트 그 자체"라는 뜻이다. 기존 설치가 깨지면 안 된다.

const FILE = "spaces.json";
const MAX_ATTEMPTS = 4;
export const MAX_SPACES = 50;
export const MAX_SPACE_NAME_LENGTH = 40;

// URL 첫 세그먼트가 슬러그다. 기존 최상위 경로·공개 자산과 절대 겹치면 안 된다 —
// 겹치면 그 스페이스가 앱 화면을 가린다. 새 최상위 라우트를 만들면 여기에도
// 추가해야 한다 (tests/spaces.test.ts가 src/app 실물과 대조해 지킨다).
export const RESERVED_SLUGS = new Set([
  // src/app 최상위 라우트
  "admin",
  "api",
  "files",
  "join",
  "pending",
  // public/ 자산과 프레임워크 경로
  "art",
  "fonts",
  "favicon.ico",
  "_next",
  // 스페이스 기능 자신과 헷갈릴 이름들
  "space",
  "spaces",
  "desk",
  "login",
  "logout",
  "public",
  "static",
  "assets",
]);

// 소문자 영숫자와 하이픈, 1~32자, 하이픈으로 시작·끝 불가.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/**
 * URL 세그먼트를 스페이스 슬러그로 판정한다. 대문자는 소문자로 접는다 —
 * 사용자는 /A/files 처럼 대문자로 적지만 같은 스페이스여야 한다.
 * 형태가 어긋나거나 예약어면 null.
 */
export function parseSpaceSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase();
  if (!SLUG_PATTERN.test(slug)) return null;
  if (RESERVED_SLUGS.has(slug)) return null;
  return slug;
}

/** 스페이스 표시 이름. 비거나 지나치게 길면 null. */
export function parseSpaceName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > MAX_SPACE_NAME_LENGTH) return null;
  // 제어문자는 화면·로그를 깨뜨린다.
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return name;
}

export interface Space {
  slug: string;
  name: string;
  // 이 스페이스의 저장소 루트 폴더 id. null이면 설치 루트 그 자체다 —
  // 마이그레이션된 기존 데스크가 여기 해당한다.
  folderId: string | null;
  createdAt: string;
  createdByUserId: string;
}

interface SpacesFile {
  version: 1;
  spaces: Space[];
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

// 저장 파일은 손으로 고쳐졌거나 옛 버전일 수 있다. 형태가 어긋난 항목은
// 조용히 버린다 — 등록부가 통째로 죽는 것보다 낫다.
function normalize(value: unknown): SpacesFile {
  const raw = value as Partial<SpacesFile> | null;
  const spaces: Space[] = [];
  const seen = new Set<string>();
  if (raw && Array.isArray(raw.spaces)) {
    for (const item of raw.spaces) {
      const candidate = item as Partial<Space>;
      const slug = parseSpaceSlug(candidate.slug);
      const name = parseSpaceName(candidate.name);
      if (!slug || !name || seen.has(slug)) continue;
      if (!validIso(candidate.createdAt)) continue;
      if (typeof candidate.createdByUserId !== "string") continue;
      const folderId =
        candidate.folderId === null
          ? null
          : typeof candidate.folderId === "string" && candidate.folderId
            ? candidate.folderId
            : undefined;
      if (folderId === undefined) continue;
      seen.add(slug);
      spaces.push({
        slug,
        name,
        folderId,
        createdAt: candidate.createdAt as string,
        createdByUserId: candidate.createdByUserId,
      });
    }
  }
  return { version: 1, spaces };
}

async function withRetry<T>(
  change: (file: SpacesFile) => { file: SpacesFile; result: T },
): Promise<T> {
  const adapter = getAdapter();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const state = await adapter.readStateVersioned<SpacesFile>(FILE);
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

export async function listSpaces(): Promise<Space[]> {
  const state = await getAdapter().readStateVersioned<SpacesFile>(FILE);
  return normalize(state.value).spaces;
}

export async function getSpace(slug: string): Promise<Space | null> {
  const parsed = parseSpaceSlug(slug);
  if (!parsed) return null;
  const spaces = await listSpaces();
  return spaces.find((space) => space.slug === parsed) ?? null;
}

/**
 * 스페이스를 등록한다. 저장소 폴더 생성은 호출자(관리 API)가 맡고, 여기는
 * 등록부만 다룬다 — 같은 슬러그가 이미 있으면 CONFLICT.
 */
export async function addSpace(input: {
  slug: string;
  name: string;
  folderId: string | null;
  createdByUserId: string;
}): Promise<Space> {
  const slug = parseSpaceSlug(input.slug);
  const name = parseSpaceName(input.name);
  if (!slug) throw new StorageError("BAD_ID", "스페이스 주소가 올바르지 않습니다");
  if (!name) throw new StorageError("BAD_ID", "스페이스 이름이 올바르지 않습니다");
  const space: Space = {
    slug,
    name,
    folderId: input.folderId,
    createdAt: new Date().toISOString(),
    createdByUserId: input.createdByUserId,
  };
  return withRetry((file) => {
    if (file.spaces.some((existing) => existing.slug === slug)) {
      throw new StorageError("CONFLICT", "이미 있는 스페이스 주소입니다");
    }
    if (file.spaces.length >= MAX_SPACES) {
      throw new StorageError("BAD_ID", "스페이스가 너무 많습니다");
    }
    return {
      file: { version: 1, spaces: [...file.spaces, space] },
      result: space,
    };
  });
}

/** 등록부에서 뺀다. 실제 폴더·파일 정리는 호출자 몫이다. */
export async function removeSpace(slug: string): Promise<boolean> {
  const parsed = parseSpaceSlug(slug);
  if (!parsed) return false;
  return withRetry((file) => {
    const remaining = file.spaces.filter((space) => space.slug !== parsed);
    return {
      file: { version: 1, spaces: remaining },
      result: remaining.length !== file.spaces.length,
    };
  });
}

export async function renameSpace(
  slug: string,
  name: string,
): Promise<Space | null> {
  const parsed = parseSpaceSlug(slug);
  const parsedName = parseSpaceName(name);
  if (!parsed || !parsedName) return null;
  return withRetry((file) => {
    const target = file.spaces.find((space) => space.slug === parsed);
    if (!target) return { file, result: null };
    const updated: Space = { ...target, name: parsedName };
    return {
      file: {
        version: 1,
        spaces: file.spaces.map((space) =>
          space.slug === parsed ? updated : space,
        ),
      },
      result: updated,
    };
  });
}
