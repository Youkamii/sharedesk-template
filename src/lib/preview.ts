// 미리보기 가능 형식의 단일 진실 원천. 클라이언트(어떤 창을 열지)·다운로드
// 라우트(inline로 내보내도 되는지)·local 어댑터(확장자→mime 추정)가 공유한다.
// 셋 다 순수 함수라 클라이언트 컴포넌트에서 import해도 안전하다.

export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text";

const GOOGLE_PDF_PREVIEW_MIMES = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.drawing",
]);

export function isGoogleWorkspacePreviewMime(mimeType: string): boolean {
  return GOOGLE_PDF_PREVIEW_MIMES.has(mimeType);
}

// 스크립트 실행형(html·svg·xml)은 의도적으로 뺐다 — inline로 나가면 앱 도메인
// 저장형 XSS가 된다. 여기에 없는 확장자는 미리보기 불가·다운로드로만 처리된다.
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  flac: "audio/flac",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  log: "text/plain",
  json: "application/json",
};

export function extensionOf(name: string): string {
  return name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
}

// local 어댑터가 확장자로 Content-Type을 추정할 때 쓴다. 목록에 없으면 옥텟.
export function guessMime(name: string): string {
  return EXT_MIME[extensionOf(name)] ?? "application/octet-stream";
}

// mime이 없거나 옥텟이면(예: local 드라이버) 확장자로 보정한 mime을 돌려준다.
function effectiveMime(mimeType: string | null, name: string): string | null {
  if (mimeType && mimeType !== "application/octet-stream") return mimeType;
  return EXT_MIME[extensionOf(name)] ?? null;
}

function classify(mime: string): PreviewKind | null {
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mime)) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || isGoogleWorkspacePreviewMime(mime)) {
    return "pdf";
  }
  if (mime.startsWith("text/") || mime === "application/json") return "text";
  return null;
}

// 클라이언트: 이 항목을 어떤 미리보기 창으로 열지 (null이면 다운로드).
export function previewKindOf(entry: {
  isFolder: boolean;
  name: string;
  mimeType: string | null;
}): PreviewKind | null {
  if (entry.isFolder) return null;
  const mime = effectiveMime(entry.mimeType, entry.name);
  return mime ? classify(mime) : null;
}

// 다운로드 라우트: inline로 내보내도 안전한 Content-Type을 돌려준다(없으면 null
// → attachment). 텍스트류는 브라우저가 절대 실행하지 않도록 text/plain으로 강제.
export function inlineContentType(mimeType: string): string | null {
  const base = mimeType.split(";")[0].trim().toLowerCase();
  if (base === "application/pdf") return base;
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(base)) return base;
  if (base.startsWith("video/") || base.startsWith("audio/")) return base;
  if (base.startsWith("text/") || base === "application/json") {
    return "text/plain; charset=utf-8";
  }
  return null;
}
