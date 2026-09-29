import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { LOCALE_COOKIE, resolveEffectiveLocale } from "@/lib/i18n";
import { getDeskSettingsOrDefault } from "@/lib/users";
import { isWidgetCookieStore } from "@/lib/widget-mode";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ShareDesk — 여러 사람이 함께 쓰는 Google Drive 파일 공간",
  description:
    "호스트의 Google Drive 저장 공간을 여러 사람이 각자의 Google 계정으로 함께 쓰는 공유 파일 공간",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const cookieStore = await cookies();
  const locale = resolveEffectiveLocale(
    await getDeskSettingsOrDefault(),
    cookieStore.get(LOCALE_COOKIE)?.value,
  );
  // 데스크톱 위젯 껍데기 안이면 모든 화면이 위젯 변형으로 그려진다 (src/lib/widget-mode.ts)
  const widget = isWidgetCookieStore(cookieStore);
  return (
    <html
      lang={locale}
      data-widget={widget ? "" : undefined}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
