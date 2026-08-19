[English](./INSTALL.md) · **한국어** · [日本語](./INSTALL.ja.md) · [हिन्दी](./INSTALL.hi.md) · [中文](./INSTALL.zh.md)

# ShareDesk 운영 설치 안내

호스트 한 사람의 Google Drive 저장 공간을 여러 사람이 각자의 Google 계정으로 함께 쓰도록 ShareDesk를 열어 주는 문서입니다.

Google Cloud나 Vercel 설정이 낯설다면 직접 전부 따라 하지 않아도 됩니다. [AI에게 구축 맡기기](./AI_INSTALL.ko.md)의 요청문을 코딩 AI에게 보내면, AI가 끝난 단계를 먼저 확인하고 사용자가 직접 해야 할 화면에서만 한 단계씩 안내합니다.

## 먼저, 내 역할은 무엇인가요?

### 참여자

누군가가 만든 ShareDesk에 초대받았다면 **이 문서를 따라 설치하지 마세요.** 호스트가 보낸 ShareDesk 주소에서 내 Google 계정으로 로그인하고 초대 코드를 입력하면 됩니다. GitHub 계정, Vercel 프로젝트, Google OAuth 클라이언트는 필요 없습니다.

### 호스트

내 Google Drive 용량을 내어 새 ShareDesk 주소를 만들고 사람들을 초대하려면 아래를 따르세요. 설치는 호스트만 한 번 하고, 참여자들은 그 주소와 저장 공간을 함께 씁니다.

설치 하나마다 호스트의 Git 저장소, Vercel 프로젝트, Google OAuth 클라이언트, Drive 루트가 따로 연결됩니다. 이 분리 구조는 호스트의 설치 소유권에 대한 설명이며, ShareDesk의 첫 사용 가치는 한 Drive 저장 공간을 여러 사람이 함께 쓰는 것입니다. 이미 만들어 둔 설정이 있다면 새로 만들지 말고 그대로 이어서 사용하세요.

## 호스트용 빠른 길

