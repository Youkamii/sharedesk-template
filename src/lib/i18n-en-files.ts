// 파일 화면(FilesView)의 영어 번역. 키는 한국어 원문 그대로.
// {이름} 꼴 자리표시자는 번역에도 똑같이 남겨야 한다 (tests/i18n.test.ts가 검사).
export const EN_FILES: Record<string, string> = {
  // 상단 바 · 접속 표시
  "공유 바탕화면": "Shared Desktop",
  "공유 바탕화면 아이콘": "Shared Desktop icons",
  "접속 확인 실패": "Presence check failed",
  "함께 쓰는 중 · {count}명": "Together now · {count}",
  "접속 인원 확인 중": "Checking who's online",
  "현재 접속자 없음": "No one online",
  "현재 접속 인원": "Currently online",
  "다시 확인": "Check again",
  "나": "Me",
  "확인하고 있습니다": "Checking",
  "접속 중인 사람이 없습니다": "No one is online",
  "접속 인원을 불러오지 못했습니다": "Couldn't load who's online",
  "올리는 중 {count}개": "Uploading {count}",
  "받는 중 {count}개": "Downloading {count}",
  "{name} 진행률": "{name} progress",

  // 캔버스 · 아이콘
  "폴더 내용": "Folder contents",
  "폴더": "Folder",
  "파일": "File",
  "{name} 메뉴": "{name} menu",
  "책상 정리 중": "Tidying the desk",
  "폴더 여는 중": "Opening folder",
  "잠시만 기다려 주세요": "Just a moment",
  "불러오지 못했어요": "Couldn't load",
  "다시 시도": "Try again",
  "공유 배치를 불러오지 못해 자동으로 정렬했습니다":
    "Couldn't load the shared layout, so icons were arranged automatically",
  "여기에 놓아 주세요": "Drop it here",
  "{target}에 업로드합니다": "Files will be uploaded to {target}",
  "이 폴더": "this folder",
  "{count}개": "{count} items",

  // 폴더 창
  "{name} 창": "{name} window",
  "여는 중": "Opening",
  "최소화": "Minimize",
  "최대화": "Maximize",
  "복원": "Restore",
  "닫기": "Close",
  "뒤로": "Back",
  "폴더 주소": "Folder address",
  "폴더 주소 입력": "Folder address input",
  "폴더 주소를 찾지 못했습니다": "Couldn't find that folder address",
  "{name} 안에서 검색": "Search in {name}",
  "이 폴더 검색": "Search this folder",
  "이 폴더와 하위 폴더 검색어": "Search term for this folder and subfolders",
  "검색": "Search",
  "+ 폴더": "+ Folder",
  "폴더 메모": "Folder note",
  "{count}개 항목": "{count} items",
  "{count}개 항목 선택": "{count} items selected",
  "창 크기 변경": "Resize window",

  // 폴더 우측 미리보기
  "{name} 폴더 미리보기": "{name} folder preview",
  "이전 이미지": "Previous image",
  "다음 이미지": "Next image",
  "폴더 미리보기 닫기": "Close folder preview",

  // 검색 결과 창
  "{query} 검색 결과 창": "Search results window for {query}",
  "검색 결과 — {query}": "Search results — {query}",
  "찾는 중": "Searching",
  "검색 결과 닫기": "Close search results",
  "가상 검색결과": "Virtual results",
  "범위: {path} 및 하위 폴더": "Scope: {path} and subfolders",
  "파일 이름을 찾고 있어요": "Looking for file names",
  "폴더와 하위 폴더를 살펴보고 있습니다": "Scanning folders and subfolders",
  "검색하지 못했어요": "Search failed",
  "검색 결과가 없습니다": "No results found",
  "다른 파일 이름으로 찾아보세요": "Try a different file name",
  "폴더 열기": "Open folder",
  "열기": "Open",
  "다운로드": "Download",
  "원래 위치": "Original location",
  "{name} 검색 결과 메뉴": "{name} search result menu",
  "{count}개 검색 결과": "{count} search results",
  "일부 결과만 표시했습니다": "Showing only some results",
  "{count}개 항목 확인": "Checked {count} items",
  "검색어를 입력해 주세요": "Please enter a search term",
  "파일을 검색하지 못했습니다": "Couldn't search files",
  "검색: {query}": "Search: {query}",

  // 휴지통
  "휴지통": "Trash",
  "휴지통 창": "Trash window",
  "휴지통 열기": "Open trash",
  "휴지통이 비어 있어요.": "The trash is empty.",
  "삭제한 항목은 여기에 30일 동안 보관됩니다.":
    "Deleted items are kept here for 30 days.",
  "{date} 삭제": "Deleted {date}",
  "휴지통 보관 중": "In the trash",
  // "삭제 확인"은 EN_ADMIN에도 있는 키 — 값이 반드시 같아야 한다 (tests/i18n.test.ts).
  "삭제 확인": "Confirm deletion",
  "취소": "Cancel",
  "완전 삭제": "Delete forever",
  "{count}개 항목 · 30일 후 자동 삭제":
    "{count} items · auto-deleted after 30 days",
  "모두 삭제 확인": "Confirm delete all",
  "비우기…": "Empty…",
  "복원했습니다": "Restored",
  "완전히 삭제했습니다": "Permanently deleted",
  "휴지통을 비웠습니다": "Emptied the trash",
  "휴지통 작업에 실패했습니다": "The trash operation failed",
  "휴지통을 불러오지 못했습니다": "Couldn't load the trash",
  "휴지통에 넣지 못했습니다": "Couldn't move it to the trash",
  "‘{name}’을 휴지통에 넣었습니다": "Moved ‘{name}’ to the trash",

  // 미리보기 · 메모장 편집
  "{name} 미리보기": "{name} preview",
  "{name} 내용": "{name} content",
  "여는 중…": "Opening…",
  "저장": "Save",
  "저장 중…": "Saving…",
  "↓ 다운로드": "↓ Download",
  "메모장으로 편집": "Edit in Notepad",
  "ShareDesk에서 열기": "Open in ShareDesk",
  ".txt 파일만 여기에서 편집할 수 있습니다.": "Only .txt files can be edited here.",
  "최신 버전 정보를 확인할 수 없어 읽기 전용입니다. 새로고침 후 다시 열어 주세요.":
    "Read-only because the latest version info is unavailable. Refresh and open it again.",
  "올바른 UTF-8 텍스트가 아니어서 글자가 손상될 수 있습니다. 이 화면에서는 저장할 수 없습니다.":
    "This isn't valid UTF-8 text, so characters may be corrupted. It can't be saved here.",
  "1 MiB를 넘는 파일은 앞부분만 표시하며 읽기 전용입니다.":
    "Files over 1 MiB show only the beginning and are read-only.",
  "최신 버전 정보가 없어 저장하지 않았습니다. 새로고침 후 다시 열어 주세요.":
    "Not saved because the latest version info is missing. Refresh and open it again.",
  "텍스트 파일은 1 MiB까지 저장할 수 있습니다.":
    "Text files can be saved up to 1 MiB.",
  "텍스트 파일을 저장했습니다": "Text file saved",
  "텍스트는 저장했지만 아이콘 위치를 저장하지 못했습니다":
    "The text was saved, but the icon position wasn't",
  "다른 사람이 먼저 파일을 바꿨습니다. 현재 글은 덮어쓰지 않았습니다.":
    "Someone else changed this file first. Your text was not overwritten.",
  "텍스트 파일을 저장하지 못했습니다": "Couldn't save the text file",
  "텍스트 파일을 저장하는 중입니다. 저장이 끝난 뒤 다시 시도해 주세요":
    "The text file is still saving. Please try again once saving finishes",
  "저장하지 않은 내용이 있습니다. 변경 내용을 버릴까요?":
    "You have unsaved changes. Discard them?",
  "새 이름의 파일은 미리보기를 지원하지 않아 창을 닫았습니다":
    "The renamed file can't be previewed, so the window was closed",
  "내용을 불러오지 못했습니다": "Couldn't load the content",

  // 폴더 메모 창
  "{name} 폴더 메모": "{name} folder note",
  "{name} · 폴더 메모": "{name} · Folder note",
  "메모를 여는 중…": "Opening note…",
  "폴더 메모 내용": "Folder note content",
  "저장됨": "Saved",
  "저장하지 않은 변경 있음": "Unsaved changes",
  "폴더 메모를 저장했습니다": "Folder note saved",
  "다른 사람이 먼저 메모를 바꿨습니다. 현재 글은 덮어쓰지 않았습니다.":
    "Someone else changed this note first. Your text was not overwritten.",
  "폴더 메모를 저장하지 못했습니다": "Couldn't save the folder note",
  "폴더 메모를 불러오지 못했습니다": "Couldn't load the folder note",

  // 작업표시줄
  "공유 바탕화면 전체 검색": "Search the entire shared desktop",
  "전체 파일 검색": "Search all files",
  "전체 파일 검색어": "Search term for all files",
  "책상 설정": "Desk settings",
  "열린 창": "Open windows",
  "전송 중 {count}개 · {name}": "Transferring {count} · {name}",
  "다운로드 우선": "Download first",
  "사용자 관리": "Manage users",
  "손님": "Guest",
  "나가기": "Sign out",

  // 컨텍스트 메뉴
  "바탕화면 메뉴": "Desktop menu",
  "새 탭에서 보기": "Open in new tab",
  "원래 위치 열기": "Open original location",
  "상위 폴더로 이동": "Move to parent folder",
  "상위 폴더를 찾지 못했습니다 — 새로고침해 주세요":
    "Couldn't find the parent folder — please refresh",
  "이름 바꾸기": "Rename",
  "Google Drive로 공유…": "Share via Google Drive…",
  "삭제…": "Delete…",
  "새 폴더": "New folder",
  "새 메모장": "New notepad",
  "파일 업로드…": "Upload files…",
  "새로고침": "Refresh",
  "배경 — {name}": "Wallpaper — {name}",
  "해 질 녘": "Dusk",
  "깊은 밤": "Deep Night",
  "여명": "Dawn",
  "밤바다": "Night Tide",

  // 파일 이동·배치 알림
  "다른 사람이 먼저 옮긴 위치를 반영했습니다":
    "Applied a position someone else saved first",
  "아이콘 위치를 저장하지 못했습니다": "Couldn't save the icon position",
  "항목 정보가 오래되어 옮기지 못했습니다 — 잠시 후 다시 시도해 주세요":
    "The item info was stale, so it wasn't moved — please try again shortly",
  "‘{name}’ 항목을 옮겼습니다": "Moved ‘{name}’",
  "‘{name}’ 항목의 실제 위치를 확인하고 있습니다":
    "Checking where ‘{name}’ actually is",
  "옮기지 못했습니다": "Couldn't move it",
  "‘{name}’ 항목의 원본과 대상 폴더를 다시 불러왔습니다":
    "Reloaded the source and destination folders for ‘{name}’",
  "‘{name}’ 항목의 이동 결과를 확인하지 못했습니다 — 새로고침해 주세요":
    "Couldn't confirm the move result for ‘{name}’ — please refresh",

  // 업로드 · 메모장 생성
  "드라이브 업로드에 실패했습니다": "Drive upload failed",
  "업로드에 실패했습니다": "Upload failed",
  "실패": "failed",
  "일부 파일을 올리지 못했습니다 · {failures}":
    "Some files didn't upload · {failures}",
  "{count}개 파일을 올렸습니다": "Uploaded {count} files",
  "새 메모장을 만들지 못했습니다": "Couldn't create a new notepad",
  "‘{name}’ 메모장은 만들었습니다 — 최신 목록을 다시 불러옵니다":
    "The notepad ‘{name}’ was created — reloading the latest list",
  "‘{name}’ 메모장은 만들었지만 바로 열지 못했습니다 — 새로고침해 주세요":
    "The notepad ‘{name}’ was created but couldn't be opened right away — please refresh",
  "‘{name}’ 메모장을 만들었습니다": "Created the notepad ‘{name}’",
  "‘{name}’ 메모장은 만들었지만 목록을 새로고치지 못했습니다 — 새로고침해 주세요":
    "The notepad ‘{name}’ was created but the list couldn't be refreshed — please refresh",

  // 다운로드
  "브라우저 다운로드로 넘겼습니다. 이 브라우저에서는 진행량을 확인할 수 없습니다.":
    "Handed off to the browser download. This browser can't show progress.",
  "다운로드에 실패했습니다": "Download failed",

  // 피드백
  "운영자에게 피드백 보내기": "Send feedback to the operator",
  "피드백 보내기": "Send feedback",
  "피드백 닫기": "Close feedback",
  "보내는 사람": "From",
  "보낸 사람 이메일": "Sender email",
  "제목": "Subject",
  "예: 파일을 찾기 어려워요": "e.g. It's hard to find files",
  "내용": "Message",
  "불편했던 점이나 필요한 기능을 적어 주세요.":
    "Tell us what felt awkward or what you need.",
  "보내는 중…": "Sending…",
  "보내기": "Send",
  "피드백을 보냈습니다": "Feedback sent",
  "피드백을 보내지 못했습니다": "Couldn't send feedback",

  // 업데이트
  "업데이트": "Update",
  "업데이트, 새 버전 {version} 있음": "Update, new version {version} available",
  "ShareDesk 업데이트": "ShareDesk Update",
  "업데이트 창 닫기": "Close update window",
  "현재 버전과 새 버전을 확인하는 중입니다…":
    "Checking the current and latest versions…",
  "설치 저장소 연결이 필요합니다.": "The install repository needs to be connected.",
  "새 버전 {version}을 사용할 수 있습니다.": "New version {version} is available.",
  "최신 버전을 사용하고 있습니다.": "You are on the latest version.",
  "현재 버전": "Current version",
  "최신 버전": "Latest version",
  "업데이트 상태": "Update status",
  "새 버전 있음": "New version available",
  "새 버전 없음": "Up to date",
  "설치 저장소": "Install repository",
  "연결되지 않음": "Not connected",
  "설치 저장소를 연결해 주세요.": "Please connect the install repository.",
  "설정 확인이나 기존 설치 전환 방법을 안내에서 확인한 뒤 다시 시도해 주세요.":
    "Check the guide for verifying settings or migrating an existing install, then try again.",
  "설치 저장소 연결 안내 열기": "Open the repository connection guide",
  "업데이트 하기를 누르면 ShareDesk가 업데이트를 시작하고 이 창에 진행 상황을 보여 줍니다.":
    "Press Update now and ShareDesk will start the update and show its progress in this window.",
  "업데이트를 시작하고 있습니다": "Starting the update",
  "업데이트를 적용하고 있습니다. 몇 분 걸릴 수 있습니다":
    "Applying the update. This can take a few minutes",
  "새 버전을 배포하고 있습니다. 잠시 뒤 자동으로 확인됩니다":
    "Deploying the new version. It will be confirmed automatically shortly",
  "업데이트가 끝났습니다. 새로고침하면 새 버전 {version}이 적용됩니다.":
    "The update is finished. Refresh to switch to version {version}.",
  "업데이트가 끝났습니다. 새로고침하면 새 버전이 적용됩니다.":
    "The update is finished. Refresh to switch to the new version.",
  "업데이트에 실패했습니다. 잠시 후 다시 시도해 주세요.":
    "The update failed. Please try again shortly.",
  "자세한 기록 보기": "View detailed logs",
  "반영 확인이 늦어지고 있습니다. 잠시 후 새로고침으로 확인해 주세요.":
    "Confirming the rollout is taking a while. Please refresh shortly to check.",
  "자동으로 적용되지는 않습니다. 아래 버튼을 누른 뒤 GitHub Actions 화면에서":
    "This does not apply automatically. Press the button below, then on the GitHub Actions page click",
  "를 눌러야 업데이트가 시작됩니다.": " to start the update.",
  "원클릭 업데이트도 켤 수 있습니다.": "One-click updates can be enabled too.",
  "Vercel 환경 변수에 SHAREDESK_GITHUB_TOKEN을 추가하면 이 창에서 바로 업데이트할 수 있습니다.":
    "Add SHAREDESK_GITHUB_TOKEN to your Vercel environment variables to update right from this window.",
  "원클릭 업데이트 설정 안내 열기": "Open the one-click update setup guide",
  "업데이트 하기": "Update now",
  "업데이트 상태를 확인하지 못했습니다": "Couldn't check the update status",
  "업데이트를 시작하지 못했습니다": "Couldn't start the update",

  // 새 폴더·이름 바꾸기·삭제 다이얼로그
  "을 삭제할까요?": " — delete it?",
  "휴지통으로 이동하며, 30일이 지나면 자동으로 완전히 삭제됩니다.":
    "It moves to the trash and is permanently deleted after 30 days.",
  "폴더 이름": "Folder name",
  "새 이름": "New name",
  "예: 여름 여행": "e.g. Summer trip",
  "처리 중…": "Working…",
  "만들기": "Create",
  "삭제하기": "Delete",
  "‘{name}’ 폴더를 만들었습니다": "Created the ‘{name}’ folder",
  "이름을 바꿨습니다": "Renamed",
  "‘{name}’을 삭제했습니다": "Deleted ‘{name}’",
  "작업을 마치지 못했습니다": "Couldn't finish the operation",

  // 공용 오류
  "세션이 만료되었습니다": "Your session has expired",
  "요청에 실패했습니다": "The request failed",
  "폴더를 불러오지 못했습니다": "Couldn't load the folder",
  "바탕화면을 불러오지 못했습니다": "Couldn't load the desktop",
  "공유 배치를 불러오지 못했습니다": "Couldn't load the shared layout",
  "수정일 없음": "No modified date",
};
