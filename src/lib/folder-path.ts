import { getAdapter } from "@/lib/storage";
import {
  ROOT_ID,
  type StorageAdapter,
  StorageError,
  assertValidName,
} from "@/lib/storage/types";

const MAX_PATH_LENGTH = 4096;

export interface FolderCrumb {
  id: string;
  name: string;
}

export interface ResolvedFolderPath {
  folderId: string;
  crumbs: FolderCrumb[];
}

function normalizePath(rawPath: string): string[] {
  if (rawPath.length > MAX_PATH_LENGTH || /[\\\0]/.test(rawPath)) {
    throw new StorageError("BAD_ID", "잘못된 폴더 주소입니다");
  }
  const normalized: string[] = [];
  for (const segment of rawPath.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (normalized.length === 0) {
        throw new StorageError("BAD_ID", "ShareDesk 루트 위로 이동할 수 없습니다");
      }
      normalized.pop();
      continue;
    }
    const clean = assertValidName(segment);
    if (clean !== segment) {
      throw new StorageError("BAD_NAME", "잘못된 폴더 이름입니다");
    }
    normalized.push(clean);
  }
  return normalized;
}

export async function resolveFolderPath(
  rawPath: string,
  adapter: StorageAdapter = getAdapter(),
): Promise<ResolvedFolderPath> {
  const segments = normalizePath(rawPath);
  const root = await adapter.getEntry(ROOT_ID);
  if (!root.isFolder) {
    throw new StorageError("UPSTREAM", "ShareDesk 루트가 폴더가 아닙니다");
  }

  let folderId = ROOT_ID;
  const crumbs: FolderCrumb[] = [{ id: ROOT_ID, name: "ShareDesk" }];
  for (const segment of segments) {
    const entries = await adapter.list(folderId);
    const sameName = entries.filter((entry) => entry.name === segment);
    const folders = sameName.filter((entry) => entry.isFolder);
    if (folders.length === 0) {
      if (sameName.length > 0) {
        throw new StorageError("BAD_ID", `${segment}은(는) 폴더가 아닙니다`);
      }
      throw new StorageError("NOT_FOUND", `${segment} 폴더가 없습니다`);
    }
    if (folders.length > 1) {
      throw new StorageError(
        "CONFLICT",
        `${segment} 이름의 폴더가 여러 개라 주소를 정할 수 없습니다`,
      );
    }
    folderId = folders[0].id;
    crumbs.push({ id: folderId, name: folders[0].name });
  }
  return { folderId, crumbs };
}
