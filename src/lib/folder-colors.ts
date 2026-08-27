import {
  parseFolderColor,
  type FolderColorId,
} from "@/lib/folder-color-ids";
import { getAdapter } from "@/lib/storage";
import { StorageError } from "@/lib/storage/types";

export {
  FOLDER_COLOR_IDS,
  parseFolderColor,
  type FolderColorId,
} from "@/lib/folder-color-ids";

// 폴더 색(#14): 폴더마다 도트 팔레트의 무지개 색을 입힌다. 색은 위치가
// 아니라 폴더 자체의 꾸밈이라 desktop-layout(폴더별 파일)이 아닌 전역
// 상태 파일 하나에 layoutKey → 색으로 담는다 — 폴더를 옮겨도 색이 따라간다.
// 관례: readStateVersioned → normalize → compareAndSwapState.

const FILE = "folder-colors.json";
const MAX_ATTEMPTS = 4;
const MAX_COLORS = 2_000;

interface FolderColorFile {
  version: 1;
  colors: Record<string, FolderColorId>;
}

function normalize(value: unknown): FolderColorFile {
  const raw = value as { colors?: unknown } | null;
  const colors: Record<string, FolderColorId> = {};
  if (raw?.colors && typeof raw.colors === "object") {
    for (const [key, color] of Object.entries(
      raw.colors as Record<string, unknown>,
    )) {
      if (!key || key.length > 1024) continue;
      const parsed = parseFolderColor(color);
      if (parsed) colors[key] = parsed;
    }
  }
  return { version: 1, colors };
}

export async function getFolderColors(): Promise<
  Record<string, FolderColorId>
> {
  const state = await getAdapter().readStateVersioned<FolderColorFile>(FILE);
  return normalize(state.value).colors;
}

/** color가 null이면 기본색으로 되돌린다(항목 제거). */
export async function setFolderColor(
  layoutKey: string,
  color: FolderColorId | null,
): Promise<Record<string, FolderColorId>> {
  const adapter = getAdapter();
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const state = await adapter.readStateVersioned<FolderColorFile>(FILE);
    const file = normalize(state.value);
    const colors = { ...file.colors };
    if (color === null) delete colors[layoutKey];
    else colors[layoutKey] = color;
    if (Object.keys(colors).length > MAX_COLORS) {
      throw new StorageError("CONFLICT", "색을 지정한 폴더가 너무 많습니다");
    }
    try {
      await adapter.compareAndSwapState(
        FILE,
        { version: 1, colors } satisfies FolderColorFile,
        state.version,
      );
      return colors;
    } catch (error) {
      lastError = error;
      if (error instanceof StorageError && error.code === "CONFLICT") continue;
      throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new StorageError("CONFLICT", "폴더 색을 저장하지 못했습니다");
}