1. **ShareDesk 주소 만들기:** [Deploy with Vercel](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYoukamii%2Fsharedesk-template&project-name=my-sharedesk&repository-name=my-sharedesk)로 내 GitHub 저장소와 Vercel 프로젝트를 만들고 Production 주소를 기록합니다.
2. **Google 연결 만들기:** Google Cloud에서 Drive API를 켜고 Web application OAuth 클라이언트를 만듭니다. 정확한 범위와 callback 주소는 [2단계](#2-google-cloud-설정)에서 복사하세요.
3. **호스트 Drive 연결하기:** 저장소를 받고 `npm ci`, `npm run setup`을 실행합니다. `.env.local`이 없으면 setup이 자동으로 만듭니다. Client ID와 secret을 넣고 다시 실행하면 인증 페이지가 브라우저에 자동으로 열립니다. 동의 뒤 `npm run setup:finish`로 마무리합니다.
4. **운영에 연결하기:** setup이 채운 필수 값을 Vercel Production 환경 변수로 옮기고 재배포합니다.
5. **한 사람과 함께 확인하기:** 운영 로그인과 파일 저장을 먼저 확인한 뒤 `/admin`에서 초대 코드를 만듭니다. 한 사람을 초대해 두 계정에서 같은 파일이 보이는지 확인하면 핵심 설치가 끝납니다. Vercel Firewall은 그 뒤 운영 보호 단계에서 설정합니다.

ShareDesk는 새 버전을 자동으로 적용하지 않습니다. 설치 뒤 작업표시줄의 `업데이트` 버튼(관리자에게만 보입니다)은 새 버전이 있을 때만 별을 표시합니다. 기존 설치본을 처음 연결하는 방법은 [업데이트 안내](./UPDATE.ko.md)에 있습니다.

아래는 각 단계의 상세 설명입니다. Google Cloud 화면이나 오류가 나온 부분만 찾아보셔도 됩니다.

## 설치 완료 기준

다음 항목을 모두 확인해야 운영 설치가 끝난 것입니다.

- 내 Git 저장소와 내 Vercel 프로젝트가 연결돼 있습니다.
- 바뀌지 않는 Production 주소가 있습니다.
- Google OAuth 클라이언트에 운영 callback이 정확히 등록돼 있습니다.
- Vercel Production 환경에 운영 필수 값이 들어 있습니다.
- 운영 주소에서 호스트 Google 로그인이 됩니다.
- `/files`에서 만든 폴더가 새로고침 뒤에도 남습니다.
- 화면 오른쪽 아래에 작업표시줄과 따로 놓인 휴지통 아이콘이 보이고, 아이콘을 눌러 삭제한 항목을 복원할 수 있습니다.
- `/admin`이 열리고 초대 코드의 유효 기간과 사용 방식을 고를 수 있습니다.
- 초대 코드로 한 사람이 자기 Google 계정으로 참여했습니다.
- 호스트와 참여자 두 계정에서 같은 파일을 보고 다운로드할 수 있습니다.

## 준비물

- [Node.js](https://nodejs.org/) 20.9 이상
- Git
- GitHub 계정
- Vercel 계정
- Google 계정과 Google Cloud 프로젝트를 만들 권한

### 어떤 계정이 연결돼 있는지 확인

컴퓨터에 이미 다른 GitHub·Vercel 계정이 로그인돼 있으면 엉뚱한 계정에 저장소와 프로젝트가 만들어집니다. 시작 전에 확인하세요.

```powershell
gh auth status
vercel whoami
git config --global user.email
```

다른 계정이 나오면 이 순서로 다시 로그인합니다.

1. `gh auth logout` 뒤 `gh auth login`으로 사용할 GitHub 계정에 로그인합니다.
2. `vercel logout` 뒤 `vercel login`으로 사용할 Vercel 계정에 로그인합니다.
3. `git config --global user.email "사용할-이메일"`로 커밋 이메일을 맞춥니다.

## 1. 저장소와 고정 운영 주소 준비

현재 저장소의 `origin`이 내 저장소이고 이미 Vercel 프로젝트에 연결돼 있다면 이 단계를 반복하지 마세요. `git remote -v`와 Vercel 프로젝트 설정을 확인한 뒤 기존 프로젝트를 사용합니다.

아직 저장소와 Vercel 프로젝트가 없다면 아래 버튼으로 둘을 함께 만드세요.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FYoukamii%2Fsharedesk-template&project-name=my-sharedesk&repository-name=my-sharedesk)

Vercel 없이 저장소만 먼저 만들려면 [Use this template](https://github.com/Youkamii/sharedesk-template/generate)을 사용합니다.

### 신규 계정에서 Create 버튼이 눌리지 않을 때

Vercel을 처음 쓰는 계정은 `Git Scope`가 비어 있어 `Create` 버튼이 비활성 상태입니다. `Select Git Scope` 드롭다운 → `Add GitHub Account`를 눌러 GitHub 앱을 설치(`All repositories` 선택)하면 `Create`가 활성화됩니다. 이 과정에서 GitHub 창이 팝업으로 뜨므로 브라우저의 팝업 차단도 확인하세요.

첫 배포는 환경 변수가 비어 있어도 됩니다. 로그인 버튼 대신 설치 안내가 나오는 것이 정상입니다. 이 단계에서 다음 두 주소를 기록하세요.

- 내 Git 저장소: 예) `https://github.com/my-account/my-sharedesk`
- 고정 Production 주소: 예) `https://my-sharedesk.vercel.app`

커밋마다 바뀌는 Preview 주소나 긴 배포 주소가 아니라 프로젝트에 계속 붙어 있는 Production 주소를 사용합니다.

프로젝트 이름을 다른 사람이 먼저 쓰고 있으면 주소에 `-theta` 같은 접미사가 붙을 수 있습니다. 내 고정 주소는 Vercel 프로젝트의 `Domains` 탭에서 `.vercel.app`으로 끝나는 주소로 확인하세요. 중간에 해시가 붙은 긴 배포 주소는 사용하지 않습니다.

## 2. Google Cloud 설정

### 2-1. 프로젝트와 Drive API

