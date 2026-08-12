# ShareDesk

내 Google Drive로 만드는 독립형 공유 파일 데스크입니다. 파일과 폴더를 아이콘처럼 배치하고 창을 열어 미리 보거나 정리할 수 있습니다.

ShareDesk는 모두가 한 운영 서버에 가입하는 서비스가 아닙니다. 설치할 때마다 **내 GitHub 저장소, 내 Vercel 프로젝트, 내 Google OAuth 클라이언트, 내 Drive 폴더**가 따로 생깁니다. 다른 사람이 만든 ShareDesk와 파일·사용자·초대 정보가 섞이지 않습니다.

![ShareDesk에서 폴더와 파일을 바탕화면처럼 정리한 화면](./docs/sharedesk-desktop.png)

| 하고 싶은 일 | 시작 방법 |
|---|---|
| 내 ShareDesk 만들기 | [설치 안내](./docs/INSTALL.md)에 따라 내 저장소, Vercel 프로젝트, Google Drive를 연결합니다. |
| 다른 사람의 ShareDesk에 참여하기 | Google 계정으로 로그인한 뒤 호스트가 공유한 기간제 초대 코드를 입력합니다. 1회용 코드는 한 명이 가입에 성공하면 바로 소진됩니다. 기간 내 무제한 코드는 만료되거나 호스트가 끌 때까지 여러 명이 함께 씁니다. OAuth나 Vercel 설정은 필요 없습니다. |

빠른 링크: [설치 안내](./docs/INSTALL.md) · [OAuth 없이 실행](#oauth-없이-로컬에서-실행하기) · [사람 초대하기](#사람-초대하기) · [문제 해결](#문제-해결)

## 내 ShareDesk 만들기

Vercel로 내 저장소와 첫 배포를 한 번에 만들 수 있습니다.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYoukamii%2Fsharedesk-template&project-name=my-sharedesk&repository-name=my-sharedesk)

