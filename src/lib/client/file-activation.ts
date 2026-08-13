import {
  isGoogleWorkspacePreviewMime,
  previewKindOf,
} from "@/lib/preview";

type ActivatableEntry = Parameters<typeof previewKindOf>[0];

export type FileActivationAction = "folder" | "preview" | "download";

export function fileActivationAction(
  entry: ActivatableEntry,
  downloadFirst: boolean,
): FileActivationAction {
  if (entry.isFolder) return "folder";
  if (previewKindOf(entry) && !downloadFirst) return "preview";
  return "download";
}

export function downloadFileName(
  entry: Pick<ActivatableEntry, "name" | "mimeType">,
): string {
  if (
    entry.mimeType !== null &&
    isGoogleWorkspacePreviewMime(entry.mimeType) &&
    !entry.name.toLowerCase().endsWith(".pdf")
  ) {
    return `${entry.name}.pdf`;
  }
  return entry.name;
}
