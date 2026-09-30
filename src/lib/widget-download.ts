// 데스크톱 위젯 내려받기 — 데스크 화면(우측 사이드바)이 안내하는 주소.
// 껍데기는 공개 템플릿 저장소의 고정 릴리스 `widget`에 산다(scripts/widget-release.mjs).
// Windows 설치 파일은 버전 없는 별칭 이름으로도 올라가므로 아래 주소는 항상 최신을 가리키고,
// 별칭 이름은 발행 스크립트의 latestAlias와 테스트로 묶여 있다(tests/widget-release.test.ts).
// 다른 운영체제의 파일은 올라오는 대로 릴리스 페이지에 나타나므로 거기로 보낸다.

export const WIDGET_RELEASE_PAGE_URL =
  "https://github.com/Youkamii/sharedesk-template/releases/tag/widget";
export const WIDGET_WINDOWS_INSTALLER_URL =
  "https://github.com/Youkamii/sharedesk-template/releases/download/widget/sharedesk-widget-windows-x64-setup.exe";

export interface WidgetDownloadTarget {
  href: string;
  // 링크 옆의 짧은 표시 — 설치 파일이면 운영체제 이름, 릴리스 페이지면 GitHub.
  hint: "Windows" | "GitHub";
}

const WINDOWS_INSTALLER: WidgetDownloadTarget = {
  href: WIDGET_WINDOWS_INSTALLER_URL,
  hint: "Windows",
};
const RELEASE_PAGE: WidgetDownloadTarget = {
  href: WIDGET_RELEASE_PAGE_URL,
  hint: "GitHub",
};

// 브라우저가 스스로 Windows라고 말할 때만 설치 파일로 직행한다.
// UA가 없거나(서버) 다른 운영체제·모바일이면 릴리스 페이지다.
export function widgetDownloadTarget(
  userAgent: string | null | undefined,
): WidgetDownloadTarget {
  return /Windows/i.test(userAgent ?? "") ? WINDOWS_INSTALLER : RELEASE_PAGE;
}
