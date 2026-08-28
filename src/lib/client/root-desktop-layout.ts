export const ROOT_ICON_WIDTH = 88;
export const ROOT_ICON_HEIGHT = 94;

// 데스크 표면(.desktop)은 논리 뷰포트 크기 그대로 늘어난다 — 1280x720 고정이
// 아니다(FilesView의 scaled-desktop-stage). 아이콘 평면(.rootCanvas)은 그 안에서
// 상단 바 34px·작업표시줄 48px을 빼고 바닥 10px을 여유로 남긴 영역이라,
// 기준 창(1280x720)에서만 1280x628이 된다.
const ROOT_CANVAS_TOP = 34;
const ROOT_CANVAS_BOTTOM = 48;
const ROOT_CANVAS_SLACK = 10;

// 기준 창에서의 평면 크기. 뷰포트를 모르는 호출부(테스트·기본값)만 쓴다.
export const ROOT_DESKTOP_WIDTH = 1280;
export const ROOT_DESKTOP_HEIGHT = 628;

export type RootDesktopBounds = { width: number; height: number };

export const ROOT_DESKTOP_BASE_BOUNDS: RootDesktopBounds = {
  width: ROOT_DESKTOP_WIDTH,
  height: ROOT_DESKTOP_HEIGHT,
};

// 사이드바(#11) 손잡이 폭. 아이콘이 피해야 하는 건 닫힌 상태의 손잡이뿐이다 —
// 열린 패널(232px)까지 비우면 화면 우측이 통째로 못 쓰게 된다. 사이드바는
// 기본 데스크 전용이라 스페이스에서는 예약하지 않는다(reserveSidebar=false).
const ROOT_SIDEBAR_RESERVED = 20;

// 휴지통 런처(.trashLauncher)는 데스크 우하단에 붙어 있다(right:18, bottom:66,
// 72x76). 화면이 넓어지면 휴지통도 같이 오른쪽으로 간다. 좌표를 상수로 박으면
// 화면 한복판에 유령 금지 구역이 생기고 정작 진짜 휴지통은 안 지켜진다(#14).
// 평면 좌표에서 아래 여백은 66 - 48(작업표시줄) - 10(여유) = 8이지만, 평면
// 바닥 10px은 아이콘이 닿지 못하는 구간이라 18로 잡아 예전 경계를 유지한다.
const ROOT_TRASH_GAP_RIGHT = 18;
const ROOT_TRASH_GAP_BOTTOM = 18;
const ROOT_TRASH_WIDTH = 72;
const ROOT_TRASH_HEIGHT = 76;

const ROOT_GRID_X = 12;
const ROOT_GRID_Y = 10;
const ROOT_GRID_STEP_X = 96;
const ROOT_GRID_STEP_Y = 104;
const ROOT_DEFAULT_COLUMNS = 6;

const MIN_BOUNDS_WIDTH = ROOT_GRID_X + ROOT_ICON_WIDTH + ROOT_SIDEBAR_RESERVED;
const MIN_BOUNDS_HEIGHT = ROOT_GRID_Y + ROOT_ICON_HEIGHT;

// 논리 뷰포트(창 크기 / UI 배율)에서 아이콘 평면의 크기를 구한다.
export function rootDesktopBoundsForViewport(
  logicalWidth: number,
  logicalHeight: number,
): RootDesktopBounds {
  const width = Number.isFinite(logicalWidth)
    ? Math.floor(logicalWidth)
    : ROOT_DESKTOP_WIDTH;
  const height = Number.isFinite(logicalHeight)
    ? Math.floor(logicalHeight) -
      ROOT_CANVAS_TOP -
      ROOT_CANVAS_BOTTOM -
      ROOT_CANVAS_SLACK
    : ROOT_DESKTOP_HEIGHT;
  return {
    width: Math.max(MIN_BOUNDS_WIDTH, width),
    height: Math.max(MIN_BOUNDS_HEIGHT, height),
  };
}

export type RootDesktopPlacement = {
  x: number;
  y: number;
  version: number;
};

type RootDesktopEntry = {
  layoutKey: string;
};

export type RootDesktopCorrection = {
  layoutKey: string;
  placement: RootDesktopPlacement;
  // 화면 크기·휴지통 위치 때문에만 밀려난 보정. 해상도마다 답이 달라서
  // 저장하면 다른 화면의 배치를 덮어쓴다 — 그리기에만 쓰고 저장하지 않는다.
  screenDependent: boolean;
};

