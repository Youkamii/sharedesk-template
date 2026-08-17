// 역할 4단계 파일 권한(#80)의 공용 어휘. 서버·클라이언트가 함께 import하는
// 순수 모듈이므로 서버 전용 의존(저장소·환경변수)을 두지 않는다.
//
// 저장 역할(UserRole)은 users.json에 남는 값이고, 세션 역할(SessionRole)은
// 접속자마다 계산되는 값이다 — ADMIN_EMAILS 사용자는 저장값과 무관하게 "admin",
// 접속 키 손님은 "viewer"가 된다(판정은 auth.ts의 resolveSession이 한다).

export const USER_ROLES = ["editor", "uploader", "viewer"] as const;

export type UserRole = (typeof USER_ROLES)[number];

export type SessionRole = "admin" | UserRole;

// 저장소에서 읽은 알 수 없는 값을 저장 역할로 정규화한다.
// 역할 도입 전 users.json에는 role이 없다 — 기존 사용자는 "editor"로 읽는다.
export function resolveUserRole(value: unknown): UserRole {
  return USER_ROLES.includes(value as UserRole) ? (value as UserRole) : "editor";
}

// 새 항목을 만들 수 있는가 — 업로드·새 폴더·바탕 배치 저장.
export function canUpload(role: SessionRole): boolean {
  return role === "admin" || role === "editor" || role === "uploader";
}

// 기존 항목을 바꿀 수 있는가 — 편집·이름 변경·이동·삭제·휴지통 조작.
export function canEdit(role: SessionRole): boolean {
  return role === "admin" || role === "editor";
}

// 저장 역할의 한국어 라벨(고정). admin 표시는 기존 "관리자" 문구를 그대로 쓴다.
export const ROLE_LABELS: Record<UserRole, string> = {
  editor: "수정 가능",
  uploader: "올리기 가능",
  viewer: "보기 전용",
};
