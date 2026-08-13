import { previewKindOf } from "@/lib/preview";

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
