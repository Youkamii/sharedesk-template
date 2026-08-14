export type DesktopArrowKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown";

export type DesktopSelectableIcon = {
  layoutKey: string;
  x: number;
  y: number;
  width: number;
  height: number;
  order?: number;
};

export type DesktopKeyboardSelectionState = {
  selectedLayoutKeys: readonly string[];
  anchorLayoutKey: string | null;
  focusLayoutKey: string | null;
};

export type DesktopKeyboardMoveOptions = {
  extend?: boolean;
  additive?: boolean;
  preserveSelection?: boolean;
};

type IndexedIcon = DesktopSelectableIcon & {
  sourceIndex: number;
};

const EMPTY_SELECTION: DesktopKeyboardSelectionState = {
  selectedLayoutKeys: [],
  anchorLayoutKey: null,
  focusLayoutKey: null,
};

function usableIcons(icons: readonly DesktopSelectableIcon[]): IndexedIcon[] {
  const seen = new Set<string>();

  return icons.flatMap((icon, sourceIndex) => {
    if (
      seen.has(icon.layoutKey) ||
      !Number.isFinite(icon.x) ||
      !Number.isFinite(icon.y) ||
      !Number.isFinite(icon.width) ||
      !Number.isFinite(icon.height) ||
      icon.width < 0 ||
      icon.height < 0
    ) {
      return [];
    }
    seen.add(icon.layoutKey);
    return [{ ...icon, sourceIndex }];
  });
}

function center(icon: DesktopSelectableIcon) {
  return {
    x: icon.x + icon.width / 2,
    y: icon.y + icon.height / 2,
  };
}

function compareSpatial(left: IndexedIcon, right: IndexedIcon) {
  const leftCenter = center(left);
  const rightCenter = center(right);
  return (
    leftCenter.y - rightCenter.y ||
    leftCenter.x - rightCenter.x ||
    (left.order ?? left.sourceIndex) - (right.order ?? right.sourceIndex) ||
    left.layoutKey.localeCompare(right.layoutKey)
  );
}

function orderedIcons(icons: readonly DesktopSelectableIcon[]) {
  return usableIcons(icons).sort(compareSpatial);
}

function unique(values: readonly string[]) {
  return [...new Set(values)];
}

export function isDesktopArrowKey(key: string): key is DesktopArrowKey {
  return (
    key === "ArrowLeft" ||
    key === "ArrowRight" ||
    key === "ArrowUp" ||
    key === "ArrowDown"
  );
}

export function desktopSpatialLayoutKeys(
  icons: readonly DesktopSelectableIcon[],
): string[] {
  return orderedIcons(icons).map((icon) => icon.layoutKey);
}

export function reconcileDesktopKeyboardSelection(
  icons: readonly DesktopSelectableIcon[],
  state: DesktopKeyboardSelectionState | null,
): DesktopKeyboardSelectionState {
  const available = new Set(usableIcons(icons).map((icon) => icon.layoutKey));
  if (available.size === 0) return EMPTY_SELECTION;

  const selectedLayoutKeys = unique(state?.selectedLayoutKeys ?? []).filter(
    (layoutKey) => available.has(layoutKey),
  );
  const validAnchor =
    state?.anchorLayoutKey && available.has(state.anchorLayoutKey)
      ? state.anchorLayoutKey
      : null;
  const validFocus =
    state?.focusLayoutKey && available.has(state.focusLayoutKey)
      ? state.focusLayoutKey
      : null;
  const focusLayoutKey =
    validFocus ?? selectedLayoutKeys.at(-1) ?? validAnchor ?? null;

  return {
    selectedLayoutKeys,
    anchorLayoutKey: validAnchor ?? focusLayoutKey,
    focusLayoutKey,
  };
}

function isInDirection(
  deltaX: number,
  deltaY: number,
  direction: DesktopArrowKey,
) {
  if (direction === "ArrowLeft") return deltaX < 0;
  if (direction === "ArrowRight") return deltaX > 0;
  if (direction === "ArrowUp") return deltaY < 0;
  return deltaY > 0;
}

export function nextDesktopLayoutKey(
  icons: readonly DesktopSelectableIcon[],
  fromLayoutKey: string,
  direction: DesktopArrowKey,
): string | null {
  const ordered = orderedIcons(icons);
  const origin = ordered.find((icon) => icon.layoutKey === fromLayoutKey);
  if (!origin) return null;
  const originCenter = center(origin);

  const candidates = ordered.flatMap((icon, spatialIndex) => {
    if (icon.layoutKey === fromLayoutKey) return [];
    const candidateCenter = center(icon);
    const deltaX = candidateCenter.x - originCenter.x;
    const deltaY = candidateCenter.y - originCenter.y;
    if (!isInDirection(deltaX, deltaY, direction)) return [];

    const horizontal =
      direction === "ArrowLeft" || direction === "ArrowRight";
    const primaryDistance = Math.abs(horizontal ? deltaX : deltaY);
    const secondaryDistance = Math.abs(horizontal ? deltaY : deltaX);
    return [
      {
        layoutKey: icon.layoutKey,
        primaryDistance,
        secondaryDistance,
        straightLineDistance: Math.hypot(deltaX, deltaY),
        spatialIndex,
      },
    ];
  });

  candidates.sort(
    (left, right) =>
      left.straightLineDistance - right.straightLineDistance ||
      left.primaryDistance - right.primaryDistance ||
      left.secondaryDistance - right.secondaryDistance ||
      left.spatialIndex - right.spatialIndex ||
      left.layoutKey.localeCompare(right.layoutKey),
  );

  return candidates[0]?.layoutKey ?? null;
}

