export type LayoutPosition = {
  x: number;
  y: number;
  version: number;
};

type LayoutEntry = {
  id: string;
  layoutKey: string;
};

type LayoutData<TEntry extends LayoutEntry> = {
  entries: TEntry[];
  positions: Record<string, LayoutPosition>;
};

export type LayoutMigrationTarget = {
  scopeId: string;
  folderId: string;
  folderIdentity: string | null;
  position: { x: number; y: number };
};

export type LayoutMigrationGroup = {
  folderId: string;
  folderIdentity: string;
  position: { x: number; y: number };
  scopeIds: string[];
};

export function migrateEntryLayoutKey<
  TEntry extends LayoutEntry,
  TData extends LayoutData<TEntry>,
>(
  data: TData,
  previousEntry: TEntry,
  nextEntry: TEntry,
  displayedPosition?: LayoutPosition,
): TData {
  if (!data.entries.some((entry) => entry.id === previousEntry.id)) return data;
  const entries = data.entries.map((entry) =>
    entry.id === previousEntry.id ? nextEntry : entry,
  );
  if (previousEntry.layoutKey === nextEntry.layoutKey) {
    return { ...data, entries };
  }

  const position =
    displayedPosition ??
    data.positions[previousEntry.layoutKey] ??
    data.positions[nextEntry.layoutKey];
  const positions = { ...data.positions };
  delete positions[previousEntry.layoutKey];
  if (position) {
    positions[nextEntry.layoutKey] = {
      x: position.x,
      y: position.y,
      version: 0,
    };
  }
  return { ...data, entries, positions };
}

export function migrateLayoutKeys(
  layoutKeys: readonly string[],
  previousLayoutKey: string,
  nextLayoutKey: string,
): readonly string[] {
  if (
    previousLayoutKey === nextLayoutKey ||
    !layoutKeys.includes(previousLayoutKey)
  ) {
    return layoutKeys;
  }
  return [
    ...new Set(
      layoutKeys.map((layoutKey) =>
        layoutKey === previousLayoutKey ? nextLayoutKey : layoutKey,
      ),
    ),
  ];
}

export function migrateLayoutKey(
  layoutKey: string | null,
  previousLayoutKey: string,
  nextLayoutKey: string,
) {
  return layoutKey === previousLayoutKey ? nextLayoutKey : layoutKey;
}

export function groupLayoutMigrationTargets(
  targets: readonly LayoutMigrationTarget[],
  preferredScopeId: string | null,
): LayoutMigrationGroup[] {
  const targetsByFolder = new Map<string, LayoutMigrationTarget[]>();
  for (const target of targets) {
    const current = targetsByFolder.get(target.folderId) ?? [];
    current.push(target);
    targetsByFolder.set(target.folderId, current);
  }
  return [...targetsByFolder].flatMap(([folderId, folderTargets]) => {
    const representative =
      folderTargets.find(
        (target) =>
          target.scopeId === preferredScopeId && target.folderIdentity,
      ) ?? folderTargets.find((target) => target.folderIdentity);
    if (!representative?.folderIdentity) return [];
    return [
      {
        folderId,
        folderIdentity: representative.folderIdentity,
        position: representative.position,
        scopeIds: [...new Set(folderTargets.map((target) => target.scopeId))],
      },
    ];
  });
}
