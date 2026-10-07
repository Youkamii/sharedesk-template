import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 공유 링크 받기 화면(#17 B-3)은 다른 사이트의 틀(iframe) 안에서 열리지 않게
  // 한다 — 링크만 아는 외부에 여는 무서명 화면이라, 옛 폴더 목록 HTML
  // (/api/share/<linkId>)과 같은 수준(frame-ancestors 'none')을 지킨다.
  async headers() {
    return [
      {
        source: "/public/share/:linkId",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
