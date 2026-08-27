export const ROOT_DESKTOP_WIDTH = 1280;
export const ROOT_DESKTOP_HEIGHT = 628;
export const ROOT_ICON_WIDTH = 88;
export const ROOT_ICON_HEIGHT = 94;
// 우측 가장자리 사이드바(#11)가 여는 패널 폭. 아이콘은 이 예약 영역에
// 들어갈 수 없다(#14) — 패널이 열려도 아이콘이 가려지지 않고, 이미 그
// 안에 저장된 좌표는 normalize가 안전한 자리로 보정한다.
export const ROOT_SIDEBAR_RESERVED = 232;
const ROOT_ICON_MAX_X =
  ROOT_DESKTOP_WIDTH - ROOT_SIDEBAR_RESERVED - ROOT_ICON_WIDTH;

const ROOT_GRID_X = 12;
const ROOT_GRID_Y = 10;
const ROOT_GRID_STEP_X = 96;
const ROOT_GRID_STEP_Y = 104;
const ROOT_DEFAULT_COLUMNS = 6;
const ROOT_TRASH_LEFT = 1190;
const ROOT_TRASH_TOP = 534;
const ROOT_TRASH_RIGHT = 1262;
const ROOT_TRASH_BOTTOM = 610;

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
};

type RootDesktopLayout = {
  positions: Record<string, RootDesktopPlacement>;
  corrections: RootDesktopCorrection[];
  unresolvedLayoutKeys: string[];
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function isFiniteCoordinate(value: number) {
  return Number.isFinite(value);
}

function isInsideRootDesktop(position: Pick<RootDesktopPlacement, "x" | "y">) {
  return (
    isFiniteCoordinate(position.x) &&
    isFiniteCoordinate(position.y) &&
    position.x >= 0 &&
    position.y >= 0 &&
    position.x <= ROOT_ICON_MAX_X &&
    position.y <= ROOT_DESKTOP_HEIGHT - ROOT_ICON_HEIGHT
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

export function rootPlacementOverlapsTrash(
  position: Pick<RootDesktopPlacement, "x" | "y">,
) {
  return (
    position.x < ROOT_TRASH_RIGHT &&
    position.x + ROOT_ICON_WIDTH > ROOT_TRASH_LEFT &&
    position.y < ROOT_TRASH_BOTTOM &&
    position.y + ROOT_ICON_HEIGHT > ROOT_TRASH_TOP
  );
}

function rootGridPositions(
  startX: number,
  startY: number,
  stepX: number,
  stepY: number,
) {
  const positions: Array<{ x: number; y: number }> = [];
  for (
    let y = startY;
    y <= ROOT_DESKTOP_HEIGHT - ROOT_ICON_HEIGHT;
    y += stepY
  ) {
    for (
      let x = startX;
      x <= ROOT_ICON_MAX_X;
      x += stepX
    ) {
      positions.push({ x, y });
    }
  }
  return positions;
}

const ROOT_GRID_POSITIONS = rootGridPositions(
  ROOT_GRID_X,
  ROOT_GRID_Y,
  ROOT_GRID_STEP_X,
  ROOT_GRID_STEP_Y,
).filter((position) => !rootPlacementOverlapsTrash(position));

function denseGridPositionsAround(
  occupied: readonly Pick<RootDesktopPlacement, "x" | "y">[],
) {
  const xOffsets = Array.from(
    new Set([
      0,
      ROOT_ICON_MAX_X % ROOT_ICON_WIDTH,
      ...occupied.map((position) => position.x % ROOT_ICON_WIDTH),
    ]),
  ).sort((left, right) => left - right);
  const yOffsets = Array.from(
    new Set([
      0,
      (ROOT_DESKTOP_HEIGHT - ROOT_ICON_HEIGHT) % ROOT_ICON_HEIGHT,
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
      ).filter((position) => !rootPlacementOverlapsTrash(position));
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

function clampedPosition(position: Pick<RootDesktopPlacement, "x" | "y">) {
  const x = isFiniteCoordinate(position.x) ? position.x : 0;
  const y = isFiniteCoordinate(position.y) ? position.y : 0;
  return {
    x: clamp(x, 0, ROOT_ICON_MAX_X),
    y: clamp(y, 0, ROOT_DESKTOP_HEIGHT - ROOT_ICON_HEIGHT),
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
): RootDesktopLayout {
  const positions: Record<string, RootDesktopPlacement> = Object.create(null);
  const corrections: RootDesktopCorrection[] = [];
  const unresolvedLayoutKeys: string[] = [];
  const occupied: Array<Pick<RootDesktopPlacement, "x" | "y">> = [];
  const storedOutside: Array<{
    entry: RootDesktopEntry;
    stored: RootDesktopPlacement;
    index: number;
  }> = [];
  const missing: Array<{ entry: RootDesktopEntry; index: number }> = [];

  // 기본 격자가 다 차면 빽빽한 격자로 전환한다 — 열 수를 하드코딩하면
  // 사이드바 예약 폭(#14) 같은 경계 변경 때 어긋난다.
  const useDenseGrid = entries.length > ROOT_GRID_POSITIONS.length;

  entries.forEach((entry, index) => {
    const stored = storedPositions[entry.layoutKey];
    if (
      stored &&
      isInsideRootDesktop(stored) &&
      !rootPlacementOverlapsTrash(stored) &&
      (!useDenseGrid || !isSystemDefaultPlacement(stored))
    ) {
      positions[entry.layoutKey] = stored;
      occupied.push(stored);
      return;
    }
    if (stored) storedOutside.push({ entry, stored, index });
    else missing.push({ entry, index });
  });
  const denseGridPositions =
    useDenseGrid && (storedOutside.length > 0 || missing.length > 0)
      ? denseGridPositionsAround(occupied)
      : ROOT_GRID_POSITIONS;

  const placePosition = (
    entry: RootDesktopEntry,
    candidate: Pick<RootDesktopPlacement, "x" | "y">,
    version: number,
    needsCorrection: boolean,
    forceGrid = false,
  ) => {
    const nearest = clampedPosition(candidate);
    const requiresEmptySlot =
      forceGrid ||
      rootPlacementOverlapsTrash(nearest) ||
      occupied.some((current) => rectanglesOverlap(nearest, current));
    const candidates = forceGrid
      ? denseGridPositions
      : ROOT_GRID_POSITIONS;
    const emptyPosition = requiresEmptySlot
      ? nearestEmptyGridPosition(
          nearest,
          occupied,
          candidates,
        )
      : nearest;
    const position =
      emptyPosition ??
      (rootPlacementOverlapsTrash(nearest)
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
      corrections.push({ layoutKey: entry.layoutKey, placement });
    }
  };

  if (useDenseGrid) {
    [
      ...storedOutside,
      ...missing.map(({ entry, index }) => ({
        entry,
        index,
        stored: undefined,
      })),
    ]
      .sort((left, right) =>
        left.entry.layoutKey < right.entry.layoutKey
          ? -1
          : left.entry.layoutKey > right.entry.layoutKey
            ? 1
            : 0,
      )
      .forEach(({ entry, index, stored }) => {
        placePosition(
          entry,
          stored ?? defaultPosition(index),
          stored?.version ?? 0,
          Boolean(stored),
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
    .forEach(({ entry, stored }) => {
      placePosition(entry, stored, stored.version, true);
    });

  missing.forEach(({ entry, index }) => {
    placePosition(entry, defaultPosition(index), 0, false);
  });

  return { positions, corrections, unresolvedLayoutKeys };
}

export function moveRootDesktopGroup<
  T extends Pick<RootDesktopPlacement, "x" | "y">,
>(placements: readonly T[], deltaX: number, deltaY: number): T[] {
  if (placements.length === 0) return [];
  const minX = Math.min(...placements.map((placement) => placement.x));
  const maxX = Math.max(...placements.map((placement) => placement.x));
  const minY = Math.min(...placements.map((placement) => placement.y));
  const maxY = Math.max(...placements.map((placement) => placement.y));
  const safeDeltaX = clamp(
    Number.isFinite(deltaX) ? deltaX : 0,
    -minX,
    ROOT_ICON_MAX_X - maxX,
  );
  const safeDeltaY = clamp(
    Number.isFinite(deltaY) ? deltaY : 0,
    -minY,
    ROOT_DESKTOP_HEIGHT - ROOT_ICON_HEIGHT - maxY,
  );

  const movedWith = (x: number, y: number) =>
    placements.map((placement) => ({
      ...placement,
      x: placement.x + x,
      y: placement.y + y,
    }));
  const bounded = movedWith(safeDeltaX, safeDeltaY);
  if (!bounded.some(rootPlacementOverlapsTrash)) return bounded;

  const minDeltaX = -minX;
  const maxDeltaX = ROOT_ICON_MAX_X - maxX;
  const minDeltaY = -minY;
  const maxDeltaY = ROOT_DESKTOP_HEIGHT - ROOT_ICON_HEIGHT - maxY;
  const xCandidates = new Set([safeDeltaX, 0, minDeltaX, maxDeltaX]);
  const yCandidates = new Set([safeDeltaY, 0, minDeltaY, maxDeltaY]);
  placements.forEach((placement) => {
    xCandidates.add(
      clamp(
        ROOT_TRASH_LEFT - ROOT_ICON_WIDTH - placement.x,
        minDeltaX,
        maxDeltaX,
      ),
    );
    xCandidates.add(
      clamp(ROOT_TRASH_RIGHT - placement.x, minDeltaX, maxDeltaX),
    );
    yCandidates.add(
      clamp(
        ROOT_TRASH_TOP - ROOT_ICON_HEIGHT - placement.y,
        minDeltaY,
        maxDeltaY,
      ),
    );
    yCandidates.add(
      clamp(ROOT_TRASH_BOTTOM - placement.y, minDeltaY, maxDeltaY),
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
      candidate.every((placement) => !rootPlacementOverlapsTrash(placement)),
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
