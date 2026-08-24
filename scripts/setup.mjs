#!/usr/bin/env node
// ShareDesk 최초 설정 — 주인 1회 실행.
// OAuth 동의 → refresh token 획득 → 드라이브에 루트 폴더 생성 → .env.local 기록.
// 브라우저 자동 열기는 편의 기능이다. 실패해도 URL 출력과 2단계 finish 흐름을 유지한다.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

const ENV_PATH = path.resolve(process.cwd(), ".env.local");
const ENV_EXAMPLE_PATH = path.resolve(process.cwd(), ".env.example");
// 1단계가 만든 state/PKCE를 2단계가 이어받는다. 콜백을 기다리는 서버를 띄우지 않으므로
// 장시간 대기 프로세스가 필요 없다 — 대기 중 프로세스가 죽어 설정이 날아가던 문제를 없앤다.
const PENDING_PATH = path.resolve(process.cwd(), ".setup-pending.json");
const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
// drive.file: 이 앱이 만든 파일만 접근 / openid·userinfo: 주인이 누구인지 확인해 관리자로 등록
export const HOST_OAUTH_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/drive.file",
];
const SCOPE = HOST_OAUTH_SCOPES.join(" ");
export const CALLBACK_URL_SECURITY_WARNING = [
  "주의: callback URL에는 Google이 발급한 짧게 유효한 일회용 인증 코드가 들어 있습니다.",
  "이 주소는 이 컴퓨터의 터미널에만 붙여넣고 채팅, 이슈, 스크린샷에 공유하지 마세요.",
].join("\n");
export const REFRESH_TOKEN_RECOVERY_GUIDANCE =
  "refresh_token을 받지 못했습니다. 기존 연결과 Audience 상태를 먼저 확인하세요. 새 토큰이 실제로 필요하고 기존 연결 때문에 발급되지 않는 경우에만 https://myaccount.google.com/permissions 에서 이 앱 권한을 제거한 뒤 다시 실행하세요.";
export const GOOGLE_AUTH_PLATFORM_GUIDANCE = [
  "Google Cloud 설정과 운영 배포 순서는 docs/INSTALL.md를 따르세요.",
  ".env.local이 없으면 npm run setup이 안전하게 자동 준비합니다.",
  ".env.local에 Client ID와 Client secret을 직접 입력한 뒤 npm run setup을 다시 실행하세요.",
  "환경 파일만 미리 준비하려면 기존 npm run setup -- --prepare-env도 그대로 사용할 수 있습니다.",
  "설치 문서에는 Drive API, Branding, Audience, Data Access, Clients와 아래 redirect URI가 정리돼 있습니다:",
  `  ${REDIRECT}`,
  "  http://localhost:3000/api/auth/google/callback",
  "  https://<고정된-운영-도메인>/api/auth/google/callback",
  "비밀값이나 callback URL은 채팅, 이슈, 스크린샷에 공유하지 마세요.",
].join("\n");
export const SETUP_COMPLETION_NEXT_STEPS = [
  "호스트의 Google Drive 저장 공간을 여러 사람이 함께 쓸 ShareDesk를 준비했습니다.",
  "다음은 docs/INSTALL.md의 'Vercel Production 환경 변수와 재배포' 단계부터 이어서 진행하세요.",
  "비밀값을 Production 환경에 안전하게 옮긴 뒤 재배포하고, 운영 로그인과 파일 저장을 실제로 확인하세요.",
  "작동을 확인하면 /admin에서 초대 코드를 만들어 한 사람을 초대하고, 두 계정에서 같은 파일이 보이는지 확인하세요.",
  "Vercel Firewall은 기능 확인이 끝난 뒤 초대 코드 요청을 보호하는 운영 단계에서 설정합니다.",
].join("\n");
// 구축을 마친 사람에게 원본 저장소 별을 한 번 권한다. 여기에는 GitHub 토큰이
// 없어 대신 눌러 줄 수 없으므로, 동의하면 저장소 페이지를 열어 준다.
export const STAR_REPOSITORY_URL = "https://github.com/Youkamii/sharedesk-template";

// 설정을 마친 사람이 다음에 무엇을 열어야 하는지 주소로 알려 준다. 파일 경로만
// 알려 주면 어디를 클릭할지 알 수 없다. 문서 URL 규약은 앱의 src/lib/i18n.ts
// docUrl과 같다 — 영어가 메인이고 나머지 언어는 접미사를 붙인다.
export const LOCAL_CHECK_URL = "http://localhost:3000";
const INSTALL_DOC_BASE =
  "https://github.com/Youkamii/sharedesk-template/blob/main/docs";
export function installDocUrl(locale) {
  const resolved = SETUP_LOCALES.includes(locale) ? locale : "en";
  return `${INSTALL_DOC_BASE}/INSTALL${resolved === "en" ? "" : `.${resolved}`}.md`;
}

// ---------------------------------------------------------------------------
// setup 전용 다국어 사전 — 앱의 src/lib/i18n.ts(TS)는 여기서 import할 수 없으므로
// 같은 규칙(한국어 원문이 키, 번역이 없으면 영어 → 한국어 순 폴백)을 자체 구현한다.
// 번역 용어는 앱 사전(src/lib/i18n-*.ts)과 맞춘다: 데스크=Desk/デスク/डेस्क/桌面,
// 관리자=Admin/管理者/व्यवस्थापक/管理员.
// ---------------------------------------------------------------------------

export const SETUP_LOCALES = ["en", "ko", "ja", "hi", "zh"];

export const SETUP_LOCALE_LABELS = {
  en: "English",
  ko: "한국어",
  ja: "日本語",
  hi: "हिन्दी",
  zh: "中文",
};

// 언어 질문은 아직 언어를 모르는 시점이므로 5개 언어를 한 줄에 병기한다.
export const SETUP_LANGUAGE_QUESTION =
  "Language / 언어 / 言語 / भाषा / 语言 — 1) English  2) 한국어  3) 日本語  4) हिन्दी  5) 中文  [1]: ";

// "1"~"5" 또는 로케일 코드("en"...)를 로케일로 바꾼다. 그 외에는 null.
export function resolveSetupLocale(value) {
  const answer = String(value ?? "").trim().toLowerCase();
  // 일반 객체 인덱싱은 "constructor" 같은 입력이 프로토타입 체인을 타고
  // 엉뚱한 값을 돌려준다 — 소유 속성만 본다.
  const numbers = { 1: "en", 2: "ko", 3: "ja", 4: "hi", 5: "zh" };
  if (Object.prototype.hasOwnProperty.call(numbers, answer)) {
    return numbers[answer];
  }
  return SETUP_LOCALES.includes(answer) ? answer : null;
}

