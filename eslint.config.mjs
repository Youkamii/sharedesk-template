import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 로컬 브라우저 QA가 만드는 실행 스크립트와 캡처물.
    ".gstack/**",
    // 위젯 껍데기의 Rust 빌드 산출물 — tauri-build가 만드는 JS가 섞여 들어온다.
    "widget/src-tauri/target/**",
  ]),
]);

export default eslintConfig;
