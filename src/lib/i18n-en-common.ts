// 로그인·참여·대기 화면과 공용 문구의 영어 번역.
// 키는 한국어 원문 그대로이며, {이름} 꼴 자리표시자는 번역에도 유지해야 한다.
export const EN_COMMON: Record<string, string> = {
  "언어": "Language",
  "한국어": "한국어",
  "English": "English",

  // 로그인 화면 (src/app/page.tsx)
  "구글 로그인이 취소되었습니다.": "Google sign-in was cancelled.",
  "로그인 요청이 유효하지 않습니다. 다시 시도해 주세요.":
    "The sign-in request was not valid. Please try again.",
  "구글 인증에 실패했습니다.": "Google authentication failed.",
  "계정 정보를 가져오지 못했습니다.": "We couldn't fetch your account info.",
  "이메일이 확인되지 않은 계정입니다.": "This account's email is not verified.",
  "구글 로그인이 아직 설정되지 않았습니다.": "Google sign-in isn't set up yet.",
  "로그인 요청이 유효하지 않습니다.": "The sign-in request was not valid.",
  "처음 이용하려면 Google 로그인 뒤 관리자가 만든 초대 코드를 입력해야 합니다.":
    "To get started, sign in with Google and then enter an invite code created by the admin.",
  "초대 코드가 올바르지 않거나 새 코드로 교체됐습니다.":
    "The invite code is incorrect or has been replaced with a new one.",
  "현재 비활성화된 초대입니다. 관리자에게 문의해 주세요.":
    "This invite is currently disabled. Please contact the admin.",
  "이미 사용 완료된 초대 코드입니다.": "This invite code has already been used.",
  "사용 기간이 끝난 초대 코드입니다.": "This invite code has expired.",
  "차단된 사용자입니다. 관리자에게 문의해 주세요.":
    "This account is blocked. Please contact the admin.",
  "로그인에 실패했습니다.": "Sign-in failed.",
  "호스트의 Google Drive 저장 공간을 여러 사람이 함께 쓰는 ShareDesk입니다. 초대받았다면 별도 설치 없이 내 Google 계정으로 로그인하고, 처음 한 번만 호스트가 준 초대 코드를 입력하세요.":
    "This ShareDesk shares the host's Google Drive storage with several people. If you were invited, there's nothing to install — sign in with your own Google account and enter the invite code from your host just once.",
  "OAuth 없는 로컬 모드입니다. 아래 손님용 키로 시작하세요.":
    "Local mode without OAuth. Start with the guest key below.",
  "이 ShareDesk는 아직 설치가 끝나지 않았습니다. 데스크 소유자는 Google OAuth와 Drive 연결을 마쳐 주세요.":
    "This ShareDesk isn't fully set up yet. Desk owner: please finish the Google OAuth and Drive connection.",
  "설치 준비 중": "Setting up",
  "설치가 끝나면 이 주소가 로그인 화면이 됩니다.":
    "Once setup is finished, this address becomes the sign-in screen.",
  "Google로 계속하기": "Continue with Google",
  "설치 안내 열기": "Open the install guide",
  "또는 손님용 키": "or with a guest key",
  "내 Drive로 새 공유 공간을 열고 싶나요?":
    "Want to open a new shared space with your own Drive?",
  "내 Google Drive 용량을 여러 사람과 함께 쓸 새 공유 공간을 열 때만 설치하세요. 누군가에게 초대받은 참여자라면 GitHub, Vercel, OAuth 설정 없이 위의 Google 로그인만 하면 됩니다.":
    "Install only when opening a new shared space where others use your Google Drive storage. If someone invited you, just sign in with Google above — no GitHub, Vercel, or OAuth setup needed.",
  "호스트 설치 안내": "Host install guide",

  // 접속 키 폼 (src/app/KeyForm.tsx, /api/auth 서버 에러 포함)
  "접속 키": "Access key",
  "확인 중...": "Checking...",
  "키로 입장": "Enter with key",
  "키가 올바르지 않습니다.": "The key is incorrect.",
  "서버에 연결할 수 없습니다.": "Couldn't connect to the server.",
  "키 입장이 꺼져 있습니다": "Key entry is turned off",
  "시도가 너무 많습니다. 잠시 후 다시 시도하세요":
    "Too many attempts. Please try again later",
  "키가 올바르지 않습니다": "The key is incorrect",

  // 데스크 가입 화면 (src/app/join)
  "데스크 가입": "Join this desk",
  "관리자에게 받은 기간제 초대 코드를 입력하세요. 1회용은 한 명이 가입하면 끝납니다. 기간 내 무제한은 만료되거나 관리자가 끌 때까지 여러 명이 함께 씁니다.":
    "Enter the time-limited invite code you received from the admin. A single-use code is spent once one person joins. An unlimited code can be shared by several people until it expires or the admin turns it off.",
  "입력 횟수가 너무 많습니다. 잠시 뒤 다시 시도해 주세요.":
    "Too many attempts. Please try again in a moment.",
  "로그인 정보를 확인하지 못했습니다. 다시 로그인해 주세요.":
    "We couldn't verify your sign-in. Please sign in again.",
  "초대 코드를 확인하지 못했습니다.": "We couldn't verify the invite code.",
  "다른 Google 계정을 쓰려면 먼저 로그아웃하세요.":
    "To use a different Google account, sign out first.",
  // "초대 코드"는 EN_ADMIN에도 있는 키 — 값이 반드시 같아야 한다 (tests/i18n.test.ts).
  "초대 코드": "Invitation code",
  "코드로 데스크 가입": "Join with code",

  // 접근 차단 화면 (src/app/pending)
  "접근이 막혀 있습니다": "Access is blocked",
  "관리자가 이 계정의 접근을 막았습니다.":
    "The admin has blocked access for this account.",

  // 역할·권한 (공용 — 관리자·파일 화면과 API 403 본문이 함께 쓰는 문구.
  // en-admin/en-files에는 넣지 않는다. tests/i18n.test.ts가 충돌을 잡는다.)
  "수정 가능": "Can edit",
  "올리기 가능": "Can upload",
  "보기 전용": "View only",
  "역할": "Role",
  "이 작업을 할 권한이 없습니다": "You don't have permission to do this",
  "역할 값을 확인해 주세요": "Please check the role value",

  // 공용
  "로그아웃": "Sign out",
  // 서버 공용 오류 문구 (여러 API가 함께 쓴다)
  "잘못된 요청입니다": "Invalid request",
  "언어 값을 확인해 주세요": "Please check the language value",

  // 데스크 목록·멀티 데스크 관리 (#12)
  "데스크 목록": "Desks",
  "들어갈 데스크를 고르세요.": "Choose a desk to enter.",
  "기본 데스크": "Main desk",
  "입장": "Enter",
  "아직 들어갈 수 있는 스페이스가 없습니다.": "No spaces you can enter yet.",
  "스페이스 관리": "Manage spaces",
  "주소": "Address",
  "이름": "Name",
  "주소는 영문 소문자·숫자·하이픈 1~32자입니다.":
    "The address is 1-32 characters of lowercase letters, digits, and hyphens.",
  "멤버 관리": "Manage members",
  "멤버 추가": "Add member",
  "추가": "Add",
  "제거": "Remove",
  "등록 해제": "Unregister",
  "정말 해제할까요?": "Really unregister?",
  "등록만 해제하며 파일은 저장소에 남습니다.":
    "Only the registration is removed; files stay in storage.",
  "구성원이 없습니다.": "No members.",
  "기본 데스크의 승인된 사용자만 추가할 수 있습니다.":
    "Only approved users of the main desk can be added.",
};
