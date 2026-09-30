// 데스크톱 위젯 내려받기 — 데스크 화면(우측 사이드바)이 안내하는 설치 파일 주소.
// 껍데기는 공개 템플릿 저장소의 고정 릴리스 `widget`에 산다(scripts/widget-release.mjs).
// Windows 설치 파일은 버전 없는 별칭 이름으로도 올라가므로 이 주소는 항상 최신을 가리킨다.
// 별칭 이름은 발행 스크립트의 latestAlias와 테스트로 묶여 있다(tests/widget-release.test.ts).

export const WIDGET_RELEASE_PAGE_URL =
  "https://github.com/Youkamii/sharedesk-template/releases/tag/widget";
export const WIDGET_WINDOWS_INSTALLER_URL =
  "https://github.com/Youkamii/sharedesk-template/releases/download/widget/sharedesk-widget-windows-x64-setup.exe";

export type WidgetPlatform = "windows" | "macos" | "other";

// 브라우저 UA로 운영체제만 가른다. 폰은 별도 화면(MobileFilesView)이라 여기 오지 않는다.
export function detectWidgetPlatform(
  userAgent: string | null | undefined,
): WidgetPlatform {
  const ua = typeof userAgent === "string" ? userAgent : "";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "macos";
  return "other";
}

export interface WidgetDownloadTarget {
  href: string;
  // 링크 옆의 짧은 표시 — 설치 파일이면 운영체제 이름, 릴리스 페이지면 GitHub.
  hint: "Windows" | "GitHub";
}

// Windows만 설치 파일로 직행한다. 다른 운영체제의 파일은 올라오는 대로 릴리스 페이지에
// 나타나므로 거기로 보낸다(macOS 파일은 맥에서 빌드해 올린 뒤에 생긴다).
export function widgetDownloadTarget(
  platform: WidgetPlatform,
): WidgetDownloadTarget {
  if (platform === "windows") {
    return { href: WIDGET_WINDOWS_INSTALLER_URL, hint: "Windows" };
  }
  return { href: WIDGET_RELEASE_PAGE_URL, hint: "GitHub" };
}
