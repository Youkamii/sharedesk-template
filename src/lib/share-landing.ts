// 공유·간이 링크 받기 화면(#17 B-3)의 순수 규칙. API 라우트(어느 요청을
// 화면으로 보낼지·미리보기를 inline으로 내도 되는지)와 화면(남은 시간·주소)이
// 함께 쓴다. 저장소·Node 전용 import가 없어 클라이언트 컴포넌트에서도 쓴다.

import { effectiveMime, inlineContentType, previewKindOf } from "@/lib/preview";

export const SHARE_LINK_ID_PATTERN = /^[a-f0-9]{48}$/;

// 링크 주소 — 사람이 나눠 받은 원래 꼴. 받기 화면의 "링크 주소 복사"가 이 꼴을
// 준다(다른 데스크에서 받기·도구가 그대로 쓴다). 폴더 안 항목이면 entryId를 붙인다.
export function shareLinkPath(
  linkId: string,
  entryId: string | null = null,
): string {
  const base = `/api/share/${encodeURIComponent(linkId)}`;
  return entryId ? `${base}?entryId=${encodeURIComponent(entryId)}` : base;
}

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

// 미리보기로 내주는 크기 상한. 미리보기는 받아 간 횟수(B-7)에 세지 않으므로,
// 큰 파일이 세지 않는 내려받기 통로가 되지 않게 상한을 둔다 — 넘으면 라우트가
// 내주지 않는다(415). 텍스트는 크기와 상관없이 앞부분만 낸다. 상한 이하의 작은
// 이미지·PDF는 미리보기로도 통째 받을 수 있다(그만큼은 세지 않는다).
export const SHARE_PREVIEW_MAX_BYTES: Record<ShareLandingPreview, number> = {
  image: 8 * 1024 * 1024,
  pdf: 16 * 1024 * 1024,
  text: 64 * 1024,
};

// 받기 화면의 작은 미리보기는 이미지·PDF·텍스트만. 판정은 데스크 미리보기와
// 같은 함수(previewKindOf)에, inline 허용은 다운로드 라우트와 같은 가드
// (inlineContentType)에 맡긴다. previewKindOf는 저장소가 변환해 줄 수 있는
// 형식(오피스·구글 문서)도 pdf로 보지만, 받기 화면은 원본을 그대로 내므로
// 원본 형식이 안전할 때만 미리보기로 친다. 저장소가 형식을 모르면(옥텟 — 간이
// 링크의 숨김 임시 파일처럼 저장 이름에 확장자가 없을 때) 링크에 적힌 이름의
// 확장자로 보정한다(preview.ts의 effectiveMime). 보정해도 내보내는 형식은 inline
// 가드가 정한 안전한 값(이미지·PDF·text/plain)뿐이고 nosniff가 붙는다.
function inlinePreview(entry: {
  isFolder: boolean;
  name: string;
  mimeType: string | null;
}): { kind: ShareLandingPreview; inlineType: string } | null {
  if (entry.isFolder) return null;
  const kind = previewKindOf(entry);
  if (kind !== "image" && kind !== "pdf" && kind !== "text") return null;
  const mime = effectiveMime(entry.mimeType, entry.name);
  const inlineType = mime ? inlineContentType(mime, entry.name) : null;
  return inlineType ? { kind, inlineType } : null;
}

export function shareLandingPreviewKind(entry: {
  isFolder: boolean;
  name: string;
  mimeType: string | null;
}): ShareLandingPreview | null {
  return inlinePreview(entry)?.kind ?? null;
}

// 링크 라우트의 미리보기(preview=1) 판정 — 내보낼 형식·종류·크기 상한.
// 미리보기 대상이 아니면 null이고 라우트는 내주지 않는다.
export function shareLandingPreviewPlan(file: {
  name: string;
  mimeType: string | null;
}): {
  kind: ShareLandingPreview;
  inlineType: string;
  maxBytes: number;
} | null {
  const preview = inlinePreview({ ...file, isFolder: false });
  return preview
    ? { ...preview, maxBytes: SHARE_PREVIEW_MAX_BYTES[preview.kind] }
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

// 브라우저 시계와 서버 시계의 차이. 받기 화면은 서버가 그린 시각(renderedAt)과
// 브라우저가 처음 잰 시각의 차이를 보정값으로 잡아, 남은 시간·닫힘 판정을 서버
// 시계로 잰다 — 시계가 틀린 PC에서 아직 열린 링크를 닫혔다고 하거나 그 반대가
// 되지 않게. 페이지가 오는 데 걸린 시간만큼은 남은 시간이 조금 길게 보일 수 있다.
export function serverClockOffset(serverNow: number, clientNow: number): number {
  return Number.isFinite(serverNow) && Number.isFinite(clientNow)
    ? serverNow - clientNow
    : 0;
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
  // 보낸 사람 — 링크를 만든 멤버의 데스크 별명(nickname)일 때만 싣는다. 링크
  // 장부의 createdBy는 구글 실명(없으면 이메일)이라 링크만 아는 외부에 내보내지
  // 않는다. 별명이 없으면 null이고 화면은 줄 자체를 감춘다.
  sender: string | null;
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

// 화면에 넘길 값만 골라 담는다. 링크 장부의 fileId·만든 사람 id·만든 사람
// 실명(createdBy) 같은 내부 값은 받지도 않아 클라이언트(RSC 페이로드)로 나가지
// 않는다. senderNickname은 서버가 명단에서 찾은 데스크 별명(없으면 null).
export function describeShareLanding(
  link: {
    linkId: string;
    name: string;
    kind: "file" | "folder";
    expiresAt: string;
  },
  senderNickname: string | null,
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
    sender: senderNickname?.trim() || null,
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
