export const ROOT_DESKTOP_WIDTH = 1280;
export const ROOT_DESKTOP_HEIGHT = 628;
export const ROOT_ICON_WIDTH = 88;
export const ROOT_ICON_HEIGHT = 94;

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
    position.x <= ROOT_DESKTOP_WIDTH - ROOT_ICON_WIDTH &&
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
      x <= ROOT_DESKTOP_WIDTH - ROOT_ICON_WIDTH;
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
const ROOT_DENSE_GRID_POSITIONS = rootGridPositions(
  0,
  0,
  ROOT_ICON_WIDTH,
  ROOT_ICON_HEIGHT,
).filter((position) => !rootPlacementOverlapsTrash(position));

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
    x: clamp(x, 0, ROOT_DESKTOP_WIDTH - ROOT_ICON_WIDTH),
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
  }> = [];
  const missing: Array<{ entry: RootDesktopEntry; index: number }> = [];

  const useDenseGrid = entries.length >= 78;

  entries.forEach((entry, index) => {
    const stored = storedPositions[entry.layoutKey];
    if (
      stored &&
      isInsideRootDesktop(stored) &&
      !rootPlacementOverlapsTrash(stored) &&
      !useDenseGrid
    ) {
      positions[entry.layoutKey] = stored;
      occupied.push(stored);
      return;
    }
    if (stored) storedOutside.push({ entry, stored });
    else missing.push({ entry, index });
  });

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
    const emptyPosition = requiresEmptySlot
      ? nearestEmptyGridPosition(
          nearest,
          occupied,
          forceGrid ? ROOT_DENSE_GRID_POSITIONS : ROOT_GRID_POSITIONS,
        )
      : nearest;
    const position = emptyPosition ?? nearest;
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
    entries
      .map((entry, index) => ({
        entry,
        index,
        stored: storedPositions[entry.layoutKey],
      }))
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
    ROOT_DESKTOP_WIDTH - ROOT_ICON_WIDTH - maxX,
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
  const maxDeltaX = ROOT_DESKTOP_WIDTH - ROOT_ICON_WIDTH - maxX;
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
