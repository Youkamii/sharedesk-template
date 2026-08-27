import type { ReactNode } from "react";
import type { FolderColorId } from "@/lib/folder-colors";

export interface PixelFileIconProps {
  entry: {
    name: string;
    isFolder: boolean;
    mimeType: string | null;
  };
  size?: number;
  // 폴더 색(#14) — 무지개 팔레트 id. 없으면 기본 amber.
  folderColor?: FolderColorId | null;
  // 공개 폴더로 등록된 폴더면 공유 배지를 얹는다(#14).
  shared?: boolean;
}

type FileKind =
  | "document"
  | "image"
  | "pdf"
  | "archive"
  | "audio"
  | "video"
  | "word"
  | "sheet"
  | "slides"
  | "text"
  | "code"
  | "exe";

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

// 대표 확장자 아이콘(#14) — 한눈에 구분되는 종류부터.
const WORD_EXTENSIONS = [".doc", ".docx", ".hwp", ".hwpx", ".odt", ".rtf"];
const SHEET_EXTENSIONS = [".csv", ".ods", ".tsv", ".xls", ".xlsx"];
const SLIDES_EXTENSIONS = [".key", ".odp", ".ppt", ".pptx"];
const TEXT_EXTENSIONS = [".log", ".md", ".txt"];
const CODE_EXTENSIONS = [
  ".bat",
  ".c",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".php",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
];
const EXE_EXTENSIONS = [".apk", ".app", ".deb", ".dmg", ".exe", ".msi"];

// 폴더 색(#14) — 도트 팔레트 톤의 무지개. [본체, 윗줄 하이라이트, 아랫줄].
const FOLDER_PALETTE: Record<
  FolderColorId | "default",
  [string, string, string]
