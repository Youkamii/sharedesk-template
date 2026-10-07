// 공유·간이 링크 받기 화면(#17 B-3)의 순수 규칙. API 라우트(어느 요청을
// 화면으로 보낼지·미리보기를 inline으로 내도 되는지)와 화면(남은 시간·주소)이
// 함께 쓴다. 저장소·Node 전용 import가 없어 클라이언트 컴포넌트에서도 쓴다.

import { guessMime, inlineContentType, previewKindOf } from "@/lib/preview";

export const SHARE_LINK_ID_PATTERN = /^[a-f0-9]{48}$/;

// 받기 화면 주소. 링크 주소(/api/share/<linkId>) 자체는 그대로 두고, 브라우저로
// 연 요청만 이 화면으로 보낸다 — 공개 폴더 화면과 같은 /public 아래(예약어)라
// 새 최상위 경로를 만들지 않는다.
export function shareLandingPath(
  linkId: string,
  entryId: string | null = null,
): string {
  const base = `/public/share/${encodeURIComponent(linkId)}`;
  return entryId ? `${base}?entryId=${encodeURIComponent(entryId)}` : base;
}

// 화면이 부르는 파일 주소. download=1은 지금까지처럼 바로 내려받고(받아 간
// 횟수도 여기서만 센다), preview=1은 안전한 형식만 inline으로 연다.
export function shareFileUrl(
  linkId: string,
  entryId: string | null,
  mode: "download" | "preview",
): string {
  const params = new URLSearchParams();
  if (entryId) params.set("entryId", entryId);
  params.set(mode, "1");
  return `/api/share/${encodeURIComponent(linkId)}?${params.toString()}`;
}

// Accept에 text/html이 (q=0이 아닌 채로) 있으면 사람이 브라우저로 연 것으로 본다.
// curl·wget·다운로드 관리자·다른 데스크의 서버 fetch는 */*나 JSON을 보낸다.
export function acceptsHtml(accept: string | null | undefined): boolean {
  if (!accept) return false;
  return accept.split(",").some((part) => {
    const [type, ...params] = part
      .split(";")
      .map((piece) => piece.trim().toLowerCase());
    if (type !== "text/html") return false;
    const quality = params.find((param) => param.startsWith("q="));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });
}

// 링크 주소로 온 요청 중 받기 화면으로 보낼 것. 기계용 목록(format=json)·
// 실제 내려받기(download=1)·미리보기(preview=1)는 언제나 그대로 처리한다.
export function wantsShareLanding(
  accept: string | null | undefined,
  searchParams: URLSearchParams,
): boolean {
  if (searchParams.get("format") === "json") return false;
  if (searchParams.get("download") === "1") return false;
  if (searchParams.get("preview") === "1") return false;
  return acceptsHtml(accept);
}

export type ShareLandingPreview = "image" | "pdf" | "text";

// 받기 화면의 작은 미리보기는 이미지·PDF·텍스트만. 판정은 데스크 미리보기와
// 같은 함수(previewKindOf)에, inline 허용은 다운로드 라우트와 같은 가드
// (inlineContentType)에 맡긴다. previewKindOf는 저장소가 변환해 줄 수 있는
// 형식(오피스·구글 문서)도 pdf로 보지만, 받기 화면은 원본을 그대로 내므로
// 원본 형식이 안전할 때만 미리보기로 친다.
export function shareLandingPreviewKind(entry: {
  isFolder: boolean;
  name: string;
  mimeType: string | null;
}): ShareLandingPreview | null {
  if (entry.isFolder) return null;
  const kind = previewKindOf(entry);
  if (kind !== "image" && kind !== "pdf" && kind !== "text") return null;
  return inlineContentType(effectiveMime(entry), entry.name) ? kind : null;
}

// 저장소가 형식을 모르면(옥텟 — 간이 링크의 숨김 임시 파일처럼 저장 이름에
// 확장자가 없을 때) 링크에 적힌 이름의 확장자로 보정한다. 보정해도 내보내는
// 형식은 아래 inline 가드가 정한 안전한 값(이미지·PDF·text/plain)뿐이고
// nosniff가 붙어, 이름만 바꾼 HTML이 화면에서 실행되지 않는다.
function effectiveMime(entry: { name: string; mimeType: string | null }): string {
  return entry.mimeType && entry.mimeType !== "application/octet-stream"
    ? entry.mimeType
    : guessMime(entry.name);
}

