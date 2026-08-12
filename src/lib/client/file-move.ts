export type MoveFailureKind = "definitive" | "uncertain";
export type DragTerminalAction = "ignore" | "cleanup" | "commit" | "discard";

const DEFINITIVE_MOVE_FAILURE_STATUSES = new Set([400, 401, 404, 409]);

export function classifyMoveFailure(error: unknown): MoveFailureKind {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return "uncertain";
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === "number" && DEFINITIVE_MOVE_FAILURE_STATUSES.has(status)
    ? "definitive"
    : "uncertain";
}

export function isDragPointer(activePointerId: number, eventPointerId: number) {
  return activePointerId === eventPointerId;
}

export function dragTerminalAction(
  eventType: "pointerup" | "pointercancel",
  ownsPointer: boolean,
  moved: boolean,
): DragTerminalAction {
  if (!ownsPointer) return "ignore";
  if (!moved) return "cleanup";
  return eventType === "pointercancel" ? "discard" : "commit";
}

export function foldersAwaitingIdle(
  folderIds: readonly string[],
  pendingCounts: ReadonlyMap<string, number>,
) {
  return [...new Set(folderIds)].filter(
    (folderId) => (pendingCounts.get(folderId) ?? 0) > 0,
  );
}

export function shouldRetryFolderReconciliation(
  folderIds: readonly string[],
  pendingCounts: ReadonlyMap<string, number>,
  startedVersions: ReadonlyMap<string, number>,
  currentVersions: ReadonlyMap<string, number>,
) {
  return [...new Set(folderIds)].some(
    (folderId) =>
      (pendingCounts.get(folderId) ?? 0) > 0 ||
      (startedVersions.get(folderId) ?? 0) !==
        (currentVersions.get(folderId) ?? 0),
  );
}

export function needsDetachedFolderRefresh(visibleInstanceCount: number) {
  return visibleInstanceCount === 0;
}

export function confirmedMoveEntries<T extends { id: string }>(
  entries: readonly T[],
  originalEntryId: string,
  confirmedEntry: T,
): T[] {
  return [
    ...entries.filter(
      (entry) =>
        entry.id !== originalEntryId && entry.id !== confirmedEntry.id,
    ),
    confirmedEntry,
  ];
}

export function windowsContainingFolder<
  T extends { id: string; path: readonly { id: string }[] },
>(windows: readonly T[], folderId: string): T[] {
  return windows.filter((window) =>
    window.path.some((crumb) => crumb.id === folderId),
  );
}
