// 폴더 색 팔레트의 순수 정의(#14) — 서버·클라이언트 공용. 저장 로직
// (folder-colors.ts)은 저장소 모듈을 끌고 오므로 클라이언트 컴포넌트는
// 반드시 이 파일에서 가져온다(roles.ts와 같은 관례).

export const FOLDER_COLOR_IDS = [
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "indigo",
  "violet",
] as const;

export type FolderColorId = (typeof FOLDER_COLOR_IDS)[number];

export function parseFolderColor(value: unknown): FolderColorId | null {
  return FOLDER_COLOR_IDS.includes(value as FolderColorId)
    ? (value as FolderColorId)
    : null;
}
