// 데스크 간 복사는 받는 데스크의 서버가 보내는 데스크의 공개 링크로 직접
// 접속해 내용을 가져온다. 서버가 남이 준 주소로 접속하는 동작이므로 허용 범위를
// ShareDesk 공개 링크 모양으로 좁힌다 — 내부망·클라우드 메타데이터 주소를 애초에
// 표현할 수 없게 만드는 편이, 받은 주소를 사후에 걸러 내는 것보다 확실하다.
//
// linkId는 share-links의 randomBytes(24).toString("hex")이므로 48자 hex다.

// 붙여넣기 실수로 들어오는 긴 쓰레기 값을 파싱 전에 자른다.
const MAX_INPUT_LENGTH = 2048;
const SHARE_PATH = /^\/api\/share\/([0-9a-f]{48})$/;

// 호스트가 IP 리터럴이면 도메인 검사를 건너뛴 사설·루프백 지정이 가능해진다.
// 데스크는 사람이 쓰는 도메인으로 배포되므로 IP 형태는 받지 않는다.
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// 로컬·내부망 전용 이름. 공개 도메인은 반드시 점을 포함하므로(friend.vercel.app)
// 점 없는 단일 라벨은 내부망 호스트명(localhost, router, intranet)으로 본다.
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

export interface DeskTransferSource {
  origin: string;
  linkId: string;
  // 파일 바이트를 받는 주소. 폴더 링크는 entryId로 내부 항목을 지정한다.
  fileUrl: string;
  // 링크 메타와 폴더 목록을 받는 주소.
  manifestUrl: string;
}

function isIpLiteralHost(hostname: string): boolean {
  // URL 파서는 IPv6를 대괄호로 감싸 준다.
  if (hostname.startsWith("[")) return true;
  return IPV4.test(hostname);
}

// 공개 인터넷에서 접근할 수 있는 이름인지 본다. IP 리터럴, 점 없는 단일 라벨,
// 로컬 전용 접미사를 모두 거른다.
function isPubliclyRoutableHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (!host || isIpLiteralHost(host)) return false;
  if (!host.includes(".")) return false;
  return !LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * 받은 문자열이 다른 데스크의 공개 링크인지 확인하고, 가져올 주소를 만든다.
 * 형태가 어긋나면 null을 돌려준다 — 호출자는 이유를 노출하지 않고 거부한다.
 */
export function parseDeskTransferLink(input: unknown): DeskTransferSource | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!trimmed || trimmed.length > MAX_INPUT_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  // https만 받는다. http는 중간에서 내용이 바뀔 수 있고 file:·data:는 서버
  // 로컬 자원을 가리킨다.
  if (url.protocol !== "https:") return null;
  // user:pass@host 형태로 파서를 헷갈리게 하는 입력을 막는다.
  if (url.username || url.password) return null;
  if (!isPubliclyRoutableHost(url.hostname)) return null;
  if (url.port) return null;

  const matched = SHARE_PATH.exec(url.pathname);
  if (!matched) return null;
  const linkId = matched[1];

  return {
    origin: url.origin,
    linkId,
    fileUrl: `${url.origin}/api/share/${linkId}`,
    manifestUrl: `${url.origin}/api/share/${linkId}?format=json`,
  };
}

/**
 * 폴더 링크 안의 특정 항목을 가리키는 주소를 만든다. entryId는 보내는 데스크가
 * 목록으로 알려 준 값만 들어오므로 형태만 확인한다.
 */
export function deskTransferEntryUrls(
  source: DeskTransferSource,
  entryId: string,
): { fileUrl: string; manifestUrl: string } | null {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(entryId)) return null;
  const query = `entryId=${encodeURIComponent(entryId)}`;
  return {
    fileUrl: `${source.fileUrl}?${query}`,
    manifestUrl: `${source.fileUrl}?format=json&${query}`,
  };
}