1. [Google Cloud Console](https://console.cloud.google.com/)을 엽니다.
2. 사용할 프로젝트를 선택하거나 새 프로젝트를 만듭니다.
3. `API 및 서비스` → `라이브러리`에서 `Google Drive API`를 사용 설정합니다.

OAuth 클라이언트와 Drive API는 같은 Cloud 프로젝트에 두세요.

### 2-2. Branding

`Google Auth Platform` → `Branding`에서 다음 값을 입력합니다.

- 앱 이름: 예) `우리 팀 ShareDesk`
- 사용자 지원 이메일
- 개발자 연락처 이메일

Google Cloud 화면 언어에 따라 `브랜딩`, `대상`, `데이터 액세스`, `클라이언트`처럼 번역돼 보일 수 있습니다.

### 2-3. Audience

`Google Auth Platform` → `Audience`에서 사용 대상을 정합니다.

- 개인 Google 계정이나 조직 밖 사람도 초대하려면 `External`
- 한 Google Workspace 조직 안에서만 쓴다면 조직 정책에 따라 `Internal`

운영용 External 앱은 setup 전에 `Publish app`을 눌러 `In production`으로 전환하세요. 이미 `In production`이면 그대로 둡니다.

`Testing`에서도 설치할 수는 있지만 ShareDesk의 호스트 연결은 `drive.file`과 오프라인 접근을 함께 요청합니다. 이 상태에서 받은 refresh token은 보통 7일 뒤 만료됩니다. 이미 Testing 상태에서 setup했다면 먼저 In production으로 바꾼 뒤 호스트 연결을 다시 진행하세요. 이미 In production인 앱의 정상 토큰은 근거 없이 폐기하지 마세요.

`In production`은 테스트용 토큰 만료 정책과 구분되는 게시 상태입니다. 앱 검증 완료와 같은 뜻은 아니며 Branding과 사용자 수에 따라 Google 경고나 추가 검증 절차가 남을 수 있습니다.

자세한 상태 설명은 [Google OAuth Audience 안내](https://support.google.com/cloud/answer/15549945?hl=ko)를 참고하세요.

### 2-4. Data Access

`Google Auth Platform` → `Data Access` → `Add or remove scopes`에서 아래 네 범위를 추가합니다.

```text
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/drive.file
```

### 2-5. Web application OAuth 클라이언트

`Google Auth Platform` → `Clients`에서 기존 Web application 클라이언트를 먼저 확인합니다. 쓸 수 있는 기존 클라이언트가 있다면 새로 만들지 말고 빠진 주소만 추가합니다.

새로 만든다면 다음과 같이 설정합니다.

1. Application type: `Web application`
2. 이름: 예) `ShareDesk web`
3. `Authorized JavaScript origins`: 비워 둠
4. `Authorized redirect URIs`: 아래 세 주소를 등록

```text
http://127.0.0.1:53682/callback
http://localhost:3000/api/auth/google/callback
https://my-sharedesk.vercel.app/api/auth/google/callback
```

마지막 주소의 도메인은 1단계에서 얻은 실제 Production 도메인으로 바꾸세요.

운영 callback을 `Authorized JavaScript origins`에 넣으면 안 됩니다. JavaScript origin에는 경로를 넣을 수 없고 ShareDesk는 그 칸을 사용하지 않습니다. 세 주소는 모두 `Authorized redirect URIs`에 넣습니다.

리디렉션 주소는 `http`/`https`, 호스트, 포트, 경로, 끝 슬래시까지 정확히 일치해야 합니다. Google의 [OAuth 웹 서버 안내](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation)에서도 정확한 일치를 요구합니다.

클라이언트를 만들면 Client ID와 Client secret을 안전하게 기록해 두세요. 다음 단계에서 필요합니다. 공개 저장소, 채팅, 이슈, 스크린샷에는 붙이지 마세요.

## 3. 로컬 환경 파일 준비

현재 저장소가 이미 로컬에 열려 있다면 다시 clone하지 말고 그 폴더에서 시작합니다.

아직 받지 않았다면 1단계에서 만든 내 저장소를 clone합니다.