const SETUP_MESSAGES = {
  en: {
    "[1/2] Google 인증을 시작합니다.": "[1/2] Starting Google sign-in.",
    "[2/2] 인증을 마치고 설정을 저장합니다.":
      "[2/2] Finishing sign-in and saving the configuration.",
    "데스크 기본 언어: {label}": "Desk default language: {label}",
    "진행 중인 인증이 있습니다. 마치려면 npm run setup:finish 를 실행하세요.":
      "An authentication is already in progress. Run npm run setup:finish to finish it.",
    "이어가지 않고 새로 시작할까요? 새로 시작하면 기존 인증 링크는 무효가 됩니다. (y/N): ":
      "Start over instead? Starting over invalidates the previous sign-in link. (y/N): ",
    "기존 인증을 그대로 두었습니다. npm run setup:finish 로 마무리하세요.":
      "Kept the existing authentication. Finish it with npm run setup:finish.",
    "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET이 .env.local에 없습니다.":
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing from .env.local.",
    "1) Google 인증 페이지를 기본 브라우저에서 열었습니다.":
      "1) Opened the Google consent page in your default browser.",
    "1) 브라우저를 자동으로 열지 못했습니다. 아래 URL을 직접 여세요.":
      "1) Could not open the browser automatically. Open the URL below yourself.",
    "브라우저가 열리지 않았거나 다른 계정을 쓰려면 아래 URL을 여세요:":
      "If the browser did not open, or to use another account, open this URL:",
    "2) 동의하면 브라우저가 127.0.0.1 주소로 이동하면서":
      "2) After you consent, the browser moves to a 127.0.0.1 address and",
    "   '연결할 수 없음' 같은 오류 화면이 뜹니다 — 정상입니다.":
      "   shows an error page like 'can't connect' — that is expected.",
    "   그때 주소창의 주소 전체를 복사하세요.":
      "   Copy the full address from the address bar at that point.",
    "3) 아래 명령을 실행한 뒤, 물어보면 복사한 주소를 붙여넣으세요:":
      "3) Run the command below, then paste the copied address when asked:",
    "진행 중인 설정이 없습니다 — 먼저 npm run setup 을 실행하세요.":
      "No setup is in progress — run npm run setup first.",
    "브라우저 주소창의 callback URL 전체를 붙여넣으세요: ":
      "Paste the full callback URL from the browser address bar: ",
    "관리자로 등록:": "Registered as admin:",
    "드라이브에 루트 폴더 'ShareDesk'를 만들었습니다:":
      "Created the root folder 'ShareDesk' in Drive:",
    "=== 설정 완료 ===": "=== Setup complete ===",
    ".env.local 갱신됨 (refresh token은 파일에만 저장, 화면에 출력하지 않음)":
      ".env.local updated (the refresh token is stored only in the file, never printed)",
    "루트 폴더 ID:": "Root folder ID:",
    "ShareDesk가 도움이 되었다면 GitHub 저장소에 별을 남겨 주시겠어요? (y/N): ":
      "If ShareDesk helped you, would you leave a star on the GitHub repository? (y/N): ",
    "GitHub 저장소에 별을 남겼습니다. 고맙습니다!":
      "Left a star on the GitHub repository. Thank you!",
    "나중에 별을 남기려면 {url} 를 열어 주세요.": "To star later, open {url} .",
    "저장소 페이지를 열었습니다. 오른쪽 위 Star 버튼을 눌러 주세요.":
      "Opened the repository page. Please press the Star button at the top right.",
    "브라우저를 열지 못했습니다. {url} 에서 Star를 눌러 주세요.":
      "Could not open the browser. Please press Star at {url} .",
    "별은 {url} 에서 언제든 남길 수 있습니다.":
      "You can always leave a star at {url} .",
    "지금 확인: {url} (npm run dev 실행 후)":
      "Check it now: {url} (after running npm run dev)",
    "다음 단계 문서: {url}": "Next step guide: {url}",
    "callback URL은 명령 기록에 남지 않도록 인자로 받지 않습니다. npm run setup:finish만 실행하세요.":
      "The callback URL is not accepted as an argument so it never lands in the shell history. Run npm run setup:finish only.",
    [CALLBACK_URL_SECURITY_WARNING]: [
      "Caution: the callback URL contains a short-lived one-time authorization code issued by Google.",
      "Paste it only into the terminal on this computer — never share it in chats, issues, or screenshots.",
    ].join("\n"),
    [SETUP_COMPLETION_NEXT_STEPS]: [
      "You have prepared a ShareDesk where several people share the host's Google Drive storage.",
      "Next, continue from the 'Vercel Production environment variables and redeploy' step in docs/INSTALL.md.",
      "Move the secrets safely into the Production environment, redeploy, and verify production sign-in and file saving.",
      "Once it works, create an invitation code in /admin, invite one person, and check that both accounts see the same file.",
      "Configure Vercel Firewall later, in the operations stage that protects invitation code requests after the feature check.",
    ].join("\n"),
  },
  ja: {
    "[1/2] Google 인증을 시작합니다.": "[1/2] Google 認証を開始します。",
    "[2/2] 인증을 마치고 설정을 저장합니다.":
      "[2/2] 認証を完了して設定を保存します。",
    "데스크 기본 언어: {label}": "デスクの既定の言語: {label}",
    "진행 중인 인증이 있습니다. 마치려면 npm run setup:finish 를 실행하세요.":
      "進行中の認証があります。完了するには npm run setup:finish を実行してください。",
    "이어가지 않고 새로 시작할까요? 새로 시작하면 기존 인증 링크는 무효가 됩니다. (y/N): ":
      "最初からやり直しますか？ やり直すと以前の認証リンクは無効になります。(y/N): ",
    "기존 인증을 그대로 두었습니다. npm run setup:finish 로 마무리하세요.":
      "既存の認証をそのまま残しました。npm run setup:finish で完了してください。",
    "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET이 .env.local에 없습니다.":
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が .env.local にありません。",
    "1) Google 인증 페이지를 기본 브라우저에서 열었습니다.":
      "1) 既定のブラウザで Google 認証ページを開きました。",
    "1) 브라우저를 자동으로 열지 못했습니다. 아래 URL을 직접 여세요.":
      "1) ブラウザを自動で開けませんでした。下の URL を直接開いてください。",
    "브라우저가 열리지 않았거나 다른 계정을 쓰려면 아래 URL을 여세요:":
      "ブラウザが開かない場合や別のアカウントを使う場合は、この URL を開いてください:",
    "2) 동의하면 브라우저가 127.0.0.1 주소로 이동하면서":
      "2) 同意するとブラウザは 127.0.0.1 のアドレスに移動し、",
    "   '연결할 수 없음' 같은 오류 화면이 뜹니다 — 정상입니다.":
      "   「接続できません」のようなエラー画面が表示されます — 正常です。",
    "   그때 주소창의 주소 전체를 복사하세요.":
      "   その時点でアドレスバーの URL 全体をコピーしてください。",
    "3) 아래 명령을 실행한 뒤, 물어보면 복사한 주소를 붙여넣으세요:":
      "3) 下のコマンドを実行し、聞かれたらコピーしたアドレスを貼り付けてください:",
    "진행 중인 설정이 없습니다 — 먼저 npm run setup 을 실행하세요.":
      "進行中のセットアップはありません — 先に npm run setup を実行してください。",
    "브라우저 주소창의 callback URL 전체를 붙여넣으세요: ":
      "ブラウザのアドレスバーの callback URL 全体を貼り付けてください: ",
    "관리자로 등록:": "管理者として登録:",
    "드라이브에 루트 폴더 'ShareDesk'를 만들었습니다:":
      "ドライブにルートフォルダー「ShareDesk」を作成しました:",
    "=== 설정 완료 ===": "=== セットアップ完了 ===",
    ".env.local 갱신됨 (refresh token은 파일에만 저장, 화면에 출력하지 않음)":
      ".env.local を更新しました（refresh token はファイルにのみ保存し、画面には表示しません）",
    "루트 폴더 ID:": "ルートフォルダー ID:",
    "ShareDesk가 도움이 되었다면 GitHub 저장소에 별을 남겨 주시겠어요? (y/N): ":
      "ShareDesk が役に立ったら、GitHub リポジトリにスターを残していただけますか？ (y/N): ",
    "GitHub 저장소에 별을 남겼습니다. 고맙습니다!":
      "GitHub リポジトリにスターを残しました。ありがとうございます！",
    "나중에 별을 남기려면 {url} 를 열어 주세요.":
      "後でスターを残すには {url} を開いてください。",
    "저장소 페이지를 열었습니다. 오른쪽 위 Star 버튼을 눌러 주세요.":
      "リポジトリのページを開きました。右上の Star ボタンを押してください。",
    "브라우저를 열지 못했습니다. {url} 에서 Star를 눌러 주세요.":
      "ブラウザを開けませんでした。{url} で Star を押してください。",
    "별은 {url} 에서 언제든 남길 수 있습니다.":
      "スターはいつでも {url} で残せます。",
    "지금 확인: {url} (npm run dev 실행 후)":
      "今すぐ確認: {url}（npm run dev を実行してから）",
    "다음 단계 문서: {url}": "次のステップの案内: {url}",
    "callback URL은 명령 기록에 남지 않도록 인자로 받지 않습니다. npm run setup:finish만 실행하세요.":
      "callback URL はコマンド履歴に残らないよう引数では受け取りません。npm run setup:finish だけを実行してください。",
    [CALLBACK_URL_SECURITY_WARNING]: [
      "注意: callback URL には Google が発行した短時間だけ有効な一回限りの認証コードが含まれます。",
      "このアドレスはこのコンピューターのターミナルにだけ貼り付け、チャット・Issue・スクリーンショットで共有しないでください。",
    ].join("\n"),
    [SETUP_COMPLETION_NEXT_STEPS]: [
      "ホストの Google Drive の保存容量をみんなで使う ShareDesk を準備しました。",
      "次は docs/INSTALL.md の「Vercel Production 環境変数と再デプロイ」の手順から続けてください。",
      "秘密の値を Production 環境へ安全に移して再デプロイし、本番のログインとファイル保存を実際に確認してください。",
      "動作を確認したら /admin で招待コードを作って 1 人を招待し、2 つのアカウントで同じファイルが見えるか確認してください。",
      "Vercel Firewall は機能確認が終わったあと、招待コードのリクエストを守る運用段階で設定します。",
    ].join("\n"),
  },
  hi: {
    "[1/2] Google 인증을 시작합니다.": "[1/2] Google प्रमाणीकरण शुरू हो रहा है।",
    "[2/2] 인증을 마치고 설정을 저장합니다.":
      "[2/2] प्रमाणीकरण पूरा करके सेटिंग सहेजी जा रही है।",
    "데스크 기본 언어: {label}": "डेस्क की डिफ़ॉल्ट भाषा: {label}",
    "진행 중인 인증이 있습니다. 마치려면 npm run setup:finish 를 실행하세요.":
      "एक प्रमाणीकरण पहले से चल रहा है। पूरा करने के लिए npm run setup:finish चलाएँ।",
    "이어가지 않고 새로 시작할까요? 새로 시작하면 기존 인증 링크는 무효가 됩니다. (y/N): ":
      "क्या नए सिरे से शुरू करें? नए सिरे से शुरू करने पर पिछला प्रमाणीकरण लिंक अमान्य हो जाएगा। (y/N): ",
    "기존 인증을 그대로 두었습니다. npm run setup:finish 로 마무리하세요.":
      "मौजूदा प्रमाणीकरण वैसा ही रखा गया है। npm run setup:finish से पूरा करें।",
    "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET이 .env.local에 없습니다.":
      ".env.local में GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET नहीं हैं।",
    "1) Google 인증 페이지를 기본 브라우저에서 열었습니다.":
      "1) आपके डिफ़ॉल्ट ब्राउज़र में Google सहमति पेज खोला गया।",
    "1) 브라우저를 자동으로 열지 못했습니다. 아래 URL을 직접 여세요.":
      "1) ब्राउज़र अपने आप नहीं खुल सका। नीचे दिया URL स्वयं खोलें।",
    "브라우저가 열리지 않았거나 다른 계정을 쓰려면 아래 URL을 여세요:":
      "यदि ब्राउज़र नहीं खुला, या दूसरा खाता उपयोग करना हो, तो यह URL खोलें:",
    "2) 동의하면 브라우저가 127.0.0.1 주소로 이동하면서":
      "2) सहमति देने के बाद ब्राउज़र 127.0.0.1 पते पर जाएगा और",
    "   '연결할 수 없음' 같은 오류 화면이 뜹니다 — 정상입니다.":
      "   \"कनेक्ट नहीं हो सकता\" जैसा त्रुटि पेज दिखेगा — यह सामान्य है।",
    "   그때 주소창의 주소 전체를 복사하세요.":
      "   उसी समय एड्रेस बार का पूरा पता कॉपी करें।",
    "3) 아래 명령을 실행한 뒤, 물어보면 복사한 주소를 붙여넣으세요:":
      "3) नीचे दी कमांड चलाएँ, फिर पूछे जाने पर कॉपी किया पता चिपकाएँ:",
    "진행 중인 설정이 없습니다 — 먼저 npm run setup 을 실행하세요.":
      "कोई सेटअप चालू नहीं है — पहले npm run setup चलाएँ।",
    "브라우저 주소창의 callback URL 전체를 붙여넣으세요: ":
      "ब्राउज़र एड्रेस बार का पूरा callback URL चिपकाएँ: ",
    "관리자로 등록:": "व्यवस्थापक के रूप में पंजीकृत:",
    "드라이브에 루트 폴더 'ShareDesk'를 만들었습니다:":
      "Drive में रूट फ़ोल्डर 'ShareDesk' बनाया गया:",
    "=== 설정 완료 ===": "=== सेटअप पूर्ण ===",
    ".env.local 갱신됨 (refresh token은 파일에만 저장, 화면에 출력하지 않음)":
      ".env.local अपडेट हुआ (refresh token केवल फ़ाइल में सहेजा गया, स्क्रीन पर नहीं दिखाया गया)",
    "루트 폴더 ID:": "रूट फ़ोल्डर ID:",
    "ShareDesk가 도움이 되었다면 GitHub 저장소에 별을 남겨 주시겠어요? (y/N): ":
      "यदि ShareDesk मददगार रहा, तो क्या आप GitHub रिपॉज़िटरी पर स्टार देंगे? (y/N): ",
    "GitHub 저장소에 별을 남겼습니다. 고맙습니다!":
      "GitHub रिपॉज़िटरी पर स्टार दे दिया गया। धन्यवाद!",
    "나중에 별을 남기려면 {url} 를 열어 주세요.":
      "बाद में स्टार देने के लिए {url} खोलें।",
    "저장소 페이지를 열었습니다. 오른쪽 위 Star 버튼을 눌러 주세요.":
      "रिपॉज़िटरी पेज खोला गया। ऊपर दाईं ओर Star बटन दबाएँ।",
    "브라우저를 열지 못했습니다. {url} 에서 Star를 눌러 주세요.":
      "ब्राउज़र नहीं खुल सका। {url} पर जाकर Star दबाएँ।",
    "별은 {url} 에서 언제든 남길 수 있습니다.":
      "आप कभी भी {url} पर स्टार दे सकते हैं।",
    "지금 확인: {url} (npm run dev 실행 후)":
      "अभी जाँचें: {url} (npm run dev चलाने के बाद)",
    "다음 단계 문서: {url}": "अगले चरण की गाइड: {url}",
    "callback URL은 명령 기록에 남지 않도록 인자로 받지 않습니다. npm run setup:finish만 실행하세요.":
      "callback URL को आर्ग्युमेंट के रूप में स्वीकार नहीं किया जाता ताकि वह कमांड इतिहास में न रहे। केवल npm run setup:finish चलाएँ।",
    [CALLBACK_URL_SECURITY_WARNING]: [
      "सावधान: callback URL में Google द्वारा जारी अल्पकालिक एक-बार का प्रमाणीकरण कोड होता है।",
      "इसे केवल इसी कंप्यूटर के टर्मिनल में चिपकाएँ — चैट, इश्यू या स्क्रीनशॉट में साझा न करें।",
    ].join("\n"),
    [SETUP_COMPLETION_NEXT_STEPS]: [
      "आपने ऐसा ShareDesk तैयार किया है जिसमें कई लोग होस्ट के Google Drive संग्रहण को साथ में उपयोग करेंगे।",
      "अब docs/INSTALL.md के 'Vercel Production environment variables and redeploy' चरण से आगे बढ़ें।",
      "गुप्त मान सुरक्षित रूप से Production परिवेश में ले जाकर पुनः डिप्लॉय करें, और उत्पादन लॉगिन तथा फ़ाइल सहेजना वास्तव में जाँचें।",
      "काम करने पर /admin में आमंत्रण कोड बनाकर एक व्यक्ति को आमंत्रित करें, और देखें कि दोनों खातों में एक ही फ़ाइल दिखती है या नहीं।",
      "Vercel Firewall को सुविधा-जाँच पूरी होने के बाद, आमंत्रण कोड अनुरोधों की सुरक्षा वाले संचालन चरण में सेट करें।",
    ].join("\n"),
  },
  zh: {
    "[1/2] Google 인증을 시작합니다.": "[1/2] 开始 Google 认证。",
    "[2/2] 인증을 마치고 설정을 저장합니다.": "[2/2] 完成认证并保存设置。",
    "데스크 기본 언어: {label}": "桌面默认语言：{label}",
    "진행 중인 인증이 있습니다. 마치려면 npm run setup:finish 를 실행하세요.":
      "已有正在进行的认证。要完成它，请运行 npm run setup:finish。",
    "이어가지 않고 새로 시작할까요? 새로 시작하면 기존 인증 링크는 무효가 됩니다. (y/N): ":
      "要重新开始吗？重新开始后，之前的认证链接将失效。(y/N): ",
    "기존 인증을 그대로 두었습니다. npm run setup:finish 로 마무리하세요.":
      "已保留现有认证。请用 npm run setup:finish 完成。",
    "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET이 .env.local에 없습니다.":
      ".env.local 中缺少 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET。",
    "1) Google 인증 페이지를 기본 브라우저에서 열었습니다.":
      "1) 已在默认浏览器中打开 Google 认证页面。",
    "1) 브라우저를 자동으로 열지 못했습니다. 아래 URL을 직접 여세요.":
      "1) 未能自动打开浏览器。请手动打开下面的 URL。",
    "브라우저가 열리지 않았거나 다른 계정을 쓰려면 아래 URL을 여세요:":
      "如果浏览器未打开，或想使用其他账号，请打开此 URL：",
    "2) 동의하면 브라우저가 127.0.0.1 주소로 이동하면서":
      "2) 同意后，浏览器会跳转到 127.0.0.1 地址，",
    "   '연결할 수 없음' 같은 오류 화면이 뜹니다 — 정상입니다.":
      "   显示“无法连接”之类的错误页面——这是正常的。",
    "   그때 주소창의 주소 전체를 복사하세요.":
      "   此时请复制地址栏中的完整地址。",
    "3) 아래 명령을 실행한 뒤, 물어보면 복사한 주소를 붙여넣으세요:":
      "3) 运行下面的命令，然后在询问时粘贴复制的地址：",
    "진행 중인 설정이 없습니다 — 먼저 npm run setup 을 실행하세요.":
      "没有正在进行的设置——请先运行 npm run setup。",
    "브라우저 주소창의 callback URL 전체를 붙여넣으세요: ":
      "请粘贴浏览器地址栏中的完整 callback URL：",
    "관리자로 등록:": "已注册为管理员：",
    "드라이브에 루트 폴더 'ShareDesk'를 만들었습니다:":
      "已在云端硬盘中创建根文件夹“ShareDesk”：",
    "=== 설정 완료 ===": "=== 设置完成 ===",
    ".env.local 갱신됨 (refresh token은 파일에만 저장, 화면에 출력하지 않음)":
      ".env.local 已更新（refresh token 仅保存在文件中，不在屏幕上显示）",
    "루트 폴더 ID:": "根文件夹 ID：",
    "ShareDesk가 도움이 되었다면 GitHub 저장소에 별을 남겨 주시겠어요? (y/N): ":
      "如果 ShareDesk 对你有帮助，愿意给 GitHub 仓库点个星吗？(y/N): ",
    "GitHub 저장소에 별을 남겼습니다. 고맙습니다!":
      "已在 GitHub 仓库留下星标。谢谢！",
    "나중에 별을 남기려면 {url} 를 열어 주세요.":
      "以后想点星标时，请打开 {url} 。",
    "저장소 페이지를 열었습니다. 오른쪽 위 Star 버튼을 눌러 주세요.":
      "已打开仓库页面。请点击右上角的 Star 按钮。",
    "브라우저를 열지 못했습니다. {url} 에서 Star를 눌러 주세요.":
      "未能打开浏览器。请到 {url} 点击 Star。",
    "별은 {url} 에서 언제든 남길 수 있습니다.":
      "你随时可以在 {url} 留下星标。",
    "지금 확인: {url} (npm run dev 실행 후)":
      "立即查看：{url}（运行 npm run dev 后）",
    "다음 단계 문서: {url}": "下一步指南：{url}",
    "callback URL은 명령 기록에 남지 않도록 인자로 받지 않습니다. npm run setup:finish만 실행하세요.":
      "为避免留在命令历史中，callback URL 不作为参数接收。请只运行 npm run setup:finish。",
    [CALLBACK_URL_SECURITY_WARNING]: [
      "注意：callback URL 中包含 Google 签发的短期一次性认证代码。",
      "此地址只能粘贴到本机终端，切勿在聊天、issue 或截图中分享。",
    ].join("\n"),
    [SETUP_COMPLETION_NEXT_STEPS]: [
      "你已准备好一个由多人共用主机 Google Drive 存储空间的 ShareDesk。",
      "接下来请从 docs/INSTALL.md 的“Vercel Production 环境变量与重新部署”步骤继续。",
      "将机密值安全地移入 Production 环境后重新部署，并实际确认线上登录和文件保存。",
      "确认可用后，在 /admin 创建邀请码邀请一个人，并确认两个账号能看到同一个文件。",
      "Vercel Firewall 在功能确认完成后、保护邀请码请求的运营阶段再设置。",
    ].join("\n"),
  },
};

