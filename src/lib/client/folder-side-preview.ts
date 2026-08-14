import { previewKindOf } from "@/lib/preview";

export type FolderSidePreviewEntry = {
  layoutKey: string;
  name: string;
  isFolder: boolean;
  mimeType: string | null;
};

export function folderImagePreviewEntries<T extends FolderSidePreviewEntry>(
  entries: readonly T[],
) {
  return entries.filter(
    (entry) => !entry.isFolder && previewKindOf(entry) === "image",
  );
}

export function adjacentFolderImagePreviewKey<
  T extends FolderSidePreviewEntry,
>(
  entries: readonly T[],
  currentLayoutKey: string,
  direction: -1 | 1,
) {
  const previewEntries = folderImagePreviewEntries(entries);
  const currentIndex = previewEntries.findIndex(
    (entry) => entry.layoutKey === currentLayoutKey,
  );
  if (currentIndex < 0) return previewEntries.at(0)?.layoutKey ?? null;
  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= previewEntries.length) return null;
  return previewEntries[nextIndex].layoutKey;
}