```powershell
git clone https://github.com/<내-GitHub-계정>/my-sharedesk.git
cd my-sharedesk
```

의존성을 설치하고 setup을 한 번 실행합니다.

```powershell
npm ci
npm run setup
```

`.env.local`이 없으면 bare `npm run setup`이 소유자 전용 권한으로 파일을 자동 생성하고 `.env.example` 내용을 넣습니다. Client ID와 secret이 비어 있다는 안내가 나오면 정상입니다. 기존 `.env.local`이 있으면 내용을 덮어쓰지 않고 권한만 확인합니다.

환경 파일만 미리 준비하고 setup을 시작하지 않으려면 기존 호환 명령인 `npm run setup -- --prepare-env`를 사용해도 됩니다.

`.env.local`에 다음 두 값을 직접 입력합니다.

```dotenv
GOOGLE_CLIENT_ID=발급받은-client-id
GOOGLE_CLIENT_SECRET=발급받은-client-secret
```

값을 코딩 에이전트의 채팅이나 명령줄 인자로 넘기지 마세요.

## 4. 호스트 Drive 연결

기존 `.env.local`에 유효한 `GOOGLE_REFRESH_TOKEN`, `DRIVE_ROOT_FOLDER_ID`, `DRIVE_STATE_FOLDER_ID`가 모두 있고 실제로 작동한다면 setup을 다시 실행할 필요가 없습니다. 신규 설치이거나 연결을 다시 발급해야 할 때만 아래 순서를 진행합니다.

### 4-1. 인증 시작

```powershell
npm run setup
```

1. setup이 Google 인증 페이지를 기본 브라우저에서 엽니다. 자동으로 열리지 않으면 터미널에 그대로 출력된 URL을 직접 여세요.
2. ShareDesk의 호스트가 될 Google 계정으로 로그인하고 동의합니다.
3. 브라우저가 `http://127.0.0.1:53682/callback?...`으로 이동합니다.
4. 브라우저에 연결 실패가 떠도 정상입니다. 주소창의 전체 주소를 복사합니다.

callback URL에는 짧은 시간 동안 유효한 일회용 인증 코드가 들어 있습니다. 같은 컴퓨터의 터미널에만 붙여 넣고 채팅, 이슈, 스크린샷으로 공유하지 마세요.

### 4-2. 인증 완료

```powershell
npm run setup:finish
```

질문이 나오면 방금 복사한 callback URL 전체를 붙여 넣습니다. URL을 명령 인자로 적지 않으므로 셸 기록에 인증 코드가 남지 않습니다.

코딩 에이전트와 함께 진행 중이라면 이 입력은 사용자가 직접 합니다. 에이전트는 callback URL을 채팅으로 요청하거나 터미널 출력으로 다시 읽지 말고 입력이 끝날 때까지 기다립니다.

setup이 끝나면 `.env.local`에 다음 값이 준비됩니다.

- `ADMIN_EMAILS`
- `SESSION_SECRET`
- `STORAGE_DRIVER=drive`
- `GOOGLE_REFRESH_TOKEN`
- `DRIVE_ROOT_FOLDER_ID`
- `DRIVE_STATE_FOLDER_ID`

또한 호스트 Drive에 `ShareDesk` 루트와 `.sharedesk` 상태 폴더를 만듭니다. 기존 상태 파일은 임의로 덮어쓰지 않습니다.

## 5. 로컬 확인

```powershell
npm run dev
```

1. `http://localhost:3000`을 엽니다.
2. 호스트 Google 계정으로 로그인합니다.
3. `/files`에서 폴더를 하나 만들고 새로고침 뒤에도 남는지 확인합니다.
4. `/admin`이 열리는지 확인합니다.

여기까지는 로컬 확인입니다. 다른 사람이 쓸 수 있는 운영 배포가 끝난 것은 아닙니다.

## 6. Vercel Production 환경 변수와 재배포

1단계에서 만든 기존 Vercel 프로젝트를 엽니다. `Settings` → `Environment Variables`에서 아래 값을 Production 환경에 넣습니다. 최근 화면에서는 `Settings` → `Environments` → `Production`을 눌러 들어간 상세 화면 안에 환경 변수 입력란이 있습니다.

