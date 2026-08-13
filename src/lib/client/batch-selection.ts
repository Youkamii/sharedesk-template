export type BatchSelection = {
  scopeId: string;
  layoutKeys: string[];
} | null;

export type SelectionRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SelectableRect = SelectionRect & {
  layoutKey: string;
};

function unique(values: string[]) {
  return [...new Set(values)];
}

export function selectLayoutKey(
  current: BatchSelection,
  scopeId: string,
  layoutKey: string,
  additive: boolean,
): BatchSelection {
  if (!additive || current?.scopeId !== scopeId) {
    return { scopeId, layoutKeys: [layoutKey] };
  }

  if (current.layoutKeys.includes(layoutKey)) {
    const layoutKeys = current.layoutKeys.filter((key) => key !== layoutKey);
    return layoutKeys.length > 0 ? { scopeId, layoutKeys } : null;
  }

  return { scopeId, layoutKeys: [...current.layoutKeys, layoutKey] };
}

export function removeSelectedLayoutKeys(
  current: BatchSelection,
  scopeId: string,
  layoutKeys: Iterable<string>,
): BatchSelection {
  if (current?.scopeId !== scopeId) return current;
  const removed = new Set(layoutKeys);
  const remaining = current.layoutKeys.filter((key) => !removed.has(key));
  return remaining.length > 0 ? { scopeId, layoutKeys: remaining } : null;
}

export function rectanglesIntersect(a: SelectionRect, b: SelectionRect) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function selectLayoutsInRectangle(
  current: BatchSelection,
  scopeId: string,
  candidates: SelectableRect[],
  rectangle: SelectionRect,
  additive: boolean,
): BatchSelection {
  const inside = candidates
    .filter((candidate) => rectanglesIntersect(candidate, rectangle))
    .map((candidate) => candidate.layoutKey);
  const existing =
    additive && current?.scopeId === scopeId ? current.layoutKeys : [];
  const layoutKeys = unique([...existing, ...inside]);
  return layoutKeys.length > 0 ? { scopeId, layoutKeys } : null;
}

export function batchMutationNotice(
  action: "move" | "trash",
  total: number,
  succeeded: number,
  refreshed: boolean,
) {
  const failed = total - succeeded;
  let message: string;
  if (failed === 0) {
    message =
      action === "move"
        ? `${succeeded}개 항목을 옮겼습니다`
        : `${succeeded}개 항목을 휴지통에 넣었습니다`;
  } else if (succeeded === 0) {
    message =
      action === "move"
        ? `${failed}개 항목을 옮기지 못했습니다`
        : `${failed}개 항목을 휴지통에 넣지 못했습니다`;
  } else {
    message =
      action === "move"
        ? `${succeeded}개 옮김, ${failed}개 실패했습니다`
        : `${succeeded}개 휴지통 이동, ${failed}개 실패했습니다`;
  }
  return refreshed ? message : `${message} — 새로고침해 주세요`;
}
