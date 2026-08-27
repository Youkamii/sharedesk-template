import {
  parseFolderColor,
  type FolderColorId,
} from "@/lib/folder-color-ids";
import { getAdapter } from "@/lib/storage";
import { StorageError } from "@/lib/storage/types";

// 팔레트 상수·타입은 folder-color-ids에서만 가져온다 — 여기서 재수출하면
// 클라이언트가 실수로 이 모듈(저장소 의존)을 import하는 길이 다시 열린다.

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
    else {
      // 다시 지정하면 맨 뒤로 — 아래 넘침 처리에서 최근 것이 살아남는다.
      delete colors[layoutKey];
      colors[layoutKey] = color;
    }
    // 지워진 폴더의 색 항목은 스스로 사라지지 않는다(삭제 경로가 이 파일을
    // 모른다). 상한을 넘으면 오래된 항목부터 버려 기능이 잠기지 않게 한다 —
    // 색은 잃어도 되는 꾸밈이고, 살아 있는 폴더는 다시 칠하면 된다.
    const keys = Object.keys(colors);
    if (keys.length > MAX_COLORS) {
      for (const stale of keys.slice(0, keys.length - MAX_COLORS)) {
        delete colors[stale];
      }
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