| 이름 | 값 |
|---|---|
| `ADMIN_EMAILS` | 관리자 Google 이메일. 여러 명이면 쉼표로 구분 |
| `SESSION_SECRET` | setup이 만든 긴 무작위 값 |
| `STORAGE_DRIVER` | `drive` |
| `GOOGLE_CLIENT_ID` | Web application Client ID |
| `GOOGLE_CLIENT_SECRET` | Client secret |
| `GOOGLE_REFRESH_TOKEN` | setup이 받은 호스트 refresh token |
| `DRIVE_ROOT_FOLDER_ID` | setup이 만든 ShareDesk 폴더 ID |
| `DRIVE_STATE_FOLDER_ID` | setup이 만든 상태 폴더 ID |
| `PUBLIC_BASE_URL` | 고정 Production origin. 예: `https://my-sharedesk.vercel.app` |
| `SHAREDESK_DEFAULT_LOCALE` | (선택) 데스크 기본 언어(en/ko/ja/hi/zh). 설치 때 setup에서 고른 값 — `.env.local`의 값을 그대로 복사 |
| `SHAREDESK_GITHUB_TOKEN` | (선택) 원클릭 업데이트용 fine-grained PAT — [업데이트 안내](./UPDATE.ko.md) 참고 |

설치 실수를 줄이려면 Vercel Production에 `PUBLIC_BASE_URL=https://실제-운영-도메인`을 명시하세요. 이 값은 로컬 `.env.local`에는 넣지 않습니다. 로컬 앱 로그인은 `http://localhost:3000`으로 돌아와야 하기 때문입니다.

`PUBLIC_BASE_URL`을 생략한 경우 ShareDesk는 `VERCEL_PROJECT_PRODUCTION_URL`을 대신 사용합니다. 이 방식을 쓴다면 Vercel 프로젝트에서 시스템 환경 변수 노출이 켜져 있는지 확인하세요.

`PUBLIC_BASE_URL`에는 origin만 넣습니다. 경로, 끝 슬래시, callback 경로, Preview URL을 붙이지 않습니다.

`ACCESS_KEYS`는 임시 손님용 키를 쓸 때만 넣습니다. drive 모드에서 접속 키로 들어온 손님은 `보기 전용`입니다. `LOCAL_STORAGE_ROOT`와 `SHAREDESK_SHARE_TEST_EMAIL`은 운영 환경에 넣지 않습니다. 어떤 비밀값에도 `NEXT_PUBLIC_` 접두사를 붙이지 마세요.

여러 값을 한 번에 붙여 넣을 때는 Key 칸이 첫 줄(`ADMIN_EMAILS`)을 통째로 먹는 함정이 있습니다. 붙여 넣은 뒤 변수 개수가 9개(선택 항목 제외)인지 반드시 확인하세요. 값은 기본 `Sensitive`로 저장돼 저장 후 다시 볼 수 없는데, 이것은 정상입니다.