let setupLocale = "ko";

export function setSetupLocale(locale) {
  setupLocale = resolveSetupLocale(locale) ?? "ko";
}

// 한국어 원문이 키다. 번역이 없으면 영어 → 한국어 원문 순으로 폴백한다.
export function t(text, vars) {
  let out =
    setupLocale === "ko"
      ? text
      : SETUP_MESSAGES[setupLocale]?.[text] ?? SETUP_MESSAGES.en[text] ?? text;
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      out = out.replaceAll(`{${key}}`, String(value));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 도트 배너 — 제품의 픽셀 감성을 첫 실행부터 보여 준다. 순수 ASCII, 80자 이내.
// ---------------------------------------------------------------------------

const BANNER_FONT = {
  S: ["#####", "#    ", "#####", "    #", "#####"],
  H: ["#   #", "#   #", "#####", "#   #", "#   #"],
  A: [" ### ", "#   #", "#####", "#   #", "#   #"],
  R: ["#### ", "#   #", "#### ", "#  # ", "#   #"],
  E: ["#####", "#    ", "#### ", "#    ", "#####"],
  D: ["#### ", "#   #", "#   #", "#   #", "#### "],
  K: ["#   #", "#  # ", "###  ", "#  # ", "#   #"],
};

export function renderSetupBanner(word = "SHAREDESK") {
  const rows = Array.from({ length: 5 }, (_, row) =>
    [...word]
      .map((letter) => BANNER_FONT[letter]?.[row] ?? "     ")
      .join(" ")
      .replace(/\s+$/u, ""),
  );
  const width = Math.max(...rows.map((row) => row.length));
  const dotted = ". ".repeat(Math.ceil(width / 2)).slice(0, width);
  return [dotted, ...rows, dotted].join("\n");
}

function isInteractiveSetup() {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

async function askOnce(question) {
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
  }
}

// 이 컴퓨터의 GitHub CLI(gh) 로그인을 빌려 조용히 별을 남긴다.
// gh가 없거나 로그인돼 있지 않으면 false — 호출부가 묻는 흐름으로 넘어간다.
export async function autoStarViaGh(execFileImpl = execFile) {
  try {
    await new Promise((resolve, reject) => {
      execFileImpl(
        "gh",
        [
          "api",
          "--method",
          "PUT",
          "--silent",
          "user/starred/Youkamii/sharedesk-template",
        ],
        { windowsHide: true, timeout: 15_000 },
        (error) => (error ? reject(error) : resolve(undefined)),
      );
    });
    console.log(t("GitHub 저장소에 별을 남겼습니다. 고맙습니다!"));
    return true;
  } catch {
    return false;
  }
}

export async function askToStar(ask, open = openBrowser) {
  // 먼저 자동으로 시도한다 — 성공하면 물어볼 것이 없다.
  if (await autoStarViaGh()) return true;
  const answer = (
    await ask(t("ShareDesk가 도움이 되었다면 GitHub 저장소에 별을 남겨 주시겠어요? (y/N): "))
  )
    .trim()
    .toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    console.log(
      t("나중에 별을 남기려면 {url} 를 열어 주세요.", { url: STAR_REPOSITORY_URL }),
    );
    return false;
  }
  const opened = await open(STAR_REPOSITORY_URL);
  console.log(
    opened
      ? t("저장소 페이지를 열었습니다. 오른쪽 위 Star 버튼을 눌러 주세요.")
      : t("브라우저를 열지 못했습니다. {url} 에서 Star를 눌러 주세요.", {
          url: STAR_REPOSITORY_URL,
        }),
  );
  return true;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";
const STATE_DIR = ".sharedesk";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const CORE_STATE_FILES = [
  {
    name: "users.json",
    value: {
      version: 2,
      rev: 0,
      users: [],
      invitations: [],
    },
  },
  {
    name: "drive-shares.json",
    value: {
      version: 2,
      rev: 0,
      permissions: [],
    },
  },
];

function runWindowsCommand(executable, args) {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("Windows 비밀 파일 권한 명령을 실행하지 못했습니다."));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function windowsExecutable(name) {
  const windowsRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  return path.join(windowsRoot, "System32", name);
}

export function browserOpenCommand(
  url,
  platform = process.platform,
  environment = process.env,
) {
  if (platform === "win32") {
    const windowsRoot = environment.SystemRoot || environment.windir || "C:\\Windows";
    return {
      // Windows 경로는 실행 플랫폼과 무관하게 역슬래시로 만든다.
      // path.join은 Linux(업데이트 검증 러너)에서 슬래시를 섞는다.
      executable: path.win32.join(windowsRoot, "System32", "rundll32.exe"),
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  if (platform === "darwin") {
    return { executable: "open", args: [url] };
  }
  if (platform === "linux") {
    return { executable: "xdg-open", args: [url] };
  }
  return null;
}

export function openBrowser(url, execFileImpl = execFile) {
  const command = browserOpenCommand(url);
  if (!command) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      execFileImpl(
        command.executable,
        command.args,
        { windowsHide: true, timeout: 5_000 },
        (error) => resolve(!error),
      );
    } catch {
      resolve(false);
    }
  });
}

