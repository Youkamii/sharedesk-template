import type { ReactNode } from "react";

export interface PixelFileIconProps {
  entry: {
    name: string;
    isFolder: boolean;
    mimeType: string | null;
  };
  size?: number;
}

type FileKind = "document" | "image" | "pdf" | "archive" | "audio" | "video";

const COLORS = {
  outline: "#1b1b2f",
  shadow: "#0e1830",
  paper: "#f4e7c5",
  light: "#fff8e7",
  teal: "#2d5c5b",
  moss: "#6f8b72",
  amber: "#ffd98b",
  orange: "#e7a064",
  coral: "#c9615f",
  blue: "#416b8d",
} as const;

const IMAGE_EXTENSIONS = [
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
];

const ARCHIVE_EXTENSIONS = [
  ".7z",
  ".bz",
  ".bz2",
  ".gz",
  ".rar",
  ".tar",
  ".tar.gz",
  ".tgz",
  ".xz",
  ".zip",
];

const AUDIO_EXTENSIONS = [
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".wma",
];

const VIDEO_EXTENSIONS = [
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".ogv",
  ".webm",
];

const ARCHIVE_MIME_MARKERS = [
  "/zip",
  "7z-compressed",
  "archive",
  "bzip",
  "gzip",
  "rar-compressed",
  "x-compress",
  "x-gtar",
  "x-rar",
  "x-tar",
  "x-xz",
  "x-zip",
];

function hasExtension(name: string, extensions: string[]): boolean {
  return extensions.some((extension) => name.endsWith(extension));
}

function fileKind(entry: PixelFileIconProps["entry"]): FileKind {
  const name = entry.name.toLowerCase();
  const mime = entry.mimeType?.toLowerCase() ?? "";

  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("image/") || hasExtension(name, IMAGE_EXTENSIONS)) {
    return "image";
  }
  if (mime.startsWith("audio/") || hasExtension(name, AUDIO_EXTENSIONS)) {
    return "audio";
  }
  if (mime.startsWith("video/") || hasExtension(name, VIDEO_EXTENSIONS)) {
    return "video";
  }
  if (
    hasExtension(name, ARCHIVE_EXTENSIONS) ||
    ARCHIVE_MIME_MARKERS.some((marker) => mime.includes(marker))
  ) {
    return "archive";
  }
  return "document";
}

function SvgFrame({ children, size }: { children: ReactNode; size: number }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      shapeRendering="crispEdges"
      style={{ display: "block", imageRendering: "pixelated" }}
    >
      {children}
    </svg>
  );
}

function FolderIcon({ size }: { size: number }) {
  return (
    <SvgFrame size={size}>
      <path d="M4 7H10L12 9H21V21H4Z" fill={COLORS.shadow} transform="translate(2 2)" />
      <path d="M2 5H9L11 7H20V19H2Z" fill={COLORS.outline} />
      <path d="M4 7H8L10 9H18V17H4Z" fill={COLORS.amber} />
      <path d="M4 9H18V11H4Z" fill={COLORS.light} />
      <path d="M4 15H18V17H4Z" fill={COLORS.orange} />
    </SvgFrame>
  );
}

function FileShell({ children, size }: { children: ReactNode; size: number }) {
  return (
    <SvgFrame size={size}>
      <path d="M4 3H15L21 9V22H4Z" fill={COLORS.shadow} transform="translate(2 2)" />
      <path d="M2 1H14L20 7V20H2Z" fill={COLORS.outline} />
      <path d="M4 3H13V8H18V18H4Z" fill={COLORS.paper} />
      <path d="M14 3L18 7H14Z" fill={COLORS.light} />
      {children}
    </SvgFrame>
  );
}

function DocumentIcon({ size }: { size: number }) {
  return (
    <FileShell size={size}>
      <path d="M6 10H16V12H6ZM6 14H16V16H6Z" fill={COLORS.teal} />
      <path d="M6 6H10V8H6Z" fill={COLORS.orange} />
    </FileShell>
  );
}

function ImageIcon({ size }: { size: number }) {
  return (
    <FileShell size={size}>
      <path d="M5 9H17V17H5Z" fill={COLORS.blue} />
      <path d="M6 15L9 12L11 14L14 11L17 15V17H6Z" fill={COLORS.moss} />
      <path d="M7 10H9V12H7Z" fill={COLORS.amber} />
    </FileShell>
  );
}

function PdfIcon({ size }: { size: number }) {
  return (
    <FileShell size={size}>
      <path d="M5 10H17V17H5Z" fill={COLORS.coral} />
      <path d="M7 12H11V14H9V16H7ZM12 12H16V14H14V16H12Z" fill={COLORS.light} />
    </FileShell>
  );
}

function ArchiveIcon({ size }: { size: number }) {
  return (
    <SvgFrame size={size}>
      <path d="M4 6H22V22H4Z" fill={COLORS.shadow} transform="translate(2 2)" />
      <path d="M2 4H20V20H2Z" fill={COLORS.outline} />
      <path d="M4 6H18V18H4Z" fill={COLORS.orange} />
      <path d="M4 6H18V9H4Z" fill={COLORS.amber} />
      <path d="M10 6H13V18H10Z" fill={COLORS.teal} />
      <path d="M11 8H13V10H11ZM10 11H12V13H10ZM11 14H13V16H11Z" fill={COLORS.light} />
    </SvgFrame>
  );
}

function AudioIcon({ size }: { size: number }) {
  return (
    <FileShell size={size}>
      <path d="M10 8H17V11H12V16H10Z" fill={COLORS.blue} />
      <path d="M7 14H11V17H7ZM14 13H18V16H14Z" fill={COLORS.teal} />
      <path d="M12 9H17V10H12Z" fill={COLORS.light} />
    </FileShell>
  );
}

function VideoIcon({ size }: { size: number }) {
  return (
    <FileShell size={size}>
      <path d="M5 9H17V17H5Z" fill={COLORS.teal} />
      <path d="M9 11L14 13L9 16Z" fill={COLORS.amber} />
      <path d="M5 9H7V11H5ZM15 9H17V11H15ZM5 15H7V17H5ZM15 15H17V17H15Z" fill={COLORS.light} />
    </FileShell>
  );
}

export default function PixelFileIcon({
  entry,
  size = 52,
}: PixelFileIconProps) {
  if (entry.isFolder) return <FolderIcon size={size} />;

  switch (fileKind(entry)) {
    case "image":
      return <ImageIcon size={size} />;
    case "pdf":
      return <PdfIcon size={size} />;
    case "archive":
      return <ArchiveIcon size={size} />;
    case "audio":
      return <AudioIcon size={size} />;
    case "video":
      return <VideoIcon size={size} />;
    default:
      return <DocumentIcon size={size} />;
  }
}
