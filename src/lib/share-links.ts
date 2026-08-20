import { randomBytes } from "node:crypto";
import { getAdapter } from "@/lib/storage";
import { StorageError } from "@/lib/storage/types";

const FILE = "share-links.json";
const MAX_LINKS = 200;
const MAX_PENDING_DELETES = 500;
const MAX_ATTEMPTS = 4;
const MAX_EXPIRY_HOURS = 24 * 30;

export interface ShareLink {
  linkId: string;
  fileId: string;
  name: string;
  kind: "file" | "folder";
  createdBy: string;
  createdByUserId: string;
  createdAt: string;
  expiresAt: string;
  quick: boolean;
  deleteOnExpire: boolean;
}

interface PendingDelete {
  linkId: string;
  fileId: string;
  name: string;
  deleteAt: string;
}

interface ShareLinkFile {
  version: 2;
  links: ShareLink[];
  pendingDeletes: PendingDelete[];
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function normalize(value: unknown): ShareLinkFile {
  const raw = value as {
    links?: unknown;
    pendingDeletes?: unknown;
  } | null;
  const links = Array.isArray(raw?.links)
    ? raw.links
        .filter((value): value is ShareLink => {
          const link = value as Partial<ShareLink> | null;
          return (
            !!link &&
            typeof link.linkId === "string" &&
            /^[a-f0-9]{48}$/.test(link.linkId) &&
            typeof link.fileId === "string" &&
            typeof link.name === "string" &&
            typeof link.createdBy === "string" &&
            validIso(link.createdAt) &&
            validIso(link.expiresAt)
          );
        })
        .map<ShareLink>((link) => ({
          ...link,
          kind: link.kind === "folder" ? "folder" : "file",
          createdByUserId:
            typeof link.createdByUserId === "string" ? link.createdByUserId : "",
          quick: link.quick === true,
          deleteOnExpire: link.quick === true && link.deleteOnExpire === true,
        }))
        .slice(0, MAX_LINKS)
    : [];
  const pendingDeletes = Array.isArray(raw?.pendingDeletes)
    ? raw.pendingDeletes
        .filter((value): value is PendingDelete => {
          const pending = value as Partial<PendingDelete> | null;
          return (
            !!pending &&
            typeof pending.linkId === "string" &&
            typeof pending.fileId === "string" &&
            typeof pending.name === "string" &&
            validIso(pending.deleteAt)
          );
        })
        .slice(0, MAX_PENDING_DELETES)
    : [];
  return { version: 2, links, pendingDeletes };
}

function activeLinks(file: ShareLinkFile, now = Date.now()): ShareLink[] {
  return file.links.filter((link) => Date.parse(link.expiresAt) > now);
}

async function mutate<T>(
  change: (file: ShareLinkFile) => { file: ShareLinkFile; result: T },
): Promise<T> {
  const adapter = getAdapter();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const state = await adapter.readStateVersioned<ShareLinkFile>(FILE);
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
  throw lastError ?? new StorageError("CONFLICT", "잠시 후 다시 시도해 주세요");
}

async function readFile(): Promise<ShareLinkFile> {
  return normalize(await getAdapter().readState<ShareLinkFile>(FILE));
}

export function parseExpiryHours(value: unknown): number | null {
  const hours = typeof value === "number" ? value : Number.NaN;
  return Number.isInteger(hours) && hours >= 1 && hours <= MAX_EXPIRY_HOURS
    ? hours
    : null;
}

export async function createShareLink(
  fileId: string,
  name: string,
  createdBy: string,
  expiresInHours: number,
  options: {
    kind?: "file" | "folder";
    createdByUserId?: string;
    quick?: boolean;
    deleteOnExpire?: boolean;
  } = {},
): Promise<ShareLink> {
  const now = Date.now();
  const link: ShareLink = {
    linkId: randomBytes(24).toString("hex"),
    fileId,
    name,
    kind: options.kind === "folder" ? "folder" : "file",
    createdBy,
    createdByUserId: options.createdByUserId ?? "",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + expiresInHours * 3_600_000).toISOString(),
    quick: options.quick === true,
    deleteOnExpire:
      options.quick === true && options.deleteOnExpire === true,
  };
  return mutate((file) => {
    const links = activeLinks(file);
    if (links.length >= MAX_LINKS) {
      throw new StorageError(
        "CONFLICT",
        "활성 공유 링크가 너무 많습니다. 쓰지 않는 링크를 취소한 뒤 다시 만들어 주세요",
      );
    }
    return {
      file: { ...file, links: [link, ...links] },
      result: link,
    };
  });
}

export async function listShareLinks(fileId?: string): Promise<ShareLink[]> {
  const links = activeLinks(await readFile());
  return fileId ? links.filter((link) => link.fileId === fileId) : links;
}

