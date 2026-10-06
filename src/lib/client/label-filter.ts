// 파일 색 라벨과 폴더 창 라벨 필터(#16 C-7) — 순수 함수.
//
// 색은 폴더 색(#14)과 같은 저장소(folder-colors.json, layoutKey → 색)에 들어간다.
// 필터는 폴더 창마다 따로인 화면 상태라 저장하지 않는다. 같은 색이면 파일·폴더를 함께 보여 준다.

import { FOLDER_COLOR_IDS, type FolderColorId } from "@/lib/folder-color-ids";

export interface LabeledEntry {
  layoutKey: string;
}

/** 선택한 색의 항목만 남긴다. 필터가 없으면 그대로(같은 배열). */
export function filterEntriesByLabel<T extends LabeledEntry>(
  entries: readonly T[],
  colors: Readonly<Record<string, FolderColorId>>,
  filter: FolderColorId | null,
): readonly T[] {
  if (filter === null) return entries;
  return entries.filter((entry) => colors[entry.layoutKey] === filter);
}

/** 이 목록에서 쓰이는 라벨 색 — 팔레트 순서로, 지금 고른 색은 비어 있어도 남긴다(해제할 수 있게). */
export function labelColorsInUse(
  entries: readonly LabeledEntry[],
  colors: Readonly<Record<string, FolderColorId>>,
  active: FolderColorId | null = null,
): FolderColorId[] {
  const used = new Set<FolderColorId>();
  for (const entry of entries) {
    const color = colors[entry.layoutKey];
    if (color) used.add(color);
  }
  if (active) used.add(active);
  return FOLDER_COLOR_IDS.filter((color) => used.has(color));
}

/** 칩을 눌렀을 때의 다음 필터 — 같은 색을 다시 누르거나 "모두"(null)면 해제. */
export function nextLabelFilter(
  current: FolderColorId | null,
  pressed: FolderColorId | null,
): FolderColorId | null {
  if (pressed === null || pressed === current) return null;
  return pressed;
}
