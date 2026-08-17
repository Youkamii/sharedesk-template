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

export type NoticeTranslator = (
  text: string,
  vars?: Record<string, string | number>,
) => string;

// 기본 구현은 한국어 원문에 자리표시자만 채운다. 화면은 번역기를 주입해
// 언어 설정에 맞는 문구를 받는다.
const fillNotice: NoticeTranslator = (text, vars) => {
  let out = text;
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      out = out.replaceAll(`{${key}}`, String(value));
    }
  }
  return out;
};

export function batchMutationNotice(
  action: "move" | "trash",
  total: number,
  succeeded: number,
  refreshed: boolean,
  t: NoticeTranslator = fillNotice,
) {
  const failed = total - succeeded;
  let message: string;
  if (failed === 0) {
    message =
      action === "move"
        ? t("{count}개 항목을 옮겼습니다", { count: succeeded })
        : t("{count}개 항목을 휴지통에 넣었습니다", { count: succeeded });
  } else if (succeeded === 0) {
    message =
      action === "move"
        ? t("{count}개 항목을 옮기지 못했습니다", { count: failed })
        : t("{count}개 항목을 휴지통에 넣지 못했습니다", { count: failed });
  } else {
    message =
      action === "move"
        ? t("{ok}개 옮김, {fail}개 실패했습니다", { ok: succeeded, fail: failed })
        : t("{ok}개 휴지통 이동, {fail}개 실패했습니다", {
            ok: succeeded,
            fail: failed,
          });
  }
  return refreshed ? message : t("{message} — 새로고침해 주세요", { message });
}
