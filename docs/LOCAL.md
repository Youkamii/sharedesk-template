# ShareDesk 로컬 개인 사용

Google OAuth나 Vercel 없이 내 컴퓨터에서 ShareDesk 화면과 파일 기능을 쓰는 방법입니다. 파일은 Google Drive가 아니라 이 컴퓨터의 로컬 폴더에 저장됩니다.

이 방식은 개인 사용과 개발 확인에 맞습니다. 여러 사람이 각자의 Google 계정으로 함께 쓰는 운영 환경을 만들려면 [운영 설치 안내](./INSTALL.md)를 따르세요. 설치가 어렵다면 [AI에게 구축 맡기기](./AI_INSTALL.md)를 사용할 수 있습니다.

이미 받은 로컬 설치본을 새 버전으로 바꾸는 방법은 [업데이트 안내](./UPDATE.md#로컬-개인-사용)에 따로 정리했습니다.

## 준비물

- [Node.js](https://nodejs.org/) 20.9 이상
- Git
- 터미널을 열 수 있는 Windows, macOS 또는 Linux 컴퓨터

버전을 먼저 확인하세요.

```powershell
node --version
npm --version
git --version
```

## 설치

이미 이 저장소를 로컬에서 열었다면 `git clone`과 `cd`는 건너뜁니다.

```powershell
git clone https://github.com/Youkamii/sharedesk-template.git
cd sharedesk-template
npm ci
npm run setup -- --prepare-env
```

마지막 명령은 `.env.local`을 준비합니다. 파일이 이미 있으면 내용을 덮어쓰지 않고 접근 권한만 확인합니다.

## 로컬 환경 설정

프로젝트 루트의 `.env.local`에서 아래 네 값을 채웁니다.

```dotenv
STORAGE_DRIVER=local
LOCAL_STORAGE_ROOT=.devstorage
SESSION_SECRET=로컬에서만-쓸-열여섯자-이상의-긴-무작위-문자열
ACCESS_KEYS=내가-입력할-로컬-접속-키
```

- `STORAGE_DRIVER=local`은 Google Drive 대신 로컬 폴더를 사용합니다.
- `LOCAL_STORAGE_ROOT=.devstorage`는 프로젝트 안의 `.devstorage` 폴더에 파일과 상태를 저장합니다.
- `SESSION_SECRET`은 16자 이상이어야 합니다. 로그인 쿠키 서명에 사용합니다.
- `ACCESS_KEYS`는 첫 화면에서 입력할 접속 키입니다. 여러 개를 쓰려면 쉼표로 나눕니다.

무작위 문자열이 필요하면 로컬 터미널에서 아래 명령을 실행할 수 있습니다. 출력값은 채팅이나 이슈에 올리지 말고 `.env.local`에 직접 넣으세요.

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`.env.local`의 Google 관련 값은 local 모드에서 비워 둬도 됩니다. `.env.local`은 Git에서 제외돼 있으며 공개 저장소에 올리면 안 됩니다.

## 실행

```powershell
npm run dev
```

브라우저에서 `http://localhost:3000`을 열고 `.env.local`에 적은 `ACCESS_KEYS` 값 중 하나를 입력합니다.

local 모드의 접속 키는 `수정 가능` 권한으로 들어가므로 개인 사용에 필요한 파일 만들기와 수정을 그대로 쓸 수 있습니다.

이 모드에서는 Google 로그인, 초대 코드 가입, 실제 Drive 공유를 확인할 수 없습니다.

다음 항목까지 확인하면 로컬 실행이 된 것입니다.

1. `/files` 바탕화면이 열립니다.
2. 폴더를 만들고 파일을 올릴 수 있습니다.
3. 새로고침해도 폴더와 파일이 남습니다.
4. 파일을 휴지통에 버리고 화면 오른쪽 아래 휴지통에서 복원할 수 있습니다.
5. `.txt` 파일과 폴더 메모를 만들고 수정할 수 있습니다.

서버를 끄려면 실행 중인 터미널에서 `Ctrl+C`를 누릅니다.

운영 빌드를 내 컴퓨터에서 확인하려면 다음처럼 실행합니다.

```powershell
npm run build
npm start
```

## 파일 저장과 백업

`LOCAL_STORAGE_ROOT`가 상대 경로이면 ShareDesk를 실행한 프로젝트 폴더를 기준으로 계산합니다. 기본 설정에서는 실제 파일과 상태가 모두 `.devstorage/` 아래에 있습니다.

```text
.devstorage/
├── 내가 만든 파일과 폴더
└── .sharedesk/
    ├── 사용자·초대·접속 상태
    ├── 폴더 메모와 아이콘 배치
    └── 휴지통과 로컬 공유 상태
```

`.sharedesk`는 ShareDesk가 쓰는 내부 폴더라 파일 화면에는 나타나지 않습니다. 일부만 빼서 백업하면 메모, 아이콘 위치, 휴지통 같은 상태가 사라질 수 있으므로 **`LOCAL_STORAGE_ROOT` 전체를 백업**하세요.

백업 순서는 다음과 같습니다.

1. 실행 중인 서버를 `Ctrl+C`로 끕니다.
2. `.devstorage` 또는 직접 정한 `LOCAL_STORAGE_ROOT` 폴더 전체를 다른 드라이브나 백업 폴더에 복사합니다.
3. 같은 접속 키와 로그인 서명을 유지해야 한다면 `.env.local`도 공개되지 않는 별도 위치에 보관합니다.

Windows PowerShell에서는 목적지 경로를 내 환경에 맞게 바꾼 뒤 다음처럼 복사할 수 있습니다.

```powershell
New-Item -ItemType Directory -Force -Path 'D:\ShareDesk-Backup'
Copy-Item -Recurse -Force -LiteralPath '.devstorage' -Destination 'D:\ShareDesk-Backup\devstorage'
```

복원할 때도 서버를 끈 뒤 기존 `LOCAL_STORAGE_ROOT` 대신 백업한 폴더 전체를 놓고 다시 실행합니다. 서버가 파일을 쓰는 중에 복사한 백업은 상태 시점이 서로 어긋날 수 있습니다.

## local 모드에서 다른 점

- Google 로그인과 초대 코드 가입을 사용하지 않습니다. `ACCESS_KEYS`로 들어갑니다.
- 파일은 Google Drive 용량이 아니라 ShareDesk를 실행한 컴퓨터의 디스크를 사용합니다.
- **Google Drive로 공유** 동작은 실제 Google 권한을 만들지 않습니다. local 모드의 상태 확인용 동작일 뿐입니다.
- Google 문서·시트·슬라이드·드로잉의 PDF 변환 미리보기는 사용할 수 없습니다.
- HTML과 SVG처럼 스크립트를 실행할 수 있는 형식은 바로 열지 않고 안전한 다운로드로 제공합니다.
- 같은 폴더에 같은 이름의 항목을 만들거나 이름을 바꾸면 덮어쓰지 않고 거부합니다.
- 휴지통 항목은 30일이 지난 뒤 다음 휴지통 조회 때 완전히 삭제됩니다.
- `LOCAL_STORAGE_ROOT` 바깥 경로와 내부 `.sharedesk` 폴더는 파일 화면에서 열 수 없습니다.
- Vercel 운영 배포에는 local 모드를 쓰지 마세요. 여러 사람이 함께 쓰는 운영 환경은 `STORAGE_DRIVER=drive`로 구성합니다.

## 문제 해결

| 증상 | 확인할 내용 |
|---|---|
| `npm ci`가 Node 버전을 거부함 | `node --version`이 20.9 이상인지 확인하고 Node.js를 올립니다. |
| `SESSION_SECRET이 없거나 너무 짧습니다` | `.env.local`의 `SESSION_SECRET`을 16자 이상의 문자열로 바꾸고 서버를 다시 시작합니다. |
| 접속 키가 거부됨 | `.env.local`의 `ACCESS_KEYS` 철자와 쉼표 구분을 확인하고 서버를 다시 시작합니다. |
| 파일이 예상한 폴더에 없음 | 저장소 루트에서 서버를 실행했는지와 `LOCAL_STORAGE_ROOT` 값을 확인합니다. 상대 경로는 현재 프로젝트 폴더 기준입니다. |
| `.env.local` 변경이 반영되지 않음 | 실행 중인 개발 서버를 끈 뒤 `npm run dev`를 다시 실행합니다. |
| 3000 포트를 사용 중이라는 오류 | 먼저 실행한 ShareDesk 개발 서버나 다른 프로그램을 끈 뒤 다시 실행합니다. |
| `.devstorage`를 지운 뒤 파일이 사라짐 | local 모드의 실제 저장 폴더입니다. 서버를 끄고 전체 백업을 같은 위치에 복원합니다. |
| `STORAGE_DRIVER 값이 올바르지 않습니다` | 값은 소문자 `local` 또는 `drive`만 허용됩니다. 개인 로컬 사용은 `local`로 고칩니다. |

## 개발자 참고

### npm 명령

| 명령 | 용도 |
|---|---|
| `npm run dev` | Next.js 개발 서버를 실행합니다. |
| `npm run build` | 운영 빌드가 만들어지는지 확인합니다. |
| `npm start` | `npm run build`로 만든 운영 빌드를 실행합니다. |
| `npm run lint` | ESLint 검사를 실행합니다. |
| `npm test` | 저장소의 자동 테스트를 실행합니다. |
| `npm run setup -- --prepare-env` | `.env.local`을 준비합니다. 기존 내용은 덮어쓰지 않습니다. |
| `npm run setup` | 호스트 Google 인증을 시작합니다. `.env.local`이 없으면 먼저 준비합니다. |
| `npm run setup -- --finish` | 사용자가 로컬 터미널에 callback URL을 붙여 넣어 호스트 Drive 연결을 완료합니다. URL을 명령 인자로 붙이지 않습니다. |
| `npm run setup -- --check` | Client ID와 secret을 읽고 인증 URL을 만들 수 있는지 확인합니다. |
| `npm run test:drive-operations` | 실제 Drive에서 생성·업로드·다운로드·이름 변경·이동·삭제·복원을 검사합니다. |
| `npm run test:drive-preview` | 실제 Drive에서 Google 문서 PDF 변환과 동영상 Range 응답을 검사합니다. |
| `npm run test:drive-sharing` | 실제 Drive의 보기·편집 권한 생성·변경·회수를 검사합니다. |

TypeScript만 따로 확인하려면 다음 명령을 사용합니다.

```powershell
npx tsc --noEmit --incremental false
```

### 환경 변수

| 변수 | 쓰는 곳 | 설명 |
|---|---|---|
| `ADMIN_EMAILS` | Drive 운영 | 관리자 Google 이메일입니다. 여러 명이면 쉼표로 나눕니다. setup이 호스트 이메일을 넣습니다. |
| `ACCESS_KEYS` | 선택, local 권장 | 쉼표로 나눈 임시 손님용 접속 키입니다. local 개인 사용은 이 키로 `수정 가능` 권한으로 들어가고, 운영(drive)에서 접속 키로 들어온 손님은 `보기 전용`입니다. |
| `SESSION_SECRET` | 필수 | 로그인 쿠키 서명 비밀입니다. 16자 이상이어야 합니다. |
| `STORAGE_DRIVER` | 필수 권장 | `local` 또는 `drive`입니다. 비우면 refresh token 유무로 정하지만 명시해서 쓰는 편이 안전합니다. |
| `LOCAL_STORAGE_ROOT` | local 전용 | 로컬 파일과 상태를 저장할 경로입니다. 기본값은 `.devstorage`입니다. |
| `PUBLIC_BASE_URL` | Drive 운영 조건부 | 사용자 지정 도메인이나 고정 운영 주소의 origin입니다. 경로와 끝 슬래시를 넣지 않습니다. |
| `GOOGLE_CLIENT_ID` | Drive 운영 | Web application 유형의 OAuth Client ID입니다. |
| `GOOGLE_CLIENT_SECRET` | Drive 운영 | OAuth Client secret입니다. |
| `GOOGLE_REFRESH_TOKEN` | Drive 운영 | setup이 받은 호스트 오프라인 토큰입니다. |
| `DRIVE_ROOT_FOLDER_ID` | Drive 운영 | ShareDesk가 관리할 호스트 Drive 루트 ID입니다. |
| `DRIVE_STATE_FOLDER_ID` | Drive 운영 | 루트 안의 `.sharedesk` 상태 폴더 ID입니다. |
| `SHAREDESK_GITHUB_TOKEN` | 선택 | 원클릭 업데이트용 fine-grained PAT입니다. 로컬에서 원클릭 업데이트를 테스트하려면 `SHAREDESK_GITHUB_REPOSITORY`(아래)도 함께 넣어야 합니다. |
| `SHAREDESK_GITHUB_REPOSITORY` | 선택 | 업데이트 대상 설치 저장소(`owner/repository`)입니다. Vercel 밖(로컬)에는 저장소 정보가 없으므로 원클릭 테스트 시 직접 지정합니다. |
| `SHAREDESK_SHARE_TEST_EMAIL` | 실제 검사 전용 | 공유 검사를 받을 별도 승인 Google 계정입니다. 운영 Vercel 환경에는 넣지 않습니다. |
| `SHAREDESK_TRACE` | 개발 확인 | 비어 있지 않으면 일부 Drive 호출과 아이콘 배치 저장 시간을 서버 로그에 남깁니다. |

Vercel 기본 도메인을 쓰면서 `PUBLIC_BASE_URL`을 비우면 앱은 Vercel이 제공하는 `VERCEL_PROJECT_PRODUCTION_URL`을 사용합니다. 직접 넣는 값이 아니라 Vercel의 시스템 환경 변수입니다. 운영에 필요한 값과 callback 주소는 [운영 설치 안내](./INSTALL.md)에 정리돼 있습니다.

### 실제 Drive 검사

아래 세 명령은 local 모드 검사가 아닙니다. `.env.local`의 실제 Google Drive 설정을 사용해 테스트 파일을 만들거나 권한을 바꿉니다. 개인 작업 파일과 분리해 검증할 수 있는 ShareDesk 루트에서 실행하세요.

기본 파일 작업을 검사합니다.

```powershell
npm run test:drive-operations
```

이 검사는 폴더 생성, 서버 업로드, 전체 다운로드, 이름 변경, 폴더 간 이동, 브라우저 직행 업로드, 휴지통 삭제·복원·완전 삭제를 확인하고 자신이 만든 항목을 정리합니다. 정리에 실패하면 Drive의 `sharedesk-operations-test-*` 폴더를 직접 확인합니다.

미리보기를 검사합니다.

```powershell
npm run test:drive-preview
```

이 검사는 Google 문서·시트·슬라이드·드로잉이 PDF로 내려오는지와 동영상 일부 요청이 HTTP 206으로 동작하는지 확인한 뒤 검사용 Drive 항목을 정리합니다.

공유 권한을 검사하려면 먼저 별도 Google 계정을 ShareDesk 초대로 승인하고 `.env.local`에 그 이메일을 넣습니다.

```dotenv
SHAREDESK_SHARE_TEST_EMAIL=recipient@example.com
```

```powershell
npm run test:drive-sharing
```

공유 검사는 보기 권한 생성, 편집 권한 변경, 권한 회수, ShareDesk 공유 장부 반영을 확인하고 검사용 파일과 권한을 정리합니다.

자동 검사가 통과해도 받는 사람 계정의 Google Drive `공유 문서함(Shared with me)`에 항목이 실제로 보이는지, 보기 권한에서는 수정이 거부되고 편집 권한에서는 허용되는지는 별도 계정으로 직접 확인해야 합니다.

### 상태 저장과 동시 변경

Drive 모드는 `ShareDesk/.sharedesk/`, local 모드는 `LOCAL_STORAGE_ROOT/.sharedesk/`에 사용자·초대, 접속 상태, Drive 공유 장부, 폴더 메모, 아이콘 배치와 휴지통 상태를 저장합니다. 일반 파일 목록에서는 이 폴더를 숨기고 직접 열지 못하게 막습니다.

상태 파일과 폴더 이동처럼 마지막으로 본 버전이 중요한 변경은 동시에 먼저 저장한 결과를 유지합니다. 늦은 요청은 충돌로 끝내고 최신 상태를 다시 읽습니다.

### 현재 제한

- ShareDesk가 다루는 범위는 설정한 Drive 또는 local 루트 안쪽입니다.
- 같은 폴더의 같은 이름은 허용하지 않습니다.
- HTML과 SVG는 바로 미리 보지 않고 다운로드합니다.
- Google 문서·시트·슬라이드·드로잉만 PDF 변환 미리보기를 지원합니다.
- Drive 용량과 Drive 휴지통 보관 기간은 호스트 Google 계정 정책을 따릅니다.
- local 휴지통은 30일이 지난 항목을 다음 휴지통 조회 때 완전히 삭제합니다.

변경 전에는 `npm test`, `npm run lint`, `npx tsc --noEmit --incremental false`, `npm run build`를 실행하세요. 버그를 제보할 때는 재현 순서와 브라우저·Node.js 버전을 적되 `.env.local`, OAuth callback URL, 토큰, Client secret은 첨부하지 마세요.