let windowsUserSidPromise;

export function parseWhoamiUserSid(output) {
  const row = output.trim();
  const match = row.match(/^"((?:[^"]|"")*)","(S-\d+(?:-\d+)+)"$/);
  const sid = match?.[2];
  if (!sid || !/^S-\d+(?:-\d+)+$/.test(sid)) {
    throw new Error("Windows 현재 사용자 SID를 확인하지 못했습니다.");
  }
  return sid;
}

async function windowsUserSid() {
  windowsUserSidPromise ??= runWindowsCommand(
    windowsExecutable("whoami.exe"),
    ["/user", "/fo", "csv", "/nh"],
  ).then(parseWhoamiUserSid);
  return windowsUserSidPromise;
}

async function setWindowsPrivateAcl(filePath, sid, directory = false) {
  const permission = directory ? `*${sid}:(OI)(CI)(F)` : `*${sid}:(F)`;
  await runWindowsCommand(windowsExecutable("icacls.exe"), [
    filePath,
    "/inheritance:r",
    "/grant:r",
    permission,
    "/q",
  ]);
}

async function verifyWindowsPrivateAcl(filePath, sid) {
  const auditRoot = await mkdtemp(path.join(tmpdir(), "sharedesk-acl-"));
  const auditPath = path.join(auditRoot, "acl");
  let cleanupFailed = false;
  try {
    await setWindowsPrivateAcl(auditRoot, sid, true);
    await runWindowsCommand(windowsExecutable("icacls.exe"), [
      filePath,
      "/save",
      auditPath,
      "/q",
    ]);
    const savedAcl = await readFile(auditPath, "utf16le");
    const descriptor = savedAcl
      .split(/\r?\n/)
      .find((line) => line.startsWith("D:"));
    const firstAce = descriptor?.indexOf("(") ?? -1;
    const descriptorFlags =
      descriptor && firstAce >= 0 ? descriptor.slice(2, firstAce) : "";
    const aces = descriptor
      ? [...descriptor.matchAll(/\(([^()]*)\)/g)].map((match) =>
          match[1].split(";"),
        )
      : [];
    const onlyAce = aces[0];
    const isPrivate =
      descriptorFlags.includes("P") &&
      aces.length === 1 &&
      onlyAce?.[0] === "A" &&
      onlyAce?.[2] === "FA" &&
      onlyAce?.[5]?.toUpperCase() === sid.toUpperCase();
    if (!isPrivate) {
      throw new Error("Windows 비밀 파일 권한 확인에 실패했습니다.");
    }
  } finally {
    try {
      await rm(auditRoot, { recursive: true, force: true });
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    throw new Error("Windows 권한 확인용 임시 파일을 정리하지 못했습니다.");
  }
}

export async function protectPrivateFile(filePath) {
  try {
    if (process.platform === "win32") {
      const sid = await windowsUserSid();
      await setWindowsPrivateAcl(filePath, sid);
      await verifyWindowsPrivateAcl(filePath, sid);
      return;
    }

    await chmod(filePath, 0o600);
    if (((await stat(filePath)).mode & 0o777) !== 0o600) {
      throw new Error("잘못된 POSIX 파일 권한입니다.");
    }
  } catch {
    throw new Error("비밀 파일 권한을 소유자 전용으로 설정하지 못했습니다.");
  }
}

export async function protectPrivateDirectory(directoryPath) {
  try {
    if (process.platform === "win32") {
      const sid = await windowsUserSid();
      await setWindowsPrivateAcl(directoryPath, sid, true);
      await verifyWindowsPrivateAcl(directoryPath, sid);
      return;
    }

    await chmod(directoryPath, 0o700);
    if (((await stat(directoryPath)).mode & 0o777) !== 0o700) {
      throw new Error("잘못된 POSIX 폴더 권한입니다.");
    }
  } catch {
    throw new Error("비밀 작업 폴더 권한을 소유자 전용으로 설정하지 못했습니다.");
  }
}

async function removePrivateArtifact(filePath, removeFile = unlink) {
  try {
    await removeFile(filePath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

async function removePrivateDirectory(directoryPath, removeDirectory = rmdir) {
  try {
    await removeDirectory(directoryPath);
    return true;
  } catch (error) {
    return error?.code === "ENOENT";
  }
}

export async function writePrivateFile(
  filePath,
  contents,
  {
    createStagingDirectory = mkdtemp,
    protectDirectory = protectPrivateDirectory,
    protectFile = protectPrivateFile,
    removeFile = unlink,
    removeDirectory = rmdir,
  } = {},
) {
  let stagingPath;
  let tempPath;
  let backupPath;
  let stagingCreated = false;
  const hadExistingFile = existsSync(filePath);
  let tempCreated = false;
  let backupCreated = false;
  let backupReady = false;
  let finalReplaced = false;
  let existingContents;
  try {
    // 대상과 같은 폴더에 staging을 만들면 최종 rename이 같은 볼륨에서 이뤄진다.
    // 아직 비밀이 없을 때 폴더부터 잠가 이후 파일이 생성 순간부터 제한 ACL을 상속받게 한다.
    stagingPath = await createStagingDirectory(
      path.join(path.dirname(filePath), ".sharedesk-private-"),
    );
    stagingCreated = true;
    await protectDirectory(stagingPath);
    tempPath = path.join(stagingPath, "new");
    backupPath = path.join(stagingPath, "previous");

    if (hadExistingFile) {
      await protectFile(filePath);
      existingContents = await readFile(filePath);

      // 하드 링크를 지원하지 않는 파일 시스템에서도 되돌릴 수 있도록 별도 파일에
      // 복사한다. 백업 역시 빈 파일일 때 먼저 보호하고 나서 기존 내용을 기록한다.
      const backupHandle = await open(backupPath, "wx", 0o600);
      backupCreated = true;
      await backupHandle.close();
      await protectFile(backupPath);
      await writeFile(backupPath, existingContents, { flag: "r+" });
      backupReady = true;
      existingContents.fill(0);
      existingContents = undefined;
    }

    // 빈 파일부터 보호한 다음 내용을 쓴다. Windows에서 상속 ACL을 끊기 전에
    // refresh token이나 PKCE가 잠깐이라도 다른 계정에 노출되는 틈을 만들지 않는다.
    const handle = await open(tempPath, "wx", 0o600);
    tempCreated = true;
    await handle.close();
    await protectFile(tempPath);
    await writeFile(tempPath, contents, { encoding: "utf8", flag: "r+" });
    await rename(tempPath, filePath);
    tempCreated = false;
    finalReplaced = true;
    await protectFile(filePath);
  } catch {
    existingContents?.fill(0);

    if (finalReplaced) {
      if (backupReady) {
        try {
          await rename(backupPath, filePath);
          backupCreated = false;
          backupReady = false;
        } catch {
          throw new Error(
            "비밀 파일 교체를 되돌리지 못했습니다. 새 파일과 보호된 복구 파일은 그대로 보존했습니다.",
          );
        }
        const stagingRemoved = await removePrivateDirectory(
          stagingPath,
          removeDirectory,
        );
        if (!stagingRemoved) {
          throw new Error(
            "기존 비밀 파일은 복원했지만 빈 보호 작업 폴더를 정리하지 못했습니다.",
          );
        }
      } else {
        const removed = await removePrivateArtifact(filePath, removeFile);
        if (!removed) {
          throw new Error(
            "새 비밀 파일을 정리하지 못했습니다. 파일 권한은 현재 사용자 전용으로 제한되어 있습니다.",
          );
        }
        const stagingRemoved = await removePrivateDirectory(
          stagingPath,
          removeDirectory,
        );
        if (!stagingRemoved) {
          throw new Error(
            "새 비밀 파일은 제거했지만 빈 보호 작업 폴더를 정리하지 못했습니다.",
          );
        }
      }
    } else {
      const tempRemoved =
        !tempCreated ||
        (await removePrivateArtifact(tempPath, removeFile));
      const backupRemoved =
        !backupCreated ||
        (await removePrivateArtifact(backupPath, removeFile));
      const stagingRemoved =
        (!stagingCreated || (tempRemoved && backupRemoved)) &&
        (!stagingCreated ||
          (await removePrivateDirectory(stagingPath, removeDirectory)));
      if (!tempRemoved || !backupRemoved || !stagingRemoved) {
        throw new Error(
          "설정은 중단됐고 기존 파일은 보존됐지만 보호된 작업 파일을 정리하지 못했습니다.",
        );
      }
    }
    throw new Error("비밀 파일을 안전하게 저장하지 못해 설정을 중단했습니다.");
  }

  // 여기부터는 새 최종 파일의 권한 확인까지 끝난 커밋 이후 정리다. 백업 삭제가
  // 실패해도 성공한 최종 파일을 지우거나 백업을 되돌림 원본으로 다시 쓰지 않는다.
  if (backupCreated) {
    const removed = await removePrivateArtifact(backupPath, removeFile);
    if (!removed) {
      throw new Error(
        "비밀 파일 저장은 끝났지만 보호된 이전 파일을 정리하지 못했습니다.",
      );
    }
    backupCreated = false;
  }
  if (stagingCreated) {
    const removed = await removePrivateDirectory(stagingPath, removeDirectory);
    if (!removed) {
      throw new Error(
        "비밀 파일 저장은 끝났지만 빈 보호 작업 폴더를 정리하지 못했습니다.",
      );
    }
  }
}

export async function prepareEnvFile({
  envPath = ENV_PATH,
  examplePath = ENV_EXAMPLE_PATH,
  privateWriter = writePrivateFile,
} = {}) {
  if (existsSync(envPath)) {
    await protectPrivateFile(envPath);
    return "protected";
  }

  let created = false;
  let example;
  try {
    const handle = await open(envPath, "wx", 0o600);
    created = true;
    await handle.close();
    await protectPrivateFile(envPath);
    example = await readFile(examplePath);
    await privateWriter(envPath, example);
    example.fill(0);
    example = undefined;
    await protectPrivateFile(envPath);
    return "created";
  } catch (error) {
    example?.fill(0);
    if (error?.code === "EEXIST") {
      await protectPrivateFile(envPath);
      return "protected";
    }
    if (created) {
      await removePrivateArtifact(envPath);
    }
    throw new Error("로컬 환경 파일을 안전하게 준비하지 못했습니다.");
  }
}

function newSessionSecret() {
  return randomBytes(32).toString("hex");
}

export function parseEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    // dotenv 관례대로 감싼 따옴표를 벗긴다 — 벗기지 않으면 앱(Next dotenv)과
    // 이 스크립트가 같은 파일을 다르게 읽는다.
    const raw = m[2].trim();
    env[m[1]] =
      (raw.startsWith('"') && raw.endsWith('"')) ||
      (raw.startsWith("'") && raw.endsWith("'"))
        ? raw.slice(1, -1)
        : raw;
  }
  return env;
}

export function mergeEnv(text, updates) {
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && updates[m[1]] !== undefined) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  out.push("");
  return out.join("\n");
}

export function parseCallbackUrl(value) {
  try {
    return new URL(value.trim());
  } catch {
    throw new Error("callback URL 형식이 올바르지 않습니다.");
  }
}

function assertSingleCoreStateFiles(files) {
  for (const { name } of CORE_STATE_FILES) {
    const matches = files.filter((file) => file.name === name);
    if (matches.length > 1) {
      throw new Error(
        `.sharedesk/${name} 파일이 여러 개입니다. 데이터를 확인해 하나만 남긴 뒤 다시 실행하세요.`,
      );
    }
  }
}

async function listCoreStateFiles(fetchImpl, accessToken, stateFolderId) {
  const files = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      q: `'${stateFolderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,name)",
      pageSize: "1000",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetchImpl(`${DRIVE_API}/files?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new Error(`핵심 상태 파일 조회 실패 (${response.status})`);
    }
    const body = await response.json();
    files.push(
      ...(body.files || []).filter((file) =>
        CORE_STATE_FILES.some(({ name }) => name === file.name),
      ),
    );
    pageToken = body.nextPageToken;
  } while (pageToken);
  return files;
}

