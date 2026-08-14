export const BASE_DESKTOP_WIDTH = 1280;
export const BASE_DESKTOP_HEIGHT = 720;
export const MAX_UI_SCALE = 1.5;

export type ViewportSize = { width: number; height: number };

export type LogicalRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LogicalRectBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  minWidth: number;
  minHeight: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function uiScaleForViewport(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 1;
  if (width <= 0 || height <= 0) return 1;
  return Math.min(
    width / BASE_DESKTOP_WIDTH,
    height / BASE_DESKTOP_HEIGHT,
    MAX_UI_SCALE,
  );
}

export function logicalViewportFor(
  width: number,
  height: number,
  scale = uiScaleForViewport(width, height),
): ViewportSize {
  return {
    width: width / scale,
    height: height / scale,
  };
}

export function logicalPointerDelta(delta: number, scale: number) {
  return delta / scale;
}

export function logicalClientCoordinate(value: number, scale: number) {
  return value / scale;
}

export function fitLogicalRect(
  rect: LogicalRect,
  viewport: ViewportSize,
  bounds: LogicalRectBounds,
  fill = false,
): LogicalRect {
  const maxWidth = Math.max(
    bounds.minWidth,
    viewport.width - bounds.left - bounds.right,
  );
  const maxHeight = Math.max(
    bounds.minHeight,
    viewport.height - bounds.top - bounds.bottom,
  );
  const width = fill
    ? maxWidth
    : clamp(rect.width, bounds.minWidth, maxWidth);
  const height = fill
    ? maxHeight
    : clamp(rect.height, bounds.minHeight, maxHeight);

  return {
    x: fill
      ? bounds.left
      : clamp(
          rect.x,
          bounds.left,
          Math.max(bounds.left, viewport.width - bounds.right - width),
        ),
    y: fill
      ? bounds.top
      : clamp(
          rect.y,
          bounds.top,
          Math.max(bounds.top, viewport.height - bounds.bottom - height),
        ),
    width,
    height,
  };
}

export function reconcileSavedDraft(currentDraft: string, savedSnapshot: string) {
  return {
    draft: currentDraft,
    original: savedSnapshot,
    dirty: currentDraft !== savedSnapshot,
  };
}

export function renamedCrumbsFromEntries<T extends { id: string; name: string }>(
  path: T[],
  entries: Iterable<{ id: string; name: string; isFolder: boolean }>,
) {
  const folderNames = new Map(
    Array.from(entries)
      .filter((entry) => entry.isFolder)
      .map((entry) => [entry.id, entry.name] as const),
  );
  let changed = false;
  const next = path.map((crumb) => {
    const name = folderNames.get(crumb.id);
    if (name === undefined || name === crumb.name) return crumb;
    changed = true;
    return { ...crumb, name };
  });
  return changed ? next : path;
}

export function folderAddress(
  crumbs: Array<{ id: string; name: string }>,
) {
  const segments = crumbs
    .filter((crumb) => crumb.id !== "root")
    .map((crumb) => crumb.name);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

export function nextNotepadName(existingNames: Iterable<string>) {
  const names = new Set(existingNames);
  if (!names.has("새 메모장.txt")) return "새 메모장.txt";
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `새 메모장 ${suffix}.txt`;
    if (!names.has(candidate)) return candidate;
  }
}
