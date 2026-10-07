// 공개 폴더 방문자 화면(#17 B-6)의 여러 파일 고르기 — 순수 상태 계산.
// 데스크의 규칙(batch-selection.ts)을 그대로 쓴다: 그냥 누르면 하나, Ctrl/⌘는
// 넣고 빼기, 고무줄은 사각형에 걸린 것(Ctrl/⌘면 기존에 더하기). Shift는 마지막에
// 고른 것(기준)부터 누른 것까지 화면 순서로 한 번에.

import {
  selectLayoutKey,
  selectLayoutsInRectangle,
  type BatchSelection,
  type SelectableRect,
  type SelectionRect,
} from "./batch-selection";

// 방문자 화면은 폴더 하나뿐이라 범위(scope)도 하나다.
const SCOPE = "public";

export interface VisitorSelection {
  ids: string[];
  // Shift 범위의 기준(마지막으로 그냥·Ctrl로 누른 항목).
  anchorId: string | null;
}

export const EMPTY_VISITOR_SELECTION: VisitorSelection = {
  ids: [],
  anchorId: null,
};

function toBatch(selection: VisitorSelection): BatchSelection {
  return selection.ids.length > 0
    ? { scopeId: SCOPE, layoutKeys: selection.ids }
    : null;
}

function fromBatch(
  batch: BatchSelection,
  anchorId: string | null,
): VisitorSelection {
  const ids = batch?.layoutKeys ?? [];
  return { ids, anchorId: ids.length > 0 ? anchorId : null };
}

export function isVisitorSelected(
  selection: VisitorSelection,
  id: string,
): boolean {
  return selection.ids.includes(id);
}

// 아이콘·목록 줄을 눌렀을 때. orderedIds는 지금 화면에 보이는 순서다(데스크톱은
// 위→아래, 왼쪽→오른쪽 격자 순서, 좁은 화면은 목록 순서).
export function clickVisitorSelection(
  current: VisitorSelection,
  id: string,
  orderedIds: readonly string[],
  modifiers: { toggle: boolean; range: boolean },
): VisitorSelection {
  if (modifiers.range && current.anchorId !== null) {
    const from = orderedIds.indexOf(current.anchorId);
    const to = orderedIds.indexOf(id);
    if (from >= 0 && to >= 0) {
      const span = orderedIds.slice(Math.min(from, to), Math.max(from, to) + 1);
      // Ctrl+Shift는 기존 선택에 범위를 더하고, Shift만은 범위로 바꾼다. 기준은
      // 그대로 둔다 — 이어서 Shift로 누르면 같은 기준에서 다시 잰다.
      const ids = modifiers.toggle
        ? [...new Set([...current.ids, ...span])]
        : [...span];
      return { ids, anchorId: current.anchorId };
    }
  }
  return fromBatch(
    selectLayoutKey(toBatch(current), SCOPE, id, modifiers.toggle),
    id,
  );
}

// 고무줄(빈 바탕에서 끌기). initial은 끌기를 시작할 때의 선택이다.
export function rectangleVisitorSelection(
  initial: VisitorSelection,
  candidates: readonly SelectableRect[],
  rectangle: SelectionRect,
  additive: boolean,
): VisitorSelection {
  const batch = selectLayoutsInRectangle(
    toBatch(initial),
    SCOPE,
    [...candidates],
    rectangle,
    additive,
  );
  const ids = batch?.layoutKeys ?? [];
  return {
    ids,
    anchorId:
      initial.anchorId !== null && ids.includes(initial.anchorId)
        ? initial.anchorId
        : (ids[ids.length - 1] ?? null),
  };
}

// 목록이 바뀌면(30초 폴링·검색) 사라진 항목을 선택에서 뺀다.
export function pruneVisitorSelection(
  current: VisitorSelection,
  presentIds: Iterable<string>,
): VisitorSelection {
  const present = new Set(presentIds);
  const ids = current.ids.filter((id) => present.has(id));
  if (ids.length === current.ids.length) return current;
  return {
    ids,
    anchorId:
      current.anchorId !== null && present.has(current.anchorId)
        ? current.anchorId
        : null,
  };
}

// 받을 파일 — 고른 것 중 지금 있는 파일만, 화면 순서대로.
export function selectedVisitorFiles<T extends { id: string; isFolder: boolean }>(
  orderedEntries: readonly T[],
  selection: VisitorSelection,
): T[] {
  const chosen = new Set(selection.ids);
  return orderedEntries.filter((entry) => !entry.isFolder && chosen.has(entry.id));
}