type RootDesktopLayout = {
  positions: Record<string, RootDesktopPlacement>;
  corrections: RootDesktopCorrection[];
  unresolvedLayoutKeys: string[];
};

type TrashRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

type LayoutBox = {
  bounds: RootDesktopBounds;
  maxX: number;
  maxY: number;
  trash: TrashRect;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isFiniteCoordinate(value: number) {
  return Number.isFinite(value);
}

function trashRectFor(bounds: RootDesktopBounds): TrashRect {
  const right = bounds.width - ROOT_TRASH_GAP_RIGHT;
  const bottom = bounds.height - ROOT_TRASH_GAP_BOTTOM;
  return {
    left: right - ROOT_TRASH_WIDTH,
    top: bottom - ROOT_TRASH_HEIGHT,
    right,
    bottom,
  };
}

function layoutBoxFor(
  bounds: RootDesktopBounds,
  reserveSidebar: boolean,
): LayoutBox {
  return {
    bounds,
    maxX:
      bounds.width -
      (reserveSidebar ? ROOT_SIDEBAR_RESERVED : 0) -
      ROOT_ICON_WIDTH,
    maxY: bounds.height - ROOT_ICON_HEIGHT,
    trash: trashRectFor(bounds),
  };
}

function overlapsTrashRect(
  position: Pick<RootDesktopPlacement, "x" | "y">,
  trash: TrashRect,
) {
  return (
    position.x < trash.right &&
    position.x + ROOT_ICON_WIDTH > trash.left &&
    position.y < trash.bottom &&
    position.y + ROOT_ICON_HEIGHT > trash.top
  );
}

export function rootPlacementOverlapsTrash(
  position: Pick<RootDesktopPlacement, "x" | "y">,
  bounds: RootDesktopBounds = ROOT_DESKTOP_BASE_BOUNDS,
) {
  return overlapsTrashRect(position, trashRectFor(bounds));
}

function isInsideRootDesktop(
  position: Pick<RootDesktopPlacement, "x" | "y">,
  box: LayoutBox,
) {
  return (
    isFiniteCoordinate(position.x) &&
    isFiniteCoordinate(position.y) &&
    position.x >= 0 &&
    position.y >= 0 &&
    position.x <= box.maxX &&
    position.y <= box.maxY
  );
}

function rectanglesOverlap(
  left: Pick<RootDesktopPlacement, "x" | "y">,
  right: Pick<RootDesktopPlacement, "x" | "y">,
) {
  return (
    left.x < right.x + ROOT_ICON_WIDTH &&
    left.x + ROOT_ICON_WIDTH > right.x &&
    left.y < right.y + ROOT_ICON_HEIGHT &&
    left.y + ROOT_ICON_HEIGHT > right.y
  );
}

function rootGridPositions(
  startX: number,
  startY: number,
  stepX: number,
  stepY: number,
  box: LayoutBox,
) {
  const positions: Array<{ x: number; y: number }> = [];
  for (let y = startY; y <= box.maxY; y += stepY) {
    for (let x = startX; x <= box.maxX; x += stepX) {
      positions.push({ x, y });
    }
  }
  return positions;
}

function baseGridPositions(box: LayoutBox) {
  return rootGridPositions(
    ROOT_GRID_X,
    ROOT_GRID_Y,
    ROOT_GRID_STEP_X,
    ROOT_GRID_STEP_Y,
    box,
  ).filter((position) => !overlapsTrashRect(position, box.trash));
}

// 창 크기마다 격자가 달라지므로 최근 것만 기억한다. 리사이즈 중에 무한히
// 쌓이지 않도록 캐시가 커지면 통째로 버린다.
const GRID_CACHE_LIMIT = 8;
const GRID_CACHE = new Map<string, ReturnType<typeof baseGridPositions>>();

function gridPositionsFor(box: LayoutBox) {
  const key = `${box.bounds.width}x${box.bounds.height}|${box.maxX}`;
  const cached = GRID_CACHE.get(key);
  if (cached) return cached;
  const computed = baseGridPositions(box);
  if (GRID_CACHE.size >= GRID_CACHE_LIMIT) GRID_CACHE.clear();
  GRID_CACHE.set(key, computed);
  return computed;
}

function denseGridPositionsAround(
  occupied: readonly Pick<RootDesktopPlacement, "x" | "y">[],
  box: LayoutBox,
) {
  const xOffsets = Array.from(
    new Set([
      0,
      box.maxX % ROOT_ICON_WIDTH,
      ...occupied.map((position) => position.x % ROOT_ICON_WIDTH),
    ]),
  ).sort((left, right) => left - right);
  const yOffsets = Array.from(
    new Set([
      0,
      box.maxY % ROOT_ICON_HEIGHT,
      ...occupied.map((position) => position.y % ROOT_ICON_HEIGHT),
    ]),
  ).sort((left, right) => left - right);
  let bestPositions: Array<{ x: number; y: number }> = [];
  let bestAvailableCount = -1;

  xOffsets.forEach((xOffset) => {
    yOffsets.forEach((yOffset) => {
      const positions = rootGridPositions(
        xOffset,
        yOffset,
        ROOT_ICON_WIDTH,
        ROOT_ICON_HEIGHT,
        box,
      ).filter((position) => !overlapsTrashRect(position, box.trash));
      const availableCount = positions.filter(
        (position) =>
          !occupied.some((current) => rectanglesOverlap(position, current)),
      ).length;
      if (availableCount > bestAvailableCount) {
        bestPositions = positions;
        bestAvailableCount = availableCount;
      }
    });
  });

  return bestPositions;
}

function defaultPosition(index: number) {
  return {
    x: ROOT_GRID_X + (index % ROOT_DEFAULT_COLUMNS) * ROOT_GRID_STEP_X,
    y:
      ROOT_GRID_Y +
      Math.floor(index / ROOT_DEFAULT_COLUMNS) * ROOT_GRID_STEP_Y,
  };
}

function clampedPosition(
  position: Pick<RootDesktopPlacement, "x" | "y">,
  box: LayoutBox,
) {
  const x = isFiniteCoordinate(position.x) ? position.x : 0;
  const y = isFiniteCoordinate(position.y) ? position.y : 0;
  return {
    x: clamp(x, 0, box.maxX),
    y: clamp(y, 0, box.maxY),
  };
}

function nearestEmptyGridPosition(
  target: Pick<RootDesktopPlacement, "x" | "y">,
  occupied: Array<Pick<RootDesktopPlacement, "x" | "y">>,
  candidates: readonly Pick<RootDesktopPlacement, "x" | "y">[],
) {
  return candidates.filter(
    (candidate) =>
      !occupied.some((position) => rectanglesOverlap(candidate, position)),
  ).sort((left, right) => {
    const leftDistance =
      (left.x - target.x) ** 2 + (left.y - target.y) ** 2;
    const rightDistance =
      (right.x - target.x) ** 2 + (right.y - target.y) ** 2;
    return leftDistance - rightDistance;
  })[0];
}

function nearestGridPosition(
  target: Pick<RootDesktopPlacement, "x" | "y">,
  candidates: readonly Pick<RootDesktopPlacement, "x" | "y">[],
) {
  return candidates.slice().sort((left, right) => {
    const leftDistance =
      (left.x - target.x) ** 2 + (left.y - target.y) ** 2;
    const rightDistance =
      (right.x - target.x) ** 2 + (right.y - target.y) ** 2;
    return leftDistance - rightDistance;
  })[0];
}

function isSystemDefaultPlacement(position: RootDesktopPlacement) {
  const column = (position.x - ROOT_GRID_X) / ROOT_GRID_STEP_X;
  const row = (position.y - ROOT_GRID_Y) / ROOT_GRID_STEP_Y;
  return (
    position.version >= 0 &&
    position.version <= 1 &&
    Number.isInteger(column) &&
    column >= 0 &&
    column < ROOT_DEFAULT_COLUMNS &&
    Number.isInteger(row) &&
    row >= 0
  );
}

export function normalizeRootDesktopLayout(
  entries: readonly RootDesktopEntry[],
  storedPositions: Readonly<Record<string, RootDesktopPlacement>>,
  options: {
    // 사이드바(#11)는 기본 데스크에만 있다 — 스페이스는 예약하지 않는다.
    reserveSidebar?: boolean;
    // 실제 아이콘 평면 크기. 창 크기를 모르면 기준 창으로 계산한다.
    bounds?: RootDesktopBounds;
  } = {},
): RootDesktopLayout {
  const box = layoutBoxFor(
    options.bounds ?? ROOT_DESKTOP_BASE_BOUNDS,
    options.reserveSidebar !== false,
  );
  const gridPositions = gridPositionsFor(box);
  const positions: Record<string, RootDesktopPlacement> = Object.create(null);
  const corrections: RootDesktopCorrection[] = [];
  const unresolvedLayoutKeys: string[] = [];
  const occupied: Array<Pick<RootDesktopPlacement, "x" | "y">> = [];
  const storedOutside: Array<{
    entry: RootDesktopEntry;
    stored: RootDesktopPlacement;
    index: number;
    screenDependent: boolean;
  }> = [];
  const missing: Array<{ entry: RootDesktopEntry; index: number }> = [];

  // 기본 격자가 다 차면 빽빽한 격자로 전환한다 — 열 수를 하드코딩하면
  // 사이드바 예약 폭(#14) 같은 경계 변경 때 어긋난다.
  const useDenseGrid = entries.length > gridPositions.length;

  entries.forEach((entry, index) => {
    const stored = storedPositions[entry.layoutKey];
    if (
      stored &&
      isInsideRootDesktop(stored, box) &&
      !overlapsTrashRect(stored, box.trash) &&
      (!useDenseGrid || !isSystemDefaultPlacement(stored))
    ) {
      positions[entry.layoutKey] = stored;
      occupied.push(stored);
      return;
    }
    if (stored) {
      // 좌표 자체는 멀쩡한데 이 화면에서만 밖으로 나간 경우(넓은 화면에서
      // 오른쪽 끝에 둔 아이콘을 좁은 화면에서 열었을 때)와, 데이터가 깨진
      // 경우를 구분한다. 앞의 것을 저장하면 넓은 화면의 배치가 지워진다.
      const screenDependent =
        isFiniteCoordinate(stored.x) &&
        isFiniteCoordinate(stored.y) &&
        stored.x >= 0 &&
        stored.y >= 0 &&
        !(useDenseGrid && isSystemDefaultPlacement(stored));
      storedOutside.push({ entry, stored, index, screenDependent });
    } else {
      missing.push({ entry, index });
    }
  });
  const denseGridPositions =
    useDenseGrid && (storedOutside.length > 0 || missing.length > 0)
      ? denseGridPositionsAround(occupied, box)
      : gridPositions;

  const placePosition = (
    entry: RootDesktopEntry,
    candidate: Pick<RootDesktopPlacement, "x" | "y">,
    version: number,
    needsCorrection: boolean,
    screenDependent: boolean,
    forceGrid = false,
  ) => {
    const nearest = clampedPosition(candidate, box);
    const requiresEmptySlot =
      forceGrid ||
      overlapsTrashRect(nearest, box.trash) ||
      occupied.some((current) => rectanglesOverlap(nearest, current));
    const candidates = forceGrid ? denseGridPositions : gridPositions;
    const emptyPosition = requiresEmptySlot
      ? nearestEmptyGridPosition(nearest, occupied, candidates)
      : nearest;
    const position =
      emptyPosition ??
      (overlapsTrashRect(nearest, box.trash)
        ? nearestGridPosition(nearest, candidates)
        : nearest);
    const placement = {
      ...position,
      version,
    };
    positions[entry.layoutKey] = placement;
    occupied.push(placement);
    if (!emptyPosition) {
      unresolvedLayoutKeys.push(entry.layoutKey);
      return;
    }
    if (
      needsCorrection &&
      (position.x !== candidate.x || position.y !== candidate.y)
    ) {
      corrections.push({
        layoutKey: entry.layoutKey,
        placement,
        screenDependent,
      });
    }
  };

  if (useDenseGrid) {
    [
      ...storedOutside,
      ...missing.map(({ entry, index }) => ({
        entry,
        index,
        stored: undefined,
        screenDependent: false,
      })),
    ]
      .sort((left, right) =>
        left.entry.layoutKey < right.entry.layoutKey
          ? -1
          : left.entry.layoutKey > right.entry.layoutKey
            ? 1
            : 0,
      )
      .forEach(({ entry, index, stored, screenDependent }) => {
        placePosition(
          entry,
          stored ?? defaultPosition(index),
          stored?.version ?? 0,
          Boolean(stored),
          screenDependent,
          true,
        );
      });
    return { positions, corrections, unresolvedLayoutKeys };
  }

  storedOutside
    .sort((left, right) =>
      left.entry.layoutKey < right.entry.layoutKey
        ? -1
        : left.entry.layoutKey > right.entry.layoutKey
          ? 1
          : 0,
    )
    .forEach(({ entry, stored, screenDependent }) => {
      placePosition(entry, stored, stored.version, true, screenDependent);
    });

  missing.forEach(({ entry, index }) => {
    placePosition(entry, defaultPosition(index), 0, false, false);
  });

  return { positions, corrections, unresolvedLayoutKeys };
}

export function moveRootDesktopGroup<
  T extends Pick<RootDesktopPlacement, "x" | "y">,
>(
  placements: readonly T[],
  deltaX: number,
  deltaY: number,
  options: {
    // 스페이스에는 사이드바가 없다 — 예약 없이 화면 끝까지 쓴다(#14).
    reserveSidebar?: boolean;
    bounds?: RootDesktopBounds;
  } = {},
): T[] {
  if (placements.length === 0) return [];
  const box = layoutBoxFor(
    options.bounds ?? ROOT_DESKTOP_BASE_BOUNDS,
    options.reserveSidebar !== false,
  );
  const minX = Math.min(...placements.map((placement) => placement.x));
  const maxX = Math.max(...placements.map((placement) => placement.x));
  const minY = Math.min(...placements.map((placement) => placement.y));
  const maxY = Math.max(...placements.map((placement) => placement.y));
  const safeDeltaX = clamp(
    Number.isFinite(deltaX) ? deltaX : 0,
    -minX,
    box.maxX - maxX,
  );
  const safeDeltaY = clamp(
    Number.isFinite(deltaY) ? deltaY : 0,
    -minY,
    box.maxY - maxY,
  );

  const movedWith = (x: number, y: number) =>
    placements.map((placement) => ({
      ...placement,
      x: placement.x + x,
      y: placement.y + y,
    }));
  const bounded = movedWith(safeDeltaX, safeDeltaY);
  if (!bounded.some((placement) => overlapsTrashRect(placement, box.trash))) {
    return bounded;
  }

  const minDeltaX = -minX;
  const maxDeltaX = box.maxX - maxX;
  const minDeltaY = -minY;
  const maxDeltaY = box.maxY - maxY;
  const xCandidates = new Set([safeDeltaX, 0, minDeltaX, maxDeltaX]);
  const yCandidates = new Set([safeDeltaY, 0, minDeltaY, maxDeltaY]);
  placements.forEach((placement) => {
    xCandidates.add(
      clamp(
        box.trash.left - ROOT_ICON_WIDTH - placement.x,
        minDeltaX,
        maxDeltaX,
      ),
    );
    xCandidates.add(
      clamp(box.trash.right - placement.x, minDeltaX, maxDeltaX),
    );
    yCandidates.add(
      clamp(
        box.trash.top - ROOT_ICON_HEIGHT - placement.y,
        minDeltaY,
        maxDeltaY,
      ),
    );
    yCandidates.add(
      clamp(box.trash.bottom - placement.y, minDeltaY, maxDeltaY),
    );
  });
  const candidateDeltas = [
    ...Array.from(xCandidates, (x) => ({ x, y: safeDeltaY })),
    ...Array.from(yCandidates, (y) => ({ x: safeDeltaX, y })),
    { x: 0, y: 0 },
  ].filter(
    (delta, index, all) =>
      all.findIndex(
        (candidate) => candidate.x === delta.x && candidate.y === delta.y,
      ) === index,
  );
  const candidates = candidateDeltas
    .map((delta) => ({ delta, placements: movedWith(delta.x, delta.y) }))
    .filter(({ placements: candidate }) =>
      candidate.every(
        (placement) => !overlapsTrashRect(placement, box.trash),
      ),
    )
    .sort((left, right) => {
      const leftDistance =
        (left.delta.x - safeDeltaX) ** 2 +
        (left.delta.y - safeDeltaY) ** 2;
      const rightDistance =
        (right.delta.x - safeDeltaX) ** 2 +
        (right.delta.y - safeDeltaY) ** 2;
      return leftDistance - rightDistance;
    });

  return candidates[0]?.placements ?? bounded;
}