async function uploadCoreStateFile(
  fetchImpl,
  accessToken,
  stateFolderId,
  stateFile,
) {
  const boundary = `sharedesk_${randomBytes(16).toString("hex")}`;
  const metadata = JSON.stringify({
    name: stateFile.name,
    mimeType: "application/json",
    parents: [stateFolderId],
  });
  const content = JSON.stringify(stateFile.value, null, 2) + "\n";
  const body = [
    `--${boundary}\r\n`,
    "Content-Type: application/json; charset=UTF-8\r\n\r\n",
    `${metadata}\r\n`,
    `--${boundary}\r\n`,
    "Content-Type: application/json; charset=UTF-8\r\n\r\n",
    `${content}\r\n`,
    `--${boundary}--\r\n`,
  ].join("");
  const response = await fetchImpl(
    `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id,name`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  );
  if (!response.ok) {
    throw new Error(`${stateFile.name} 생성 실패 (${response.status})`);
  }
}

/**
 * @param {{
 *   accessToken: string;
 *   stateFolderId: string;
 *   fetchImpl?: typeof fetch;
 *   log?: Pick<Console, "info">;
 * }} options
 */
export async function ensureCoreStateFiles({
  accessToken,
  stateFolderId,
  fetchImpl = fetch,
  log = console,
}) {
  const existing = await listCoreStateFiles(
    fetchImpl,
    accessToken,
    stateFolderId,
  );
  assertSingleCoreStateFiles(existing);

  for (const stateFile of CORE_STATE_FILES) {
    if (existing.some((file) => file.name === stateFile.name)) {
      log.info(`기존 상태 파일을 보존합니다: ${stateFile.name}`);
      continue;
    }
    await uploadCoreStateFile(
      fetchImpl,
      accessToken,
      stateFolderId,
      stateFile,
    );
    log.info(`핵심 상태 파일을 만들었습니다: ${stateFile.name}`);
  }

  // Drive는 동명 파일을 허용한다. 생성 직후 다시 조회해 다른 setup 실행과
  // 겹쳐 둘이 된 경우도 임의로 하나를 고르지 않고 중단한다.
  const verified = await listCoreStateFiles(
    fetchImpl,
    accessToken,
    stateFolderId,
  );
  assertSingleCoreStateFiles(verified);
  for (const { name } of CORE_STATE_FILES) {
    if (!verified.some((file) => file.name === name)) {
      throw new Error(`.sharedesk/${name} 파일 생성을 확인하지 못했습니다.`);
    }
  }
}