> = {
  default: [COLORS.amber, COLORS.light, COLORS.orange],
  red: ["#e96872", "#f7a8ad", "#b04a52"],
  orange: ["#e7a064", "#f4c39a", "#b5754a"],
  yellow: ["#ffd27d", "#ffe9b0", "#cf9a52"],
  green: ["#8fbf7f", "#c6e3b8", "#5f8b57"],
  blue: ["#79a8e8", "#b8d4f6", "#4a6fae"],
  indigo: ["#6f6fb0", "#a8a8d8", "#4a4a80"],
  violet: ["#a97fc9", "#d3b3ea", "#7a5595"],
};

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
  if (
    hasExtension(name, WORD_EXTENSIONS) ||
    mime.includes("wordprocessingml") ||
    mime.includes("msword") ||
    mime.includes("hwp")
  ) {
    return "word";
  }
  if (
    hasExtension(name, SHEET_EXTENSIONS) ||
    mime.includes("spreadsheetml") ||
    mime.includes("ms-excel") ||
    mime === "text/csv"
  ) {
    return "sheet";
  }
  if (
    hasExtension(name, SLIDES_EXTENSIONS) ||
    mime.includes("presentationml") ||
    mime.includes("ms-powerpoint")
  ) {
    return "slides";
  }
  if (hasExtension(name, EXE_EXTENSIONS)) return "exe";
  if (hasExtension(name, CODE_EXTENSIONS)) return "code";
  if (hasExtension(name, TEXT_EXTENSIONS) || mime === "text/plain") {
    return "text";
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

function FolderIcon({
  size,
  color,
  shared,
}: {
  size: number;
  color?: FolderColorId | null;
  shared?: boolean;
}) {
  const [body, light, stripe] = FOLDER_PALETTE[color ?? "default"];
  return (
    <SvgFrame size={size}>
      <path d="M4 7H10L12 9H21V21H4Z" fill={COLORS.shadow} transform="translate(2 2)" />
      <path d="M2 5H9L11 7H20V19H2Z" fill={COLORS.outline} />
      <path d="M4 7H8L10 9H18V17H4Z" fill={body} />
      <path d="M4 9H18V11H4Z" fill={light} />
      <path d="M4 15H18V17H4Z" fill={stripe} />
      {shared && (
        // 공유 배지(#14) — 우하단 teal 판에 밖으로 나가는 픽셀 화살표.
        <>
          <path d="M12 12H23V23H12Z" fill={COLORS.outline} />
          <path d="M13 13H22V22H13Z" fill={COLORS.teal} />
          <path d="M15 19H18V17H16V15H20V20H15Z" fill={COLORS.light} />
          <path d="M18 13H22V17H20V15H18Z" fill={COLORS.amber} />
        </>
      )}
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

// 문서형 공통 — 색판 + 라벨 획으로 종류를 구분한다.
function WordIcon({ size }: { size: number }) {
  return (
    <FileShell size={size}>
      <path d="M5 9H17V17H5Z" fill={COLORS.blue} />
      {/* W */}
      <path
        d="M6 11H8V14H9V12H11V14H12V11H14V16H11V15H9V16H6Z"
        fill={COLORS.light}
      />
    </FileShell>
  );
}

function SheetIcon({ size }: { size: number }) {
  return (
    <FileShell size={size}>
      <path d="M5 9H17V17H5Z" fill={COLORS.moss} />
      {/* 표 격자 */}
      <path d="M6 10H16V11H6ZM6 13H16V14H6Z" fill={COLORS.light} />
      <path d="M9 10H10V16H9ZM13 10H14V16H13Z" fill={COLORS.light} />
    </FileShell>
  );
}

function SlidesIcon({ size }: { size: number }) {
  return (
    <FileShell size={size}>
      <path d="M5 9H17V17H5Z" fill={COLORS.orange} />
      {/* 발표 판 + 그래프 막대 */}
      <path d="M6 10H16V16H6Z" fill={COLORS.light} />
      <path d="M7 13H9V15H7ZM10 11H12V15H10ZM13 12H15V15H13Z" fill={COLORS.coral} />
    </FileShell>
  );
}

function TextIcon({ size }: { size: number }) {
  return (
    <FileShell size={size}>
      <path
        d="M6 10H16V11H6ZM6 12H14V13H6ZM6 14H16V15H6ZM6 16H12V17H6Z"
        fill={COLORS.teal}
      />
    </FileShell>
  );
}

function CodeIcon({ size }: { size: number }) {
  return (
    <FileShell size={size}>
      <path d="M5 9H17V17H5Z" fill={COLORS.outline} />
      {/* < / > */}
      <path d="M9 10L6 13L9 16V14L8 13L9 12ZM13 10V12L14 13L13 14V16L16 13Z" fill={COLORS.teal} />
      <path d="M10 16L12 10H13L11 16Z" fill={COLORS.amber} />
    </FileShell>
  );
}

function ExeIcon({ size }: { size: number }) {
  return (
    <FileShell size={size}>
      <path d="M5 9H17V17H5Z" fill={COLORS.coral} />
      {/* 실행 톱니 느낌의 다이아 + 재생 표시 */}
      <path d="M11 9L14 13L11 17L8 13Z" fill={COLORS.light} />
      <path d="M10 12H13V14H10Z" fill={COLORS.outline} />
    </FileShell>
  );
}

export default function PixelFileIcon({
  entry,
  size = 52,
  folderColor,
  shared,
}: PixelFileIconProps) {
  if (entry.isFolder) {
    return <FolderIcon size={size} color={folderColor} shared={shared} />;
  }

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
    case "word":
      return <WordIcon size={size} />;
    case "sheet":
      return <SheetIcon size={size} />;
    case "slides":
      return <SlidesIcon size={size} />;
    case "text":
      return <TextIcon size={size} />;
    case "code":
      return <CodeIcon size={size} />;
    case "exe":
      return <ExeIcon size={size} />;
    default:
      return <DocumentIcon size={size} />;
  }
}