export async function getShareLink(linkId: string): Promise<ShareLink | null> {
  if (!/^[a-f0-9]{48}$/.test(linkId)) return null;
  return (await listShareLinks()).find((link) => link.linkId === linkId) ?? null;
}

export async function revokeShareLink(linkId: string): Promise<boolean> {
  return mutate((file) => {
    const target = file.links.find((link) => link.linkId === linkId);
    const pendingDeletes = target?.deleteOnExpire
      ? [
          ...file.pendingDeletes.filter((item) => item.linkId !== linkId),
          {
            linkId: target.linkId,
            fileId: target.fileId,
            name: target.name,
            deleteAt: target.expiresAt,
          },
        ].slice(-MAX_PENDING_DELETES)
      : file.pendingDeletes;
    return {
      file: {
        ...file,
        links: file.links.filter((link) => link.linkId !== linkId),
        pendingDeletes,
      },
      result: !!target,
    };
  });
}

export async function keepQuickLinkFile(
  linkId: string,
): Promise<ShareLink | null> {
  return mutate((file) => {
    let result: ShareLink | null = null;
    const links = file.links.map((link) => {
      if (
        link.linkId !== linkId ||
        !link.quick ||
        Date.parse(link.expiresAt) <= Date.now()
      ) {
        return link;
      }
      result = { ...link, deleteOnExpire: false };
      return result;
    });
    return { file: { ...file, links }, result };
  });
}

export async function restoreQuickLinkDeletion(linkId: string): Promise<void> {
  await mutate((file) => ({
    file: {
      ...file,
      links: file.links.map((link) =>
        link.linkId === linkId && link.quick
          ? { ...link, deleteOnExpire: true }
          : link,
      ),
    },
    result: undefined,
  }));
}

export async function updateQuickLinkTarget(
  linkId: string,
  entry: { id: string; name: string },
): Promise<ShareLink | null> {
  return mutate((file) => {
    let result: ShareLink | null = null;
    const links = file.links.map((link) => {
      if (link.linkId !== linkId || !link.quick) return link;
      result = {
        ...link,
        fileId: entry.id,
        name: entry.name,
        quick: false,
        deleteOnExpire: false,
      };
      return result;
    });
    return { file: { ...file, links }, result };
  });
}

export async function resolveShareLink(
  linkId: string,
): Promise<ShareLink | null> {
  return getShareLink(linkId);
}

// 만료된 링크를 먼저 장부에서 떼어 pendingDeletes로 옮긴 뒤 실제 파일을
// 지운다. 중간에 함수가 끝나도 다음 요청이나 하루 한 번 Cron이 이어서 처리한다.
export async function cleanupExpiredShareLinks(limit = 20): Promise<{
  expired: number;
  deleted: number;
  failed: number;
}> {
  const now = Date.now();
  const snapshot = await readFile();
  if (
    !snapshot.links.some((link) => Date.parse(link.expiresAt) <= now) &&
    !snapshot.pendingDeletes.some((item) => Date.parse(item.deleteAt) <= now)
  ) {
    return { expired: 0, deleted: 0, failed: 0 };
  }
  const claimed = await mutate((file) => {
    const expired = file.links.filter(
      (link) => Date.parse(link.expiresAt) <= now,
    );
    const additions = expired
      .filter((link) => link.deleteOnExpire)
      .map((link) => ({
        linkId: link.linkId,
        fileId: link.fileId,
        name: link.name,
        deleteAt: link.expiresAt,
      }));
    const byLink = new Map(
      [...file.pendingDeletes, ...additions].map((item) => [item.linkId, item]),
    );
    const next: ShareLinkFile = {
      ...file,
      links: file.links.filter((link) => Date.parse(link.expiresAt) > now),
      pendingDeletes: [...byLink.values()].slice(-MAX_PENDING_DELETES),
    };
    return {
      file: next,
      result: {
        expired: expired.length,
        due: next.pendingDeletes
          .filter((item) => Date.parse(item.deleteAt) <= now)
          .slice(0, Math.max(1, Math.min(limit, 100))),
      },
    };
  });

  const deletedIds: string[] = [];
  let failed = 0;
  for (const pending of claimed.due) {
    try {
      await getAdapter().deleteTemporary(pending.fileId);
      deletedIds.push(pending.linkId);
    } catch (error) {
      if (error instanceof StorageError && error.code === "NOT_FOUND") {
        deletedIds.push(pending.linkId);
      } else {
        failed += 1;
        console.error("[share-links] 간이 링크 파일 정리 실패", {
          linkId: pending.linkId,
          error,
        });
      }
    }
  }
  if (deletedIds.length > 0) {
    const deleted = new Set(deletedIds);
    await mutate((file) => ({
      file: {
        ...file,
        pendingDeletes: file.pendingDeletes.filter(
          (item) => !deleted.has(item.linkId),
        ),
      },
      result: undefined,
    }));
  }
  return { expired: claimed.expired, deleted: deletedIds.length, failed };
}