async function main() {
  console.log(renderSetupBanner());
  console.log("");

  if (process.argv.includes("--prepare-env")) {
    const result = await prepareEnvFile();
    console.log(
      result === "created"
        ? ".env.local을 소유자 전용 권한으로 준비했습니다. 이제 OAuth 값을 입력하세요."
        : "기존 .env.local 내용은 건드리지 않고 소유자 전용 권한만 확인했습니다.",
    );
    return;
  }

  if (!existsSync(ENV_PATH)) {
    await prepareEnvFile();
    console.log(
      ".env.local이 없어 소유자 전용 권한으로 자동 준비했습니다.",
    );
  }

  let raw = "";
  await protectPrivateFile(ENV_PATH);
  raw = await readFile(ENV_PATH, "utf8");
  const fileEnv = parseEnv(raw);
  const get = (k) => fileEnv[k] || process.env[k] || "";

  const finishArg = process.argv.indexOf("--finish");
  const isFinish = finishArg >= 0;
  const isCheck = process.argv.includes("--check");
  // --restart: 진행 중 인증을 무시하고 처음부터 — 비대화형 잠금의 탈출구.
  const isRestart = process.argv.includes("--restart");

  // 이미 저장된 기본 언어가 있으면 그 언어로 말한다. 없으면 한국어 원문.
  let selectedLocale = resolveSetupLocale(get("SHAREDESK_DEFAULT_LOCALE"));
  setSetupLocale(selectedLocale ?? "ko");

  // 비대화형(AI 설치)에서는 --locale=xx 플래그로 언어를 지정할 수 있다.
  const localeArg = process.argv.find((arg) => arg.startsWith("--locale="));
  if (localeArg) {
    const flagLocale = resolveSetupLocale(localeArg.slice("--locale=".length));
    if (flagLocale) {
      selectedLocale = flagLocale;
      setSetupLocale(flagLocale);
    }
  }

  // 언어 선택 — 새 설정(1단계)에서만 묻는다. finish는 1단계의 선택을 이어받고,
  // 비대화형(파이프·CI)에서는 묻지 않고 플래그/기존 값/한국어를 유지한다.
  if (!localeArg && !isFinish && !isCheck && isInteractiveSetup()) {
    selectedLocale =
      resolveSetupLocale(await askOnce(SETUP_LANGUAGE_QUESTION)) ?? "en";
    setSetupLocale(selectedLocale);
    console.log(
      t("데스크 기본 언어: {label}", {
        label: SETUP_LOCALE_LABELS[selectedLocale],
      }) + "\n",
    );
  }

  const clientId = get("GOOGLE_CLIENT_ID");
  const clientSecret = get("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    console.error(t("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET이 .env.local에 없습니다."));
    console.error("");
    console.error(GOOGLE_AUTH_PLATFORM_GUIDANCE);
    process.exit(1);
  }

  // --- 1단계: 인증 URL 생성 ---
  if (!isFinish) {
    // 진행 중 인증이 살아 있으면 state를 새로 돌리기 전에 알린다 — PowerShell에서
    // npm run setup -- --finish의 --finish가 npm에 먹혀 bare setup이 재실행되면
    // state가 회전해 방금 받은 인증 링크가 무효가 되는 사고를 막는다.
    if (!isCheck && !isRestart && existsSync(PENDING_PATH)) {
      // 30분이 지난 인증은 구글 쪽에서도 이미 죽었다 — 잠금이 되지 않게
      // 자동으로 새로 시작한다.
      let pendingFresh = false;
      try {
        const previous = JSON.parse(await readFile(PENDING_PATH, "utf8"));
        pendingFresh =
          typeof previous.createdAt === "number" &&
          Date.now() - previous.createdAt < 30 * 60_000;
      } catch {
        pendingFresh = false;
      }
      if (!pendingFresh) {
        console.log(t("이전 인증이 만료되어 새로 시작합니다."));
      } else {
        console.log(
          t("진행 중인 인증이 있습니다. 마치려면 npm run setup:finish 를 실행하세요."),
        );
        if (!isInteractiveSetup()) {
          console.log(
            t("처음부터 다시 시작하려면 npm run setup:restart 를 실행하세요."),
          );
          // 자동화가 이 상태를 성공으로 오해하지 않게 실패 코드로 끝낸다.
          process.exitCode = 1;
          return;
        }
        const restart = (
          await askOnce(
            t("이어가지 않고 새로 시작할까요? 새로 시작하면 기존 인증 링크는 무효가 됩니다. (y/N): "),
          )
        )
          .trim()
          .toLowerCase();
        if (restart !== "y" && restart !== "yes") {
          // 방금 고른 언어는 버리지 않고 기존 인증에 이어 둔다.
          if (selectedLocale) {
            try {
              const previous = JSON.parse(await readFile(PENDING_PATH, "utf8"));
              previous.locale = selectedLocale;
              await writeFile(PENDING_PATH, JSON.stringify(previous));
              await protectPrivateFile(PENDING_PATH);
            } catch {
              // 이어 두기 실패는 치명적이지 않다 — 기본 언어로 남는다.
            }
          }
          console.log(
            t("기존 인증을 그대로 두었습니다. npm run setup:finish 로 마무리하세요."),
          );
          return;
        }
      }
    }

    // state와 PKCE로 콜백 위조를 막는다 (RFC 8252 §8.1/§8.9).
    const state = randomBytes(16).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    const authUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?" +
      new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });

    if (isCheck) {
      console.log("[check] 환경 점검 통과. 인증 URL:");
      console.log(authUrl);
      return;
    }

    console.log(t("[1/2] Google 인증을 시작합니다.") + "\n");

    // 선택한 언어를 2단계(finish)가 이어받도록 state와 함께 보관한다.
    await writePrivateFile(
      PENDING_PATH,
      JSON.stringify(
        { state, codeVerifier, locale: selectedLocale ?? undefined, createdAt: Date.now() },
        null,
        2,
      ),
    );

    const browserOpened = await openBrowser(authUrl);
    console.log(
      browserOpened
        ? t("1) Google 인증 페이지를 기본 브라우저에서 열었습니다.")
        : t("1) 브라우저를 자동으로 열지 못했습니다. 아래 URL을 직접 여세요."),
    );
    console.log(t("브라우저가 열리지 않았거나 다른 계정을 쓰려면 아래 URL을 여세요:") + "\n");
    console.log(authUrl + "\n");
    console.log(t(CALLBACK_URL_SECURITY_WARNING) + "\n");
    console.log(t("2) 동의하면 브라우저가 127.0.0.1 주소로 이동하면서"));
    console.log(t("   '연결할 수 없음' 같은 오류 화면이 뜹니다 — 정상입니다."));
    console.log(t("   그때 주소창의 주소 전체를 복사하세요.") + "\n");
    console.log(t("3) 아래 명령을 실행한 뒤, 물어보면 복사한 주소를 붙여넣으세요:") + "\n");
    console.log("   npm run setup:finish");
    return;
  }

  // --- 2단계: 붙여넣은 콜백 주소로 토큰 교환 ---
  if (!existsSync(PENDING_PATH)) {
    console.error(t("진행 중인 설정이 없습니다 — 먼저 npm run setup 을 실행하세요."));
    process.exit(1);
  }
  await protectPrivateFile(PENDING_PATH);
  const pending = JSON.parse(await readFile(PENDING_PATH, "utf8"));
  const { state, codeVerifier } = pending;

  // 1단계에서 고른 언어를 이어받는다 — finish에서 언어를 다시 묻지 않는다.
  const pendingLocale = resolveSetupLocale(pending.locale);
  if (pendingLocale) {
    selectedLocale = pendingLocale;
    setSetupLocale(pendingLocale);
  }
  console.log(t("[2/2] 인증을 마치고 설정을 저장합니다.") + "\n");

  if (process.argv[finishArg + 1]) {
    console.error(
      t("callback URL은 명령 기록에 남지 않도록 인자로 받지 않습니다. npm run setup:finish만 실행하세요."),
    );
    process.exit(1);
  }
  console.warn("\n" + t(CALLBACK_URL_SECURITY_WARNING) + "\n");
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let pasted;
  try {
    pasted = await prompt.question(
      t("브라우저 주소창의 callback URL 전체를 붙여넣으세요: "),
    );
  } finally {
    prompt.close();
  }
  if (!pasted.trim()) {
    console.error("callback URL을 입력하지 않았습니다.");
    process.exit(1);
  }
  let callbackUrl;
  try {
    callbackUrl = parseCallbackUrl(pasted);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const err = callbackUrl.searchParams.get("error");
  if (err) {
    console.error("동의가 거부되었습니다:", err);
    process.exit(1);
  }
  const code = callbackUrl.searchParams.get("code");
  const gotState = callbackUrl.searchParams.get("state") ?? "";
  if (!code) {
    console.error("주소에 code가 없습니다 — 동의 후 이동한 주소 전체를 붙여넣었는지 확인하세요.");
    process.exit(1);
  }
  if (
    gotState.length !== state.length ||
    !timingSafeEqual(Buffer.from(gotState), Buffer.from(state))
  ) {
    console.error("state가 일치하지 않습니다 — 이 설정 회차의 주소가 아닙니다.");
    process.exit(1);
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
  });
  if (!tokenRes.ok) {
    console.error("토큰 교환 실패:", await tokenRes.text());
    process.exit(1);
  }
  const tok = await tokenRes.json();
  if (!tok.refresh_token) {
    console.error(REFRESH_TOKEN_RECOVERY_GUIDANCE);
    process.exit(1);
  }

  // 드라이브 주인이 곧 관리자다. 이 이메일로 로그인하면 자동 승인되고 관리 화면이 열린다.
  let adminEmails = fileEnv["ADMIN_EMAILS"] || "";
  if (!adminEmails) {
    const meRes = await fetch(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { Authorization: `Bearer ${tok.access_token}` } },
    );
    if (meRes.ok) {
      const me = await meRes.json();
      if (me.email) {
        adminEmails = me.email;
        console.log(t("관리자로 등록:"), me.email);
      }
    }
    if (!adminEmails) {
      console.warn(
        "경고: 관리자 이메일을 확인하지 못했습니다 — .env.local의 ADMIN_EMAILS를 직접 채우세요",
      );
    }
  }

  let rootId = get("DRIVE_ROOT_FOLDER_ID");
  if (rootId) {
    console.log("기존 루트 폴더를 그대로 사용합니다:", rootId);
  } else {
    const folderRes = await fetch(
      "https://www.googleapis.com/drive/v3/files?fields=id",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok.access_token}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ name: "ShareDesk", mimeType: FOLDER_MIME }),
      },
    );
    if (!folderRes.ok) {
      console.error("루트 폴더 생성 실패:", await folderRes.text());
      process.exit(1);
    }
    rootId = (await folderRes.json()).id;
    console.log(t("드라이브에 루트 폴더 'ShareDesk'를 만들었습니다:"), rootId);
  }

  // 서버리스 인스턴스들이 동시에 시작하며 각자 .sharedesk를 만드는 일을 막기 위해
  // 상태 폴더도 setup에서 한 번 정하고 ID를 고정한다.
  let stateFolderId = get("DRIVE_STATE_FOLDER_ID");
  if (stateFolderId) {
    const stateRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(stateFolderId)}?fields=id,name,mimeType,parents,trashed`,
      { headers: { Authorization: `Bearer ${tok.access_token}` } },
    );
    const state = stateRes.ok ? await stateRes.json() : null;
    if (
      !state ||
      state.name !== STATE_DIR ||
      state.mimeType !== FOLDER_MIME ||
      state.trashed === true ||
      state.parents?.[0] !== rootId
    ) {
      console.error(
        "DRIVE_STATE_FOLDER_ID가 현재 ShareDesk 루트의 .sharedesk 폴더가 아닙니다.",
      );
      process.exit(1);
    }
    console.log("기존 상태 폴더를 그대로 사용합니다:", stateFolderId);
  } else {
    const listStateFolders = async () => {
      const params = new URLSearchParams({
        q: `'${rootId}' in parents and name='${STATE_DIR}' and mimeType='${FOLDER_MIME}' and trashed=false`,
        fields: "files(id,createdTime)",
        pageSize: "1000",
      });
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files?${params}`,
        { headers: { Authorization: `Bearer ${tok.access_token}` } },
      );
      if (!response.ok) {
        console.error("상태 폴더 조회 실패:", await response.text());
        process.exit(1);
      }
      const body = await response.json();
      return (body.files || []).sort(
        (a, b) =>
          (a.createdTime || "").localeCompare(b.createdTime || "") ||
          a.id.localeCompare(b.id),
      );
    };

    let stateFolders = await listStateFolders();
    if (stateFolders.length > 1) {
      console.error(
        ".sharedesk 폴더가 여러 개라 자동으로 고를 수 없습니다. 데이터 확인 후 DRIVE_STATE_FOLDER_ID를 지정하세요.",
      );
      process.exit(1);
    }
    if (stateFolders[0]) {
      stateFolderId = stateFolders[0].id;
    } else {
      const createStateRes = await fetch(
        "https://www.googleapis.com/drive/v3/files?fields=id",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tok.access_token}`,
            "Content-Type": "application/json; charset=UTF-8",
          },
          body: JSON.stringify({
            name: STATE_DIR,
            mimeType: FOLDER_MIME,
            parents: [rootId],
          }),
        },
      );
      if (!createStateRes.ok) {
        console.error("상태 폴더 생성 실패:", await createStateRes.text());
        process.exit(1);
      }
      const createdState = await createStateRes.json();
      stateFolders = await listStateFolders();
      stateFolderId = stateFolders[0]?.id;
      if (!stateFolderId) {
        console.error("생성한 상태 폴더를 확인하지 못했습니다.");
        process.exit(1);
      }
      if (createdState.id !== stateFolderId) {
        await fetch(
          `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(createdState.id)}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${tok.access_token}`,
              "Content-Type": "application/json; charset=UTF-8",
            },
            body: JSON.stringify({ trashed: true }),
          },
        );
      }
    }
    console.log("상태 폴더 '.sharedesk'를 고정했습니다:", stateFolderId);
  }

  await ensureCoreStateFiles({
    accessToken: tok.access_token,
    stateFolderId,
  });

  // 기본 입장 경로는 구글 로그인 + 관리자 승인이다. 키는 자동 생성하지 않고,
  // 손님용 임시 입장이 필요할 때만 ACCESS_KEYS에 직접 적어 넣는다.
  const accessKeys = fileEnv["ACCESS_KEYS"] || "";
  let sessionSecret = fileEnv["SESSION_SECRET"] || "";
  if (sessionSecret.length < 16) {
    sessionSecret = newSessionSecret();
  }
  let cronSecret = fileEnv["CRON_SECRET"] || "";
  if (cronSecret.length < 16) {
    cronSecret = newSessionSecret();
  }

  const merged = mergeEnv(raw, {
    ACCESS_KEYS: accessKeys,
    ADMIN_EMAILS: adminEmails,
    SESSION_SECRET: sessionSecret,
    CRON_SECRET: cronSecret,
    STORAGE_DRIVER: "drive",
    // 설치 때 고른 데스크 기본 언어. 앱은 새 데스크의 deskSettings.locale 기본값으로 읽는다.
    // Vercel 운영 환경 변수로도 이 값을 함께 옮긴다(docs/INSTALL.md의 재배포 단계).
    SHAREDESK_DEFAULT_LOCALE: selectedLocale ?? "en",
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_REFRESH_TOKEN: tok.refresh_token,
    DRIVE_ROOT_FOLDER_ID: rootId,
    DRIVE_STATE_FOLDER_ID: stateFolderId,
  });
  await writePrivateFile(ENV_PATH, merged);
  // 인증 코드는 한 번만 쓰이므로 남겨둘 이유가 없다.
  try {
    await unlink(PENDING_PATH);
  } catch {
    console.warn(
      "경고: .setup-pending.json을 삭제하지 못했습니다. 설정을 마친 뒤 직접 삭제하세요.",
    );
  }

  console.log("\n" + t("=== 설정 완료 ==="));
  console.log(t(".env.local 갱신됨 (refresh token은 파일에만 저장, 화면에 출력하지 않음)"));
  console.log(t("루트 폴더 ID:"), rootId);
  console.log("\n" + t(SETUP_COMPLETION_NEXT_STEPS));
  // 파일 경로만 알려 주면 어디를 열지 알 수 없다. 지금 바로 열 수 있는 주소를 준다.
  console.log(
    "\n" + t("지금 확인: {url} (npm run dev 실행 후)", { url: LOCAL_CHECK_URL }),
  );
  console.log(
    t("다음 단계 문서: {url}", { url: installDocUrl(setupLocale) }),
  );

  const starPrompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    await askToStar((question) => starPrompt.question(question));
  } catch {
    console.log(
      t("별은 {url} 에서 언제든 남길 수 있습니다.", { url: STAR_REPOSITORY_URL }),
    );
  } finally {
    starPrompt.close();
  }
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error("설정 실패:", e.message);
    process.exit(1);
  });
}