환경 변수를 입력하거나 바꾼 뒤 Production을 다시 배포합니다. 환경 변수 변경은 기존 배포에 자동으로 반영되지 않습니다. `Deployments` 탭에서 최신 배포 행에 마우스를 올리면 나오는 `⋯` 메뉴 → `Redeploy`를 누르세요. `Create Deployment` 버튼은 Preview 배포 전용이니 쓰지 마세요. 자세한 동작은 [Vercel 환경 변수 안내](https://vercel.com/docs/environment-variables)를 참고하세요.

## 7. 운영 확인

고정 Production 주소에서 직접 확인합니다.

1. 호스트 Google 계정으로 로그인합니다.
2. `/files`에서 테스트 폴더를 만들고 새로고침 뒤에도 남는지 확인합니다.
3. 테스트 폴더를 삭제한 뒤 화면 오른쪽 아래의 휴지통 아이콘을 눌러 휴지통 창을 열고, 폴더를 복원합니다. 아이콘이 작업표시줄 밖에 있으며 열린 창과 겹칠 때 창 뒤로 가려지는지도 확인합니다.
4. `/admin`이 열리는지 확인합니다.
5. 초대 코드 생성 화면에서 유효 기간 `1시간`, `24시간`, `7일`, `30일`과 사용 방식 `1회용`, `기간 내 무제한`을 고를 수 있는지 확인합니다. 가입자가 시작할 역할도 `수정 가능`(기본), `올리기 가능`, `보기 전용` 중에서 고를 수 있는지 확인합니다.
6. 로그아웃하고 다시 로그인해 운영 callback이 정상인지 확인합니다.
7. `/admin`에서 초대 코드를 하나 만들고, 함께 쓸 한 사람에게 운영 주소와 코드를 보냅니다.
8. 참여자가 자기 Google 계정으로 로그인한 뒤 초대 코드를 입력합니다. 참여자에게는 OAuth 클라이언트나 Vercel 프로젝트가 필요 없습니다.
9. 호스트가 테스트 파일을 하나 올리고, 호스트와 참여자 두 계정에서 같은 파일을 보고 다운로드할 수 있는지 확인합니다.

Drive 모드에서 휴지통으로 보낸 항목은 직접 완전히 삭제하지 않는 한 [Google Drive의 30일 휴지통 정책](https://support.google.com/drive/answer/14933051?hl=ko)에 따라 30일이 지나면 영구 삭제됩니다. OAuth 없는 `local` 모드에서는 30일이 지난 항목을 다음 휴지통 조회 때 ShareDesk가 영구 삭제합니다.

초대받은 사람은 새 ShareDesk를 설치하는 것이 아니라, 호스트가 이미 만든 공유 파일 공간에 참여하는 것입니다.

## 8. 작동 확인 뒤 운영 보호

위 7단계에서 로그인, 파일 저장, 실제 한 사람 초대까지 확인한 뒤 초대 코드 제출 요청을 보호합니다. Firewall 설정은 ShareDesk를 작동시키는 설치 단계가 아니라 운영 보호 단계입니다.

Vercel 프로젝트의 Firewall에서 아래 Rate Limit 규칙을 만들고 `Publish`합니다.

기존 Rate Limit 규칙이 있다면 먼저 조건과 용도를 확인하세요. 다른 규칙을 덮어쓰지 말고 새 규칙을 추가할 수 있는지 확인합니다.

- 조건: `Request Path` equals `/api/invitations/code`
- 조건: `Method` equals `POST`
- 조건: Cookie `sharedesk_session` exists
- 동작: `Rate Limit`
- 방식: `Fixed Window`
- 기준: `IP`
- 제한: `60초`에 `10회`, 초과 시 `429`

세 조건을 모두 넣어야 초대 코드 제출에만 제한이 걸립니다. 규칙을 만들 때 Vercel이 보여 주는 사용량과 요금 안내도 확인하세요. 설정 화면은 [Vercel WAF Rate Limiting 안내](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting)를 참고할 수 있습니다.

## 사람 초대와 관리

1. 호스트가 운영 주소의 `/admin`을 엽니다.
2. 초대 코드의 유효 기간을 `1시간`, `24시간`, `7일`, `30일` 중에서 고릅니다.
3. 사용 방식을 `1회용` 또는 `기간 내 무제한`으로 고릅니다.
4. 가입자가 시작할 역할을 `수정 가능`(기본), `올리기 가능`, `보기 전용` 중에서 고릅니다.
5. 만든 코드와 운영 주소를 참여자에게 전달합니다.
6. 참여자는 자기 Google 계정으로 로그인한 뒤 코드를 입력합니다. 가입한 사람은 코드에 고른 역할로 시작합니다.

초대 코드는 특정 이메일에 미리 묶이지 않습니다. 이름과 이메일은 실제로 코드를 입력한 사람의 Google 로그인에서 가져옵니다.

- **1회용:** 한 사람이 가입에 성공하면 바로 소진됩니다.
- **기간 내 무제한:** 만료되거나 호스트가 비활성화할 때까지 여러 사람이 함께 쓸 수 있습니다.

### 역할 4단계

| 역할 | 할 수 있는 일 |
|---|---|
| 관리자 | 모든 파일 작업과 사용자 관리. `ADMIN_EMAILS`에 적힌 계정은 저장된 역할과 무관하게 항상 관리자입니다. |
| 수정 가능 | 업로드·다운로드·삭제·이동·이름 변경, 메모장과 폴더 메모 편집, 휴지통 조작, 새 메모장 만들기 |
| 올리기 가능 | 업로드·다운로드·새 폴더 만들기·아이콘 배치 이동 |
| 보기 전용 | 열람과 다운로드만 |

역할은 가입할 때 한 번 정해지고 끝나는 값이 아닙니다. `/admin` 사용자 표의 역할 열에서 언제든 바꿀 수 있습니다.

관리 화면에서는 사용자를 차단하거나 가입 대기로 돌릴 수 있고, 특정 기기의 로그인 또는 그 사용자의 모든 로그인을 끊을 수 있습니다. `ADMIN_EMAILS`를 바꿨다면 Vercel 환경 변수를 고친 뒤 다시 배포해야 합니다.

## 설치 뒤 업데이트

ShareDesk는 새 버전을 자동으로 적용하지 않습니다. 새 버전이 확인되면 관리자 작업표시줄의 `업데이트`에 별을 표시합니다. 버튼을 누르면 ShareDesk 안에서 현재·최신 버전을 먼저 보여 줍니다. Vercel에 `SHAREDESK_GITHUB_TOKEN`을 넣어 둔 설치는 관리자가 `업데이트 하기`를 누르면 앱 안에서 바로 업데이트를 시작하고 진행 상황을 보여 줍니다. 토큰이 없는 설치는 기존처럼 GitHub Actions 화면이 열리며 `Run workflow`를 눌러 시작합니다. 어느 쪽이든 검사를 통과한 경우에만 `main`에 커밋하고, 연결된 Vercel이 다시 배포합니다.

Drive 파일과 공유 상태, `.env.local`, Vercel 환경 변수는 코드 업데이트에 포함되지 않습니다. 업데이트 기능이 들어오기 전에 만든 설치본의 1회 전환과 충돌 해결은 [ShareDesk 업데이트](./UPDATE.ko.md)를 따르세요.

## Google Drive로 직접 공유하기

관리자가 파일이나 폴더를 우클릭해 **Google Drive로 공유**를 누르면 승인된 사용자에게 보기 또는 편집 권한을 줄 수 있습니다. 이 기능은 ShareDesk 안에서 항목을 숨기거나 공개하는 기능이 아니라, 받는 사람의 Google Drive `공유 문서함`에도 나타나는 실제 Drive 권한입니다.

폴더 권한은 Google Drive 규칙에 따라 하위 항목에 이어집니다. 받는 사람의 `공유 문서함` 표시와 보기·편집 권한 차이는 별도 Google 계정으로 직접 확인하세요. 자동 검사 방법은 [로컬 사용 문서의 실제 Drive 검사](./LOCAL.ko.md#실제-drive-검사)를 참고합니다.

## 문제 해결

| 증상 | 확인할 내용 |
|---|---|
| `redirect_uri_mismatch` | 오류에 나온 `redirect_uri`를 Google Auth Platform의 같은 Client ID에 있는 `Authorized redirect URIs`와 글자 단위로 비교합니다. JavaScript origins가 아닙니다. |
| `앱에 액세스할 수 없음` | Audience가 External인지 확인합니다. Testing을 유지한다면 로그인 계정을 Test user에 넣어야 합니다. |
| `org_internal` | Internal 앱에 조직 밖 계정으로 로그인한 경우입니다. External로 바꾸거나 조직 계정을 사용합니다. |
| 동의 뒤 `127.0.0.1` 연결 실패 | setup에서는 정상입니다. 주소창 전체를 복사해 `npm run setup:finish`의 질문에 붙여 넣습니다. |
| `refresh_token을 받지 못했습니다` | 기존 연결과 Audience 상태를 먼저 확인합니다. 새 토큰이 실제로 필요하고 기존 연결 때문에 발급되지 않는 경우에만 [Google 계정의 연결된 앱](https://myaccount.google.com/permissions)에서 권한을 제거하고 setup을 다시 진행합니다. |
| 약 7일 뒤 Drive 연결이 끊김 | Audience가 Testing이었는지 먼저 확인합니다. Testing에서 받은 호스트 토큰이면 In production 전환 뒤 setup을 다시 진행합니다. 이미 In production이면 토큰을 먼저 폐기하지 말고 실제 인증 오류를 확인합니다. |
| Drive API가 403을 반환 | OAuth 클라이언트를 만든 것과 같은 Cloud 프로젝트에서 Google Drive API가 켜져 있는지 확인합니다. Workspace 관리 정책이 외부 앱을 막는지도 확인합니다. |
| Vercel에서만 로그인 실패 | Production 환경 변수, 고정 운영 origin, Google의 운영 redirect URI, 환경 변수 변경 뒤 재배포 여부를 확인합니다. |
| 초대 코드가 거부됨 | `/admin`에서 코드의 만료일·활성 상태·사용 방식을 확인합니다. 1회용은 다른 사람의 첫 가입 성공 뒤 이미 소진됐을 수 있습니다. |
| 특정 Workspace 계정만 실패 | 조직 관리자의 서드파티 앱 접근 제한이나 Google Advanced Protection 정책을 확인합니다. |
| 관리자 로그인이 초대를 요구 | 로그인 이메일이 `ADMIN_EMAILS`와 정확히 같은지 확인하고 값을 바꿨다면 재배포합니다. |
| setup이 같은 이름의 상태 파일이 여러 개라고 중단 | Drive의 `ShareDesk/.sharedesk/`에서 해당 JSON 파일을 확인하고, 내용을 비교해 보존할 하나만 남긴 뒤 다시 실행합니다. |

### setup을 다시 실행해도 되나요?

기존 `DRIVE_ROOT_FOLDER_ID`와 상태 폴더 ID가 `.env.local`에 있으면 setup은 그 폴더와 기존 상태 파일을 이어서 사용합니다. 같은 이름의 핵심 상태 파일이 여러 개면 임의로 고르지 않고 중단하므로 Drive에서 내용을 확인한 뒤 하나만 남겨야 합니다.

Client secret을 교체했거나 refresh token을 다시 받아야 한다면 `.env.local`의 Client ID와 secret을 먼저 갱신하고 setup을 다시 시작하세요. 이미 정상 작동하는 연결은 추측으로 폐기하지 마세요.

## 저장 구조와 제한

- ShareDesk가 다루는 범위는 setup으로 정한 Drive 루트 폴더 안쪽입니다. 호스트가 Drive 웹에서 항목을 루트 밖으로 옮기면 ShareDesk에서 접근하지 못합니다.
- 같은 폴더에 같은 이름의 항목을 만들거나 이름을 바꾸는 작업은 거부됩니다.
- HTML, SVG처럼 스크립트를 실행할 수 있는 형식은 브라우저에서 바로 보지 않고 다운로드합니다.
- Google 문서·시트·슬라이드·드로잉은 PDF로 바꿔 미리 봅니다.
- 무료 Google Drive 용량과 휴지통 보관 기간은 호스트 계정의 Google 정책을 따릅니다.

Drive 모드에서는 `ShareDesk/.sharedesk/`에 사용자·초대, 현재 접속 인원, Drive 공유 권한, 폴더 메모와 아이콘 배치를 저장합니다. 일반 파일 목록에서는 이 폴더를 숨깁니다. 동시에 같은 상태를 바꾸면 먼저 저장한 결과를 유지하고 늦은 요청은 충돌로 끝내 최신 상태를 다시 읽게 합니다.

코딩 AI와 함께 설치하려면 [AI 설치 안내](./AI_INSTALL.ko.md)를 사용하세요. 개발·검사 명령과 전체 환경 변수 표는 [로컬 개인 사용](./LOCAL.ko.md#개발자-참고)에 따로 정리했습니다.
