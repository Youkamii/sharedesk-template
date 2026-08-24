// 좁은 화면 목록의 표시 규칙. 화면 컴포넌트에서 떼어 두어 테스트로 고정한다.

export interface MobileEntry {
  id: string;
  name: string;
  isFolder: boolean;
  size: number | null;
  mimeType: string | null;
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
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

/** 폴더를 위로 올리고 그 안에서 이름순으로 정렬한다. 원본은 건드리지 않는다. */
export function sortEntries(entries: MobileEntry[]): MobileEntry[] {
  return [...entries].sort((left, right) => {
    if (left.isFolder !== right.isFolder) return left.isFolder ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}
