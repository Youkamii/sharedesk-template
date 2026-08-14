export const ROOT_DESKTOP_WIDTH = 1280;
export const ROOT_DESKTOP_HEIGHT = 628;
export const ROOT_ICON_WIDTH = 88;
export const ROOT_ICON_HEIGHT = 94;

const ROOT_GRID_X = 12;
const ROOT_GRID_Y = 10;
const ROOT_GRID_STEP_X = 96;
const ROOT_GRID_STEP_Y = 104;
const ROOT_DEFAULT_COLUMNS = 6;

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

function rootGridPositions() {
  const positions: Array<{ x: number; y: number }> = [];
  for (
    let y = ROOT_GRID_Y;
    y <= ROOT_DESKTOP_HEIGHT - ROOT_ICON_HEIGHT;
    y += ROOT_GRID_STEP_Y
  ) {
    for (
      let x = ROOT_GRID_X;
      x <= ROOT_DESKTOP_WIDTH - ROOT_ICON_WIDTH;
      x += ROOT_GRID_STEP_X
    ) {
      positions.push({ x, y });
    }
  }
  return positions;
}

const ROOT_GRID_POSITIONS = rootGridPositions();

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
) {
  return ROOT_GRID_POSITIONS.filter(
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
  const occupied: Array<Pick<RootDesktopPlacement, "x" | "y">> = [];
  const storedOutside: Array<{
    entry: RootDesktopEntry;
    stored: RootDesktopPlacement;
  }> = [];
  const missing: Array<{ entry: RootDesktopEntry; index: number }> = [];

  entries.forEach((entry, index) => {
    const stored = storedPositions[entry.layoutKey];
    if (stored && isInsideRootDesktop(stored)) {
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
  ) => {
    const nearest = clampedPosition(candidate);
    const position = occupied.some((current) =>
      rectanglesOverlap(nearest, current),
    )
      ? (nearestEmptyGridPosition(nearest, occupied) ?? nearest)
      : nearest;
    const placement = {
      ...position,
      version,
    };
    positions[entry.layoutKey] = placement;
    occupied.push(placement);
    if (needsCorrection) {
      corrections.push({ layoutKey: entry.layoutKey, placement });
    }
  };

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

  return { positions, corrections };
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

  return placements.map((placement) => ({
    ...placement,
    x: placement.x + safeDeltaX,
    y: placement.y + safeDeltaY,
  }));
}