function rangeBetween(
  orderedLayoutKeys: readonly string[],
  anchorLayoutKey: string,
  focusLayoutKey: string,
) {
  const anchorIndex = orderedLayoutKeys.indexOf(anchorLayoutKey);
  const focusIndex = orderedLayoutKeys.indexOf(focusLayoutKey);
  if (anchorIndex < 0 || focusIndex < 0) return [focusLayoutKey];
  const start = Math.min(anchorIndex, focusIndex);
  const end = Math.max(anchorIndex, focusIndex);
  return orderedLayoutKeys.slice(start, end + 1);
}

export function moveDesktopKeyboardSelection(
  icons: readonly DesktopSelectableIcon[],
  state: DesktopKeyboardSelectionState | null,
  direction: DesktopArrowKey,
  options: DesktopKeyboardMoveOptions = {},
): DesktopKeyboardSelectionState {
  const orderedLayoutKeys = desktopSpatialLayoutKeys(icons);
  if (orderedLayoutKeys.length === 0) return EMPTY_SELECTION;

  const current = reconcileDesktopKeyboardSelection(icons, state);
  if (!current.focusLayoutKey) {
    const fallbackLayoutKey = orderedLayoutKeys[0];
    return {
      selectedLayoutKeys: options.preserveSelection
        ? current.selectedLayoutKeys
        : [fallbackLayoutKey],
      anchorLayoutKey: fallbackLayoutKey,
      focusLayoutKey: fallbackLayoutKey,
    };
  }

  const nextLayoutKey =
    nextDesktopLayoutKey(icons, current.focusLayoutKey, direction) ??
    current.focusLayoutKey;

  if (options.preserveSelection) {
    return {
      selectedLayoutKeys: current.selectedLayoutKeys,
      anchorLayoutKey: current.anchorLayoutKey ?? current.focusLayoutKey,
      focusLayoutKey: nextLayoutKey,
    };
  }

  if (options.extend) {
    const anchorLayoutKey =
      current.anchorLayoutKey ?? current.focusLayoutKey;
    const range = rangeBetween(
      orderedLayoutKeys,
      anchorLayoutKey,
      nextLayoutKey,
    );
    const selected = options.additive
      ? new Set([...current.selectedLayoutKeys, ...range])
      : new Set(range);

    return {
      selectedLayoutKeys: orderedLayoutKeys.filter((layoutKey) =>
        selected.has(layoutKey),
      ),
      anchorLayoutKey,
      focusLayoutKey: nextLayoutKey,
    };
  }

  return {
    selectedLayoutKeys: [nextLayoutKey],
    anchorLayoutKey: nextLayoutKey,
    focusLayoutKey: nextLayoutKey,
  };
}

export function toggleDesktopSelectionKey(
  icons: readonly DesktopSelectableIcon[],
  state: DesktopKeyboardSelectionState | null,
  layoutKey: string,
): DesktopKeyboardSelectionState {
  const orderedLayoutKeys = desktopSpatialLayoutKeys(icons);
  if (!orderedLayoutKeys.includes(layoutKey)) {
    return reconcileDesktopKeyboardSelection(icons, state);
  }

  const current = reconcileDesktopKeyboardSelection(icons, state);
  const selected = new Set(current.selectedLayoutKeys);
  if (selected.has(layoutKey)) selected.delete(layoutKey);
  else selected.add(layoutKey);

  return {
    selectedLayoutKeys: orderedLayoutKeys.filter((key) => selected.has(key)),
    anchorLayoutKey: layoutKey,
    focusLayoutKey: layoutKey,
  };
}

type KeyboardTarget = {
  tagName?: unknown;
  isContentEditable?: unknown;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
};

export function shouldIgnoreDesktopSelectionKeydown(
  target: EventTarget | null,
): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as KeyboardTarget;
  const tagName =
    typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
  if (tagName === "input" || tagName === "textarea" || tagName === "select") {
    return true;
  }
  if (element.isContentEditable === true) return true;
  if (
    element.getAttribute?.("role") === "textbox" ||
    element.getAttribute?.("role") === "searchbox"
  ) {
    return true;
  }

  return Boolean(
    element.closest?.(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"]',
    ),
  );
}
