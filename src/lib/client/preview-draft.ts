export type PreviewDiscardReason = "saving" | "unsaved" | null;

type PreviewDraftState = {
  editable: boolean;
  text: string | null;
  originalText: string | null;
  saving: boolean;
};

export function previewDiscardReason(
  preview: PreviewDraftState,
): PreviewDiscardReason {
  if (!preview.editable) return null;
  if (preview.saving) return "saving";
  return preview.text !== preview.originalText ? "unsaved" : null;
}
