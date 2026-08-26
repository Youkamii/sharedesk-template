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
  "활동": "Activity",
  "휴지통으로 이동": "Moved to trash",
  "휴지통 비우기": "Emptied the trash",
  "이름 변경": "Renamed",
  "이동": "Moved",
  "내용 수정": "Edited",
  "업로드": "Uploaded",
  "참여자들이 데스크에서 한 일이 최근 것부터 보입니다. 업로드, 삭제, 이름 변경 같은 변화만 기록합니다.": "What people did on the desk, newest first. Only changes such as uploads, deletions, and renames are recorded.",
  "아직 기록된 활동이 없습니다.": "No activity has been recorded yet.",
  "활동을 불러오지 못했습니다": "Could not load the activity",
  "자동 업데이트 멈추기": "Stop automatic updates",
  "자동 업데이트가 켜져 있습니다.": "Automatic updates are on.",
  "자동 업데이트는 작업표시줄의 업데이트 창에서 '★ 누르고 자동 업데이트' 버튼으로 켭니다. 켜면 이 시간대 기준 자정에 새 버전이 자동으로 적용되고, 별도의 키가 필요 없으며, 업데이트 버튼은 숨겨집니다.": "Turn on automatic updates with the '★ Star and auto-update' button in the taskbar update window. When on, new versions apply automatically at midnight in this timezone, no key is needed, and the update button stays hidden.",
  "자동 업데이트를 누르면 GitHub 저장소에 별이 남고 자동 업데이트가 켜집니다. 켜면 이 시간대 기준 자정에 새 버전이 자동으로 적용되고, 별도의 키가 필요 없으며, 작업표시줄의 업데이트 버튼은 숨겨집니다. 멈추면 업데이트 버튼이 다시 나타나고 별은 그대로 남습니다.": "Pressing Automatic updates leaves a star on the GitHub repository and turns automatic updates on. While on, new versions apply automatically at midnight in this timezone, no key is needed, and the taskbar update button is hidden. Stopping brings the update button back; the star stays.",
  "템플릿 자동 업데이트를 위해 별을 눌러주세요.": "Please leave a star to enable automatic template updates.",
  "매 자정에 새로운 버전으로 업데이트됩니다.": "Updates to the newest version every midnight.",
  "별 확인 중…": "Checking for your star…",
  "GitHub에서 별을 누르면 자동으로 켜집니다.": "Leave a star on GitHub and this turns on by itself.",
  "별을 확인하지 못했습니다. 별을 누른 뒤 버튼을 다시 눌러 주세요": "Could not spot the star. After starring, press the button again",
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
  "자동 업데이트": "Automatic updates",
  "켜면 이 시간대 기준 자정에 새 버전이 자동으로 적용됩니다. 별도의 키가 필요 없습니다. 켜져 있는 동안 작업표시줄의 업데이트 버튼은 숨겨지고, 업데이트 내용은 여기에서 보여 줍니다.": "When on, new versions are applied automatically at midnight in this timezone. No key is needed. While it is on, the update button in the taskbar is hidden and update details are shown here instead.",
  "이제 자정에 자동으로 업데이트됩니다.": "Updates now happen automatically at midnight.",
  "자동 업데이트를 껐습니다. 작업표시줄의 업데이트 버튼으로 직접 업데이트할 수 있습니다.": "Automatic updates are off. You can update yourself with the update button in the taskbar.",
  "지금 최신 버전입니다": "you are up to date",
  "최신 릴리스 정보를 불러오지 못했습니다": "Could not load the latest release details",
  "자동 업데이트를 켜려면 GitHub에서 ShareDesk 저장소에 별을 남겨 주세요.": "To turn on automatic updates, please leave a star on the ShareDesk repository on GitHub.",
  "별 남기고 켜기": "Star and turn on",
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

  // 설정 탭 — 저장 용량
  "저장 용량": "Storage",
  "한 파일의 최대 업로드 크기와 이 데스크가 사용할 수 있는 전체 용량을 정합니다. 비워 두면 제한하지 않습니다.":
    "Set the maximum size of one upload and the total storage this desk may use. Leave a field blank for no limit.",
  "데스크 사용량": "Desk usage",
  "호스트 사용량": "Host usage",
  "업로드 중": "uploading",
  "남은 용량": "Available",
  "한 파일 업로드 제한 (GB)": "Per-file upload limit (GB)",
  "데스크 전체 제한 (GB)": "Desk total limit (GB)",
  "제한 없음": "No limit",
  "용량 제한 저장": "Save storage limits",
  "저장 용량을 불러오지 못했습니다": "Couldn't load storage usage",
  "용량은 0보다 큰 GB 값으로 입력해 주세요":
    "Enter a storage amount greater than 0 GB",
  "용량 값이 너무 큽니다": "The storage amount is too large",
  "한 번 업로드 제한은 데스크 전체 제한보다 작아야 합니다":
    "The per-upload limit must not exceed the desk total limit",
  "용량 제한 값을 확인해 주세요": "Check the storage limit values",
  "저장 용량 제한을 바꿨습니다.": "Storage limits updated.",

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


  // 공개 폴더 (#10)
  "공개 종료 시각은 시작 시각보다 뒤여야 합니다": "The closing time must be after the opening time",
  "공개 폴더 이름을 확인해 주세요": "Please check the public folder name",
  "공개 폴더가 너무 많습니다": "There are too many public folders",
  "이미 공개 폴더로 등록된 폴더입니다": "This folder is already registered as a public folder",

  // 공개 폴더 관리 (#10)
  "공개 폴더": "Public folders",
  "공개 폴더 목록을 불러오지 못했습니다": "Couldn't load the public folder list",
  "로그인 없이 주소만으로 파일을 받고 올리는 폴더입니다. 하위 폴더는 만들 수 없고, 상한과 공개 시간은 서버가 지킵니다.": "Folders where anyone with the address can download and upload without signing in. Subfolders cannot be created, and limits and open hours are enforced by the server.",
  "새 공개 폴더 이름": "New public folder name",
  "아직 공개 폴더가 없습니다.": "No public folders yet.",
  "공개 폴더를 만들었습니다. 주소를 복사해 나눠 주세요.": "Public folder created. Copy the address and share it.",
  "주소 복사": "Copy address",
  "주소를 복사했습니다": "Address copied",
  "설정·파일": "Settings & files",
  "접기": "Collapse",
  "저장했습니다": "Saved",
  "등록을 해제했습니다. 파일은 데스크에 남아 있습니다.": "Unregistered. The files remain on the desk.",
  "대상 없음": "Target missing",
  "꺼짐": "Off",
  "켜짐": "On",
  "공개 전": "Not open yet",
  "공개 종료": "Closed",
  "공개 중": "Open",
  "대상 폴더가 지워졌거나 바뀌어 주소가 닫혀 있습니다. 등록을 해제해 정리하세요.": "The target folder was deleted or replaced, so the address is closed. Unregister it to clean up.",
  "공개 상태": "Visibility",
  "공개 시작": "Opens at",
  "총 용량 제한 (GiB)": "Total size limit (GiB)",
  "파일 1개 최대 크기 (GiB)": "Max size per file (GiB)",
  "파일 개수 제한": "File count limit",
  "비우면 제한 없음": "Leave empty for no limit",
  "접근 제한 — 역할 최소선": "Access — minimum role",
  "접근 제한 — 개인 지정 (OR)": "Access — specific people (OR)",
  "없음 — 누구나(외부 포함)": "None — anyone (including outsiders)",
  "파일 목록": "Files",
  "공개 시각 값을 확인해 주세요": "Please check the open/close time values",
  "파일 개수 제한 값을 확인해 주세요": "Please check the file count limit",
  "개인 지정 값을 확인해 주세요": "Please check the selected people",
  "공개 폴더 등록을 찾을 수 없습니다": "Public folder registration not found",
  "공개 종료 시각": "Closes at",
};