// 링크 라우트의 미리보기(preview=1) 응답 형식. 미리보기 대상이 아니면 null —
// 라우트는 내주지 않는다.
export function shareLandingInlineType(file: {
  name: string;
  mimeType: string | null;
}): string | null {
  return shareLandingPreviewKind({ ...file, isFolder: false })
    ? inlineContentType(effectiveMime(file), file.name)
    : null;
}

export interface ShareRemaining {
  expired: boolean;
  totalSeconds: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

// 만료까지 남은 시간. 서버 판정(만료 시각 <= 지금이면 닫힘)과 같게, 남은
// 1초 미만은 1초로 올려 0이 되는 순간이 곧 닫히는 순간이 되게 한다.
export function shareLinkRemaining(
  expiresAt: string,
  now: number,
): ShareRemaining {
  const end = Date.parse(expiresAt);
  const totalSeconds =
    Number.isFinite(end) && Number.isFinite(now)
      ? Math.max(0, Math.ceil((end - now) / 1000))
      : 0;
  return {
    expired: totalSeconds <= 0,
    totalSeconds,
    days: Math.floor(totalSeconds / 86_400),
    hours: Math.floor((totalSeconds % 86_400) / 3_600),
    minutes: Math.floor((totalSeconds % 3_600) / 60),
    seconds: totalSeconds % 60,
  };
}

export type RemainingTranslator = (
  text: string,
  vars?: Record<string, string | number>,
) => string;

const two = (value: number) => String(value).padStart(2, "0");

// "1일 02:03:04 남음" / "02:03:04 남음" / "닫혔습니다". 시:분:초는 언어와
// 상관없는 숫자 꼴이라 자리표시자로 넣는다.
export function formatShareRemaining(
  remaining: ShareRemaining,
  t: RemainingTranslator,
): string {
  if (remaining.expired) return t("닫혔습니다");
  const time = `${two(remaining.hours)}:${two(remaining.minutes)}:${two(remaining.seconds)}`;
  return remaining.days > 0
    ? t("{days}일 {time} 남음", { days: remaining.days, time })
    : t("{time} 남음", { time });
}

// 화면을 쓰지 않는 요청(브라우저가 아닌 도구)이 받는 옛 폴더 목록 HTML의
// 꼬리말용. 서버는 보는 사람의 시간대를 모르므로 UTC로 적는다.
export function formatUtcExpiry(expiresAt: string): string {
  const end = new Date(expiresAt);
  if (!Number.isFinite(end.getTime())) return "";
  return `${end.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export interface ShareLandingEntry {
  id: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  mimeType: string | null;
}

export interface ShareLandingModel {
  linkId: string;
  kind: "file" | "folder";
  // 링크 이름(폴더 링크면 맨 위 폴더 이름).
  rootName: string;
  // 링크를 만든 사람의 표시 이름. 비어 있으면 화면이 줄을 감춘다.
  sender: string;
  expiresAt: string;
  // 지금 보는 항목을 가리키는 entryId. 링크가 가리키는 항목 자신이면 null —
  // 그 id는 화면에 싣지 않는다(local 저장소 id는 경로를 감싼 값이라, 목록
  // manifest처럼 링크만 아는 외부에 폴더 구조를 흘리지 않게).
  entryId: string | null;
  current: {
    name: string;
    isFolder: boolean;
    size: number | null;
    mimeType: string | null;
    preview: ShareLandingPreview | null;
  };
  // 폴더면 바로 아래 항목(파일 링크·폴더 안 파일이면 null).
  entries: ShareLandingEntry[] | null;
}

// 화면에 넘길 값만 골라 담는다. 링크 장부의 fileId·만든 사람 id 같은 내부 값은
// 여기서 걸러져 클라이언트(RSC 페이로드)로 나가지 않는다.
export function describeShareLanding(
  link: {
    linkId: string;
    name: string;
    kind: "file" | "folder";
    createdBy: string;
    expiresAt: string;
  },
  entryId: string | null,
  entry: {
    name: string;
    isFolder: boolean;
    size: number | null;
    mimeType: string | null;
  },
  children: readonly ShareLandingEntry[] | null,
): ShareLandingModel {
  return {
    linkId: link.linkId,
    kind: link.kind,
    rootName: link.name,
    sender: link.createdBy.trim(),
    expiresAt: link.expiresAt,
    entryId,
    current: {
      name: entry.name,
      isFolder: entry.isFolder,
      size: entry.size,
      mimeType: entry.mimeType,
      preview: shareLandingPreviewKind(entry),
    },
    entries: children
      ? children.map((child) => ({
          id: child.id,
          name: child.name,
          isFolder: child.isFolder,
          size: child.size,
          mimeType: child.mimeType,
        }))
      : null,
  };
}