템플릿만 복사하려면 [Use this template](https://github.com/Youkamii/sharedesk-template/generate)을 사용하세요. 첫 배포에는 Google 설정이 없으므로 로그인 대신 설치 안내가 나옵니다. 이후 절차는 [ShareDesk 운영 설치 안내](./docs/INSTALL.md)에 한 번만 정리해 두었습니다.

로컬 저장소와 터미널을 다룰 수 있는 코딩 에이전트에게 맡길 때는 아래 문장만 보내면 됩니다.

```text
이 저장소의 docs/INSTALL.md를 처음부터 끝까지 읽고 그대로 설치해줘. 현재 상태를 확인해 끝난 단계는 반복하지 말고, 문서에 표시된 사용자 조작 단계에서만 한 번에 한 단계씩 안내해. 문서 범위 안에서 이 저장소의 변경·push와 내 Vercel 프로젝트 배포는 허용한다.
```

설치가 끝난 운영 주소 하나가 독립 ShareDesk 하나입니다. 초대받은 사람은 그 데스크에 참여할 뿐 새 데스크를 받지 않습니다. 자기 데스크가 필요하면 같은 템플릿으로 별도 설치합니다.

## 주요 기능

- 파일과 폴더를 바탕화면 아이콘으로 표시하고 아이콘 위치를 폴더별로 공유합니다.
- 폴더는 이동·크기 조절·최소화를 지원하는 창으로 열립니다.
- 파일 업로드, 다운로드, 이름 변경, 새 폴더 만들기, 폴더 간 이동을 지원합니다.
- 사진, 동영상, 오디오, PDF, 텍스트 파일을 바로 미리 봅니다. Google 문서·시트·슬라이드·드로잉은 PDF로 변환해 보여 줍니다.
- 휴지통은 삭제한 항목의 복원과 완전 삭제를 모두 지원합니다. 휴지통 보관 기간은 30일입니다.
- ShareDesk에는 관리자용 Google Drive 공유 기능도 있습니다. 승인 사용자에게 파일이나 폴더를 공유하면서 보기·편집 권한을 정합니다.
- 초대 코드는 호스트가 유효 기간과 사용 방식을 정해 만들고 전달합니다. 1회용은 한 명이 가입에 성공하면 바로 끝납니다. 기간 내 무제한은 만료되거나 호스트가 비활성화할 때까지 여러 명이 같은 코드로 가입합니다. 관리 화면에는 사용자 차단, 특정 기기 로그인 끊기, 모든 로그인 끊기 기능이 있습니다.
- 해 질 녘, 깊은 밤, 새벽, 밤바다 배경을 제공합니다. 배경 선택은 개인 브라우저에만 저장됩니다.

## 어떻게 동작하나요?

```text
공개 ShareDesk 템플릿
        ├──▶ A의 GitHub · Vercel · Google OAuth ──▶ A의 Drive ──▶ A의 독립 데스크
        └──▶ B의 GitHub · Vercel · Google OAuth ──▶ B의 Drive ──▶ B의 독립 데스크

각 데스크의 관리자 ── 기간제 초대 코드(1회용 또는 기간 내 무제한) ──▶ 그 데스크의 참여자
```

- **배포 1개가 독립 데스크 1개입니다.** 배포마다 OAuth 비밀값, Drive 루트, 사용자·초대 상태가 따로 있으며 다른 배포와 공유하지 않습니다.
- 한 데스크에서 Google Drive에 연결하는 계정은 호스트 한 명입니다. 그 데스크의 참여자는 호스트의 Drive 용량을 함께 쓰며 자기 Drive 용량은 사용하지 않습니다.
- 별도 데이터베이스는 없습니다. 사용자, 초대, 공유 권한, 아이콘 배치는 Drive의 `ShareDesk/.sharedesk/` 폴더에 저장합니다.
- 브라우저만으로 동작하는 앱은 아닙니다. refresh token을 안전하게 보관하고 Drive API를 호출할 Next.js 서버 또는 Vercel 서버리스 환경이 필요합니다.
- 호스트 설정은 `drive.file` 권한을 요청합니다. 이 권한은 앱이 만들었거나 사용자가 명시적으로 접근을 허용한 파일에 한정됩니다. ShareDesk는 여기에 자체 루트 폴더 경계 검사도 적용합니다.
- 참여자는 `openid`, `email`, `profile`로 Google 로그인합니다. 이름과 이메일은 로그인한 Google 계정에서 확인되고, 호스트는 초대 코드를 만들 때 이 정보를 입력하지 않습니다. 참여자의 Drive 파일은 읽지 않습니다.
- 대용량 업로드는 서버가 파일 전체를 중계하지 않고 브라우저에서 Google Drive로 직접 전송합니다.
- 동시에 같은 항목을 수정하면 저장소 버전을 확인해 뒤늦은 쓰기를 거부하고 최신 상태를 다시 불러옵니다.

## OAuth 없이 로컬에서 실행하기

Google Cloud 설정 전에 UI와 파일 작업을 확인하는 개발 모드입니다. 파일은 프로젝트의 `.devstorage/`에 저장됩니다.

### 준비물

- [Node.js](https://nodejs.org/) 20.9 이상
- Git

### 실행

이미 이 저장소를 로컬에서 열었다면 `git clone`과 `cd`는 건너뛰세요.

```powershell
git clone https://github.com/Youkamii/sharedesk-template.git
cd sharedesk-template
npm ci
npm run setup -- --prepare-env
```

이 명령은 `.env.local`을 먼저 소유자 전용 권한으로 준비합니다. 기존 파일이 있으면 내용을 덮어쓰지 않고 권한만 확인합니다.

`.env.local`에서 다음 값만 채우세요.

```dotenv
STORAGE_DRIVER=local
LOCAL_STORAGE_ROOT=.devstorage
SESSION_SECRET=local-development-only-change-this-value
ACCESS_KEYS=demo
```

이 예시 비밀값과 접속 키는 로컬 체험 전용입니다. 인터넷에 공개된 배포에서는 새 값을 사용해야 합니다.

```powershell
npm run dev
```

브라우저에서 `http://localhost:3000`을 열고 `demo`를 손님용 키로 입력하세요. 이 모드에서는 Google 로그인, 초대 코드 가입, 실제 Drive 공유를 확인할 수 없습니다.

---

## 사람 초대하기

1. 관리자가 운영 주소의 `/admin`을 엽니다.
2. 초대 코드의 유효 기간을 `1시간`, `24시간`, `7일`, `30일` 중에서 고릅니다.
3. 사용 방식을 `1회용` 또는 `기간 내 무제한`으로 고릅니다. 이름, 이메일, 비고는 입력하지 않습니다.
4. 코드를 만들고 표시된 값을 참여할 사람에게 안전한 채널로 전달합니다.
5. 받는 사람은 자기 Google 계정으로 ShareDesk에 로그인합니다.
6. 로그인 뒤 나타나는 가입 화면에 코드를 입력하면 바로 승인됩니다.

초대 코드는 특정 사람이나 이메일에 미리 묶이지 않습니다. 이름과 이메일은 코드를 입력한 사용자의 Google 로그인에서 확인되며 호스트가 대신 입력하지 않습니다. 유효 기간은 코드를 만든 시점부터 시작됩니다.

- **1회용:** Google 계정으로 로그인한 가입 대기 사용자 중 한 명이 가입에 성공하면 바로 소진됩니다.
- **기간 내 무제한:** 정한 유효 기간이 끝나거나 호스트가 코드를 비활성화할 때까지 여러 명이 같은 코드로 가입합니다.

만료됐거나 비활성화된 코드는 사용할 수 없습니다. 이미 소진된 1회용 코드도 거부됩니다.

초대받은 사람은 OAuth 클라이언트나 Vercel 프로젝트를 만들 필요가 없습니다. 이 절차는 호스트가 이미 만든 한 데스크에 참여시키는 과정입니다. 자기 소유의 별도 데스크가 필요하면 [운영 설치 안내](./docs/INSTALL.md)에 따라 독립 배포해야 합니다.

관리 화면에서 할 수 있는 일은 다음과 같습니다.

| 작업 | 결과 |
|---|---|
| 차단 | 다음 요청부터 접근을 막고 기존 로그인 세션을 무효화합니다. |
| 이 로그인 끊기 | 선택한 기기의 해당 로그인만 끊습니다. 다른 기기의 로그인은 유지됩니다. |
| 모든 로그인 끊기 | 그 사용자의 모든 기기에서 발급된 로그인을 한꺼번에 끊습니다. |
| 가입 대기로 변경 | 접근을 멈춥니다. 사용자는 다시 로그인한 뒤 현재 사용할 수 있는 초대 코드를 입력해야 합니다. |
| 사용자 삭제 | 사용자 명단에서 지웁니다. 다시 로그인한 뒤 현재 사용할 수 있는 초대 코드가 있어야 들어올 수 있습니다. |

`ADMIN_EMAILS`에 적힌 계정은 관리자입니다. 관리자 계정을 바꾸었다면 Vercel 환경 변수를 수정한 뒤 다시 배포하세요.

ShareDesk는 새 Google 로그인마다 간단한 브라우저·운영체제 이름과 로그인 시각을 기록하고 사용자별로 최근 로그인 기록 20개만 보관합니다. 이 기능을 추가하기 전에 발급된 예전 쿠키는 기기 목록에 나타나지 않을 수 있습니다. 업그레이드 직후 예전 쿠키까지 확실히 정리하려면 **모든 로그인 끊기**를 한 번 실행하세요.

## Google Drive로 직접 공유하기

관리자가 파일이나 폴더를 우클릭하면 **Google Drive로 공유** 항목이 나타납니다. `/admin`에 등록된 승인 사용자에게 보기 또는 편집 권한을 줍니다.

이 기능은 ShareDesk 안에서 항목을 숨기거나 공개하는 기능이 아닙니다. 받는 사람의 Google Drive `공유 문서함(Shared with me)`에도 항목이 나타나게 하는 실제 Drive 권한입니다. 폴더 권한은 Google Drive 규칙에 따라 하위 항목에 이어집니다.

실제 공유 자동 검사는 별도 테스트 Google 계정이 있어야 합니다. 자세한 실행법은 [실제 Drive 검사](#실제-drive-검사)를 참고하세요. 받는 사람의 `공유 문서함` 화면과 보기·편집 역할 차이는 해당 계정으로 직접 확인해야 합니다.

---

# 문제 해결

| 증상 | 확인할 내용 |
|---|---|
| `redirect_uri_mismatch` | 오류에 나온 주소와 Clients에 등록한 URI를 글자 단위로 비교하세요. 같은 Client ID인지, `localhost`와 `127.0.0.1`, 포트, 경로, 끝 슬래시가 다른지 확인합니다. |
| `앱에 액세스할 수 없음` | Audience가 External인지 확인합니다. Testing을 유지한다면 로그인 계정을 Test user에 넣어야 합니다. |
| `org_internal` | Internal 앱에 조직 밖 Google 계정으로 로그인한 경우입니다. External로 바꾸거나 조직 계정을 사용하세요. |
| 동의 뒤 `127.0.0.1` 연결 실패 | setup에서는 정상입니다. 주소창 전체를 복사하고 `npm run setup -- --finish`를 실행한 뒤, 질문이 나오면 붙여넣으세요. |
| 콜백 주소에 `code`가 없음 | 동의를 취소했거나 오류가 난 주소입니다. `npm run setup`부터 다시 시작하고 주소 전체를 복사하세요. |
| `refresh_token을 받지 못했습니다` | 먼저 기존 연결과 Audience 상태를 확인하세요. 새 토큰이 실제로 필요하고 기존 연결 때문에 발급되지 않는 경우에만 [Google 계정의 연결된 앱](https://myaccount.google.com/permissions)에서 이 앱 권한을 제거한 뒤 setup을 다시 실행하세요. |
| 약 7일 뒤 Drive 연결이 끊김 | 먼저 Audience가 실제로 Testing인지 확인하세요. Testing에서 발급한 호스트 토큰이라면 In production 전환 뒤 setup을 다시 진행할 수 있습니다. 이미 In production이면 이 원인에 해당하지 않으므로 기존 토큰을 먼저 폐기하지 말고 실제 인증 오류를 확인하세요. |
| Drive API가 403을 반환 | OAuth 클라이언트를 만든 것과 같은 Cloud 프로젝트에서 Google Drive API가 켜져 있는지 확인하세요. Workspace 관리 정책이 외부 앱을 막는지도 확인합니다. |
| Vercel에서만 로그인이 실패 | Production 환경 변수, `PUBLIC_BASE_URL`, 운영 redirect URI를 확인하고 환경 변수 변경 뒤 Redeploy했는지 확인하세요. |
| 초대 코드가 거부됨 | 코드를 정확히 입력했는지와 만료일·활성 상태·사용 방식을 `/admin`에서 확인하세요. 1회용이라면 다른 사용자의 첫 가입 성공 뒤 이미 소진됐을 수 있습니다. 기간 내 무제한이라면 만료됐거나 호스트가 비활성화했는지 확인하세요. |
| 특정 Workspace 계정만 실패 | 조직 관리자의 서드파티 앱 접근 제한이나 Google Advanced Protection 정책을 확인하세요. |
| 관리자 로그인이 초대를 요구 | 로그인 이메일이 `ADMIN_EMAILS`와 정확히 같은지 확인하고 환경 변수를 바꿨다면 다시 배포하세요. |
| setup이 같은 이름의 상태 파일이 여러 개라고 중단 | Drive의 `ShareDesk/.sharedesk/`에서 해당 JSON 파일을 확인하세요. 내용을 비교해 보존할 파일 하나만 남긴 뒤 다시 실행해야 합니다. |

## setup을 다시 실행해도 되나요?

기존 `DRIVE_ROOT_FOLDER_ID`와 상태 폴더 ID가 `.env.local`에 있으면 setup은 그 폴더를 이어서 사용합니다. 기존 상태 JSON도 덮어쓰지 않습니다.

다만 `.sharedesk` 안에 같은 이름의 핵심 상태 파일이 여러 개라면 setup은 임의로 하나를 고르지 않고 중단합니다. 이 경우 Drive에서 내용을 직접 확인한 다음 하나만 남겨야 합니다.

Google Client secret을 교체했거나 refresh token을 다시 받아야 한다면 `.env.local`의 Client ID와 secret을 먼저 갱신하고 setup을 다시 시작하세요.

---

# 설정 참고

## 환경 변수

| 변수 | 필수 여부 | 설명 |
|---|---:|---|
| `ADMIN_EMAILS` | 운영 필수 | 관리자 Google 이메일. 여러 개면 쉼표로 구분합니다. |
| `SESSION_SECRET` | 필수 | 로그인 쿠키 서명 비밀입니다. 16자 이상이어야 하며 setup이 안전한 값을 만듭니다. |
| `STORAGE_DRIVER` | 필수 | 운영은 `drive`, OAuth 없는 개발은 `local`입니다. |
| `PUBLIC_BASE_URL` | 조건부 | 사용자 지정 도메인을 고정하거나 Vercel 시스템 환경 변수를 쓰지 않을 때 입력하는 고정 운영 origin입니다. |
| `GOOGLE_CLIENT_ID` | Drive/로그인 필수 | Web application 유형의 OAuth Client ID입니다. |
| `GOOGLE_CLIENT_SECRET` | Drive/로그인 필수 | OAuth Client secret입니다. |
| `GOOGLE_REFRESH_TOKEN` | Drive 필수 | setup이 받은 호스트의 오프라인 토큰입니다. |
| `DRIVE_ROOT_FOLDER_ID` | Drive 필수 | ShareDesk가 관리할 루트 폴더 ID입니다. |
| `DRIVE_STATE_FOLDER_ID` | Drive 필수 | `.sharedesk` 상태 폴더 ID입니다. |
| `ACCESS_KEYS` | 선택 | 쉼표로 구분한 임시 손님용 키입니다. 사용자별 관리가 필요하면 초대를 사용하세요. |
| `LOCAL_STORAGE_ROOT` | local 전용 | 로컬 파일 저장 경로입니다. 기본값은 `.devstorage`입니다. |
| `SHAREDESK_SHARE_TEST_EMAIL` | 검사 전용 | 실제 Drive 공유 검사를 받을 별도 Google 계정입니다. 운영 환경에는 넣지 않습니다. |

## 명령어

| 명령 | 용도 |
|---|---|
| `npm run dev` | 개발 서버를 실행합니다. |
| `npm run build` | 운영 빌드가 만들어지는지 확인합니다. |
| `npm start` | 만들어진 운영 빌드를 실행합니다. |
| `npm run lint` | ESLint 검사를 실행합니다. |
| `npm test` | 저장소의 자동 테스트를 실행합니다. |
| `npm run setup -- --prepare-env` | `.env.local`을 안전하게 준비합니다. 기존 내용은 덮어쓰지 않습니다. |
| `npm run setup` | 호스트 Google 인증을 시작합니다. |
| `npm run setup -- --finish` | 브라우저 callback URL을 받아 호스트 Drive 연결을 완료합니다. |
| `npm run setup -- --check` | Client ID와 secret을 읽고 인증 URL을 만들 수 있는지 확인합니다. |
| `npm run test:drive-operations` | 실제 Drive에서 생성·업로드·다운로드·이름 변경·이동·삭제·복원을 검사합니다. |
| `npm run test:drive-preview` | 실제 Drive에서 미리보기 변환·다운로드 경로를 검사합니다. |
| `npm run test:drive-sharing` | 실제 Drive 공유 권한 생성·변경·회수를 검사합니다. |

## 실제 Drive 검사

세 검사는 `.env.local`의 실제 Drive 설정을 사용합니다. 테스트 파일을 만들거나 권한을 바꾸므로 개인 작업용이 아닌 검증 가능한 ShareDesk 루트에서 실행하세요.

먼저 기본 파일 작업 전체를 확인합니다.

```powershell
npm run test:drive-operations
```

미리보기 변환과 범위 다운로드는 별도로 검사합니다.

```powershell
npm run test:drive-preview
```

공유 검사는 `/admin` 초대를 거쳐 승인된 별도 Google 계정이 필요합니다.

```dotenv
SHAREDESK_SHARE_TEST_EMAIL=recipient@example.com
```

```powershell
npm run test:drive-sharing
```

검사는 임시 파일과 자신이 만든 권한을 정리합니다. 그래도 받는 사람 계정의 Google Drive `공유 문서함`에 실제로 표시되는지, 보기 권한에서는 수정이 거부되고 편집 권한에서는 허용되는지도 받는 사람 계정에서 직접 확인해야 합니다.

## 상태 저장과 동시 편집

Drive 모드에서는 `ShareDesk/.sharedesk/`에 다음 상태를 둡니다.

- `users.json`: 사용자, 초대, 승인·차단 상태, 최근 로그인 기기
- `drive-shares.json`: ShareDesk가 만든 Google Drive 공유 권한
- `desktop-layout-*.json`: 폴더별 아이콘 좌표와 버전

일반 파일 목록에서는 `.sharedesk`를 숨기고 그 안을 열지 못하게 막습니다. 상태 변경은 Drive가 발급한 버전과 조건부 쓰기를 사용합니다. 다른 사용자가 먼저 바꾼 경우 늦은 요청은 409 충돌로 끝나며 클라이언트가 최신 목록을 다시 읽습니다.

## 제한 사항

- ShareDesk가 다루는 범위는 setup으로 정한 Drive 루트 폴더 안쪽입니다. 호스트가 Drive 웹에서 항목을 루트 밖으로 옮기면 ShareDesk에서 접근하지 못합니다.
- 같은 폴더에 같은 이름의 항목을 만들거나 이름을 바꾸는 작업은 거부됩니다.
- HTML, SVG처럼 스크립트 실행이 가능한 형식은 브라우저에서 바로 미리 보지 않고 다운로드로 제공합니다.
- Google 문서·시트·슬라이드·드로잉은 PDF 변환 미리보기를 사용합니다. 다른 Google 네이티브 형식은 지원하지 않습니다.
- 무료 Google Drive 용량은 호스트 계정 정책을 따릅니다.
- 접속 키 로그인은 IP당 분당 10회와 서버 전체 분당 60회로 시도를 제한합니다.
- 휴지통의 30일 정리는 Drive API가 삭제 시각을 따로 주지 않아 ShareDesk가 기록한 목록을 기준으로 처리합니다.

## 기여하기

변경 전 `npm test`, `npm run lint`, `npm run build`를 실행해 주세요. 버그를 제보할 때는 재현 순서와 브라우저·Node.js 버전을 적되, `.env.local`, OAuth 콜백 주소, 토큰, Client secret은 절대 첨부하지 마세요.

코드는 [MIT License](./LICENSE)로 배포합니다. 함께 제공되는 Galmuri 글꼴은 [SIL Open Font License 1.1](./public/fonts/Galmuri-LICENSE.txt)을 따릅니다.
