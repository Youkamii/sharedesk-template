import { randomBytes } from "node:crypto";
import { getAdapter } from "@/lib/storage";
import { StorageError } from "@/lib/storage/types";

// 외부 공유 링크 — 링크를 아는 사람이 로그인 없이 파일 하나를 내려받는
// 만료형 통로. 발급 기록을 저장소 상태 파일에 남겨 두므로 만료 전에도
// 취소할 수 있다. 링크 id는 URL에 그대로 노출되는 비밀이라 충분히 긴
// 난수를 쓴다.
const FILE = "share-links.json";
const MAX_LINKS = 200;
const MAX_ATTEMPTS = 3;
const MAX_EXPIRY_HOURS = 24 * 30;
// 공개 다운로드 경로는 인증이 없어 요청마다 저장소를 읽으면 무인증
// 트래픽이 Drive 쿼터를 증폭시킨다. 짧은 캐시로 읽기를 흡수한다
// (서버리스 인스턴스별 캐시 — 취소 반영이 최대 이 시간만큼 늦을 수 있다).
const READ_CACHE_MS = 15_000;
let readCache: { at: number; file: ShareLinkFile } | null = null;

export interface ShareLink {
  linkId: string;
  fileId: string;
  // 발급 시점의 파일 이름 — 목록 표시용. 이후 이름이 바뀌어도 링크는 산다.
  name: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
}

interface ShareLinkFile {
  version: 1;
  links: ShareLink[];
}

function normalize(value: unknown): ShareLinkFile {
  const raw = value as { links?: unknown } | null;
  const links = Array.isArray(raw?.links)
    ? raw.links
        .filter((link): link is ShareLink => {
          const candidate = link as ShareLink | null;
          return (
            !!candidate &&
            typeof candidate.linkId === "string" &&
            /^[a-f0-9]{48}$/.test(candidate.linkId) &&
            typeof candidate.fileId === "string" &&
            typeof candidate.name === "string" &&
            typeof candidate.createdBy === "string" &&
            typeof candidate.createdAt === "string" &&
            typeof candidate.expiresAt === "string"
          );
        })
        .slice(0, MAX_LINKS)
    : [];
  return { version: 1, links };
}

function pruneExpired(file: ShareLinkFile, now: number): ShareLinkFile {
  return {
    version: 1,
    links: file.links.filter((link) => Date.parse(link.expiresAt) > now),
  };
}

async function mutate(
  change: (file: ShareLinkFile) => ShareLinkFile,
): Promise<ShareLinkFile> {
  const adapter = getAdapter();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const state = await adapter.readStateVersioned<ShareLinkFile>(FILE);
    const next = change(pruneExpired(normalize(state.value), Date.now()));
    try {
      await adapter.compareAndSwapState(FILE, next, state.version);
      readCache = { at: Date.now(), file: next };
      return next;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new StorageError("CONFLICT", "잠시 후 다시 시도해 주세요");
}

async function readLinks(): Promise<ShareLinkFile> {
  if (readCache && Date.now() - readCache.at < READ_CACHE_MS) {
    return readCache.file;
  }
  const state = await getAdapter().readStateVersioned<ShareLinkFile>(FILE);
  const file = normalize(state.value);
  readCache = { at: Date.now(), file };
  return file;
}

export function parseExpiryHours(value: unknown): number | null {
  const hours = typeof value === "number" ? value : Number.NaN;
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_EXPIRY_HOURS) {
    return null;
  }
  return hours;
}

export async function createShareLink(
  fileId: string,
  name: string,
  createdBy: string,
  expiresInHours: number,
): Promise<ShareLink> {
  const now = Date.now();
  const link: ShareLink = {
    linkId: randomBytes(24).toString("hex"),
    fileId,
    name,
    createdBy,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiresInHours * 3_600_000).toISOString(),
  };
  await mutate((file) => {
    // 가득 찼을 때 오래된 유효 링크를 몰래 버리면 이미 배포된 링크가
    // 예고 없이 죽는다 — 대신 만들기를 명시적으로 거부한다.
    if (file.links.length >= MAX_LINKS) {
      throw new StorageError(
        "CONFLICT",
        "활성 공유 링크가 너무 많습니다. 쓰지 않는 링크를 취소한 뒤 다시 만들어 주세요",
      );
    }
    return { version: 1, links: [link, ...file.links] };
  });
  return link;
}

export async function listShareLinks(fileId?: string): Promise<ShareLink[]> {
  const file = pruneExpired(await readLinks(), Date.now());
  return fileId
    ? file.links.filter((link) => link.fileId === fileId)
    : file.links;
}

export async function revokeShareLink(linkId: string): Promise<boolean> {
  let removed = false;
  await mutate((file) => {
    const links = file.links.filter((link) => link.linkId !== linkId);
    removed = links.length !== file.links.length;
    return { version: 1, links };
  });
  return removed;
}

// 공개 다운로드 경로용 — 유효한(만료 전·취소 안 된) 링크만 돌려준다.
export async function resolveShareLink(
  linkId: string,
): Promise<ShareLink | null> {
  if (!/^[a-f0-9]{48}$/.test(linkId)) return null;
  const links = await listShareLinks();
  return links.find((link) => link.linkId === linkId) ?? null;
}
