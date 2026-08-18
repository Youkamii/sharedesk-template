// 관리자 화면(AdminView)의 영어 번역. 키는 한국어 원문 그대로.
// {이름} 꼴 자리표시자는 번역에도 그대로 유지해야 한다.
export const EN_ADMIN: Record<string, string> = {
  // 헤더 — 페이지 제목은 아래 "관리자" 키를 그대로 쓴다.
  "등록 중…": "Registering…",
  "현재 설치 등록": "Register this install",
  "등록부 확인 중": "Checking registry",
  "파일로 돌아가기": "Back to files",

  // 상단 알림
  "초대 코드 입력을 기다리는 사용자가 {인원}명 있습니다.":
    "{인원} user(s) are waiting to enter an invitation code.",

  // 초대 코드 섹션
  "초대 코드": "Invitation code",
  "받는 사람을 미리 지정하지 않습니다. Google 로그인 후 가입 대기 중인 사용자가 코드를 입력해 가입합니다. 1회용은 한 명이 가입하면 소진됩니다. 기간 내 무제한은 만료되거나 관리자가 끌 때까지 여러 명이 함께 씁니다.":
    "Recipients are not designated in advance. After signing in with Google, a user waiting to join enters the code to sign up. A single-use code is consumed once one person joins. An unlimited code can be shared by several people until it expires or an admin turns it off.",
  "유효 기간": "Valid for",
  "사용 방식": "Usage type",
  "초대 코드 생성": "Create invitation code",
  "생성 중…": "Creating…",
  "지금 전달할 초대 코드": "Invitation code to share now",
  "생성된 초대 코드": "Generated invitation code",
  "코드 복사": "Copy code",
  "초대 코드의 만료일, 사용 기록, 상태와 관리 작업":
    "Invitation code expiry, usage history, status, and management actions",
  "만료일": "Expires",
  "사용 기록": "Usage history",
  "생성 정보": "Created",
  "상태": "Status",
  "관리 작업": "Management actions",
  "불러오는 중…": "Loading…",
  "아직 만든 초대가 없습니다": "No invitations created yet",
  "{횟수}회": "{횟수} use(s)",
  "새 코드": "New code",
  "활성": "Active",
  "비활성": "Inactive",

  // 초대 상태·사용 방식 라벨
  "사용 가능": "Active",
  "사용 완료": "Used",
  "기간 만료": "Expired",
  "1회용": "Single-use",
  "기간 내 무제한": "Unlimited until expiry",

  // 기간 표기
  "1시간": "1 hour",
  "24시간": "24 hours",
  "24시간 (기본)": "24 hours (default)",
  "7일": "7 days",
  "30일": "30 days",
  "{분}분": "{분} min",

  // 사용자 섹션
  "사용자": "Users",
  "사용자 등록일, 상태, 역할, 로그인 기기와 관리 작업":
    "User registration date, status, role, signed-in devices, and management actions",
  // 역할 라벨("수정 가능" 등)과 "역할" 키는 공용 사전(en-common)에 있다.
  "{이름} 역할 변경": "Change role for {이름}",
  "등록일": "Joined",
  "로그인 기기": "Signed-in devices",
  "아직 등록된 사용자가 없습니다": "No users registered yet",
  "관리자": "Admin",
  "코드 입력 대기": "Awaiting code",
  "승인됨": "Approved",
  "차단됨": "Blocked",
  "기록 없음": "No records",
  "이 로그인 끊기": "Sign out this session",
  "삭제 확인": "Confirm deletion",
  "취소": "Cancel",
  "모든 로그인 끊기": "Sign out everywhere",
  "이 사람의 모든 기기에서 로그인을 끊습니다":
    "Signs this person out on all devices",
  "차단": "Block",
  "대기로": "Move to pending",
  "삭제": "Delete",
  "차단하면 화면 접근은 즉시 막히고, 열려 있던 파일 목록도 최대 5초 안에 끊깁니다.":
    "Blocking cuts off screen access immediately, and any open file list disconnects within 5 seconds.",
  "차단·모든 로그인 끊기를 하면 기존 로그인이 전부 무효가 되어, 다시 가입 대기로 바꾼 뒤에도 새로 로그인하고 초대 코드를 입력해야 합니다.":
    "Blocking or signing out everywhere invalidates every existing session, so even after moving the user back to pending they must sign in again and enter an invitation code.",

  // 처리 결과·오류 문구
  "사용자 목록을 불러오지 못했습니다": "Couldn't load the user list",
  "초대 목록을 불러오지 못했습니다": "Couldn't load the invitation list",
  "관리 정보를 불러오지 못했습니다": "Couldn't load admin data",
  "설치 등록부 상태를 확인하지 못했습니다":
    "Couldn't check the installation registry status",
  "현재 설치 정보를 등록하지 못했습니다": "Couldn't register this installation",
  "ShareDesk {버전} 설치 정보를 등록했습니다.":
    "Registered this ShareDesk {버전} installation.",
  "ShareDesk {버전} 기록을 갱신했습니다.":
    "Updated the ShareDesk {버전} record.",
  "처리하지 못했습니다": "Couldn't complete the request",
  "선택한 로그인을 끊었습니다": "Signed out the selected session",
  "초대 코드를 만들지 못했습니다": "Couldn't create the invitation code",
  "초대 코드를 만들었습니다. 아래 코드를 전달해 주세요.":
    "Invitation code created. Share the code below.",
  "초대를 바꾸지 못했습니다": "Couldn't update the invitation",
  "예전 코드를 무효화하고 같은 사용 기간의 새 코드를 만들었습니다. 사용 횟수와 마지막 사용 기록은 유지됩니다.":
    "The old code is now invalid and a new code with the same validity period was created. Usage count and last-used history are kept.",
  "초대 코드를 복사했습니다.": "Invitation code copied.",
  "아래 코드를 직접 선택해 복사해 주세요.":
    "Select and copy the code below manually.",

  // 좌측 탭 (사용자/설정) — "사용자"는 위, "언어"는 공용 사전(en-common)에 있다.
  "관리 메뉴": "Admin menu",
  "설정": "Settings",

  // 설정 탭 — 언어
  "데스크 언어": "Desk language",
  "개별 언어 허용": "Allow personal language",
  "데스크 언어는 모든 참여자 화면에 함께 적용됩니다. 개별 언어 허용을 켜면 참여자가 자기 화면 언어를 따로 고를 수 있습니다.":
    "The desk language applies to every member's screen. Turn on personal language to let each member pick their own display language.",
  "데스크 설정을 불러오지 못했습니다": "Couldn't load the desk settings",
  "데스크 설정을 저장하지 못했습니다": "Couldn't save the desk settings",
  "데스크 언어를 바꿨습니다.": "Desk language updated.",
  "이제 참여자가 자기 화면 언어를 따로 고를 수 있습니다.":
    "Members can now pick their own display language.",
  "이제 모든 참여자 화면에 데스크 언어가 적용됩니다.":
    "The desk language now applies to every member's screen.",

  // 설정 탭 — 테마 (바탕화면 이름 4종은 파일 사전(en-files)에 있다)
  "테마": "Theme",
  "바탕화면": "Wallpaper",
  "바탕화면은 이 기기의 내 화면에만 적용되는 개인 설정입니다. 파일 화면을 다음에 열 때 반영됩니다.":
    "The wallpaper is a personal setting that only applies to your screen on this device. It takes effect the next time the files screen loads.",
  "현재 선택": "Selected",

  // 관리자 설정 — 테마
  "테마는 화면 전체의 모양과 질감입니다. 지금 쓰는 도트 화면이 기본 테마이고, 앞으로 늘어납니다.":
    "A theme is the overall look and texture of the screen. The pixel look you see now is the default theme, and more will follow.",
  "기본": "Default",

};
