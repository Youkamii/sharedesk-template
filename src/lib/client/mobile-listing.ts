// 좁은 화면 목록의 표시 규칙. 화면 컴포넌트에서 떼어 두어 테스트로 고정한다.

export interface MobileEntry {
  id: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  mimeType: string | null;
  // 목록 응답에 함께 오는 낙관적 버전 — 이동(move)의 expectedVersion에 쓴다.
  // 없으면 이동 동작을 감춘다(#15 A-1).
  version?: string;
  modifiedAt?: string | null;
}

const UNITS = ["KB", "MB", "GB", "TB"] as const;

/** 목록 한 줄에 붙는 크기 표시. 폴더처럼 크기를 모르면 빈 문자열이다. */
export function formatSize(size: number | null): string {
  if (size === null || !Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // 한 자리 수는 소수점까지 보여 줘야 1.2 MB와 9.8 MB가 구분된다.
  let shown = value < 10 ? value.toFixed(1) : String(Math.round(value));
  // 반올림 결과가 1024가 되면 한 단계 올린다. 그러지 않으면 1MiB보다 1바이트
  // 작은 값이 "1024 KB"로 나와 "1.0 MB"보다 큰 것처럼 보인다.
  if (Number(shown) >= 1024 && unit < UNITS.length - 1) {
    unit += 1;
    shown = (value / 1024).toFixed(1);
  }
  return `${shown} ${UNITS[unit]}`;
}

/** 폴더를 위로 올리고 그 안에서 이름순으로 정렬한다. 원본은 건드리지 않는다. */
export function sortEntries(entries: MobileEntry[]): MobileEntry[] {
  return [...entries].sort((left, right) => {
    if (left.isFolder !== right.isFolder) return left.isFolder ? -1 : 1;
    // 데스크탑(FilesView의 sortedEntries)과 같은 기준이어야 PC와 폰의
    // 순서가 갈리지 않는다.
    return left.name.localeCompare(right.name, "ko");
  });
}
