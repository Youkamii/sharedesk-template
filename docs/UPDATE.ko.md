[English](./UPDATE.md) · **한국어** · [日本語](./UPDATE.ja.md) · [हिन्दी](./UPDATE.hi.md) · [中文](./UPDATE.zh.md)

# ShareDesk 업데이트

ShareDesk는 설치할 때 만들어진 **내 GitHub 저장소**를 업데이트하고, 그 저장소와 연결된 Vercel이 다시 배포하는 방식으로 새 버전을 적용합니다. Google Drive의 파일·사용자·초대·메모와 Vercel 환경 변수는 코드 업데이트 대상이 아닙니다.

## 업데이트 버튼 사용

ShareDesk는 새 버전을 자동으로 적용하지 않습니다. 관리자로 로그인하면 최신 안정 버전을 한 번 확인하고, 새 버전이 있을 때만 작업표시줄의 `업데이트`에 별을 표시합니다.

아래의 [원클릭 업데이트 준비](#원클릭-업데이트-준비한-번만)를 한 번 마친 설치는 GitHub 화면으로 이동하지 않고 ShareDesk 안에서 업데이트가 끝납니다.

1. 별이 표시된 `업데이트`를 눌러 ShareDesk 안에서 현재 버전과 최신 안정 버전을 확인합니다. 별이 없어도 버튼을 눌러 직접 확인할 수 있습니다.
2. 새 버전이 있으면 내부 화면의 `업데이트 하기`를 누릅니다.
3. ShareDesk가 설치 저장소의 업데이트 workflow를 대신 실행하고, 같은 창에 진행 상황을 보여 줍니다. `업데이트를 적용하고 있습니다` → `새 버전을 배포하고 있습니다`를 거쳐 끝나면 `업데이트가 끝났습니다`, 문제가 있으면 `업데이트에 실패했습니다`가 표시됩니다. 몇 분 걸릴 수 있습니다.
4. 검사가 모두 통과하면 설치 저장소의 `main`에 업데이트 커밋이 생기고, 저장소와 연결된 Vercel이 새 커밋을 Production에 배포합니다.
5. `업데이트가 끝났습니다`가 표시되면 `새로고침`을 눌러 새 버전을 적용합니다.

검사나 빌드가 실패하면 `main`에 커밋하지 않으므로 현재 운영 배포는 그대로 남습니다. 설치본에서 ShareDesk 코드 파일을 직접 고친 경우에도 덮어쓰지 않고 충돌한 파일 이름을 표시하며 멈춥니다. 실패가 표시되면 `자세한 기록 보기`로 GitHub Actions 기록을 확인할 수 있습니다.

### 원클릭 업데이트 준비(한 번만)

앱 안에서 바로 업데이트하려면 ShareDesk가 내 설치 저장소의 workflow를 실행할 수 있도록 GitHub 토큰을 한 번 만들어 Vercel에 넣습니다. 이 토큰은 내 설치 저장소 하나의 Actions 권한만 가진 최소 권한 토큰입니다.

1. GitHub에 로그인한 뒤 오른쪽 위 프로필 사진 → `Settings`를 엽니다.
2. 왼쪽 메뉴 맨 아래의 `Developer settings` → `Personal access tokens` → `Fine-grained tokens`를 엽니다.
3. `Generate new token`을 누릅니다.
4. 토큰 이름을 알아볼 수 있게 적습니다. 예) `sharedesk-update`
5. `Expiration`(만료일)을 정합니다. 만료일이 지나면 원클릭이 멈추고 폴백 경로만 남으므로, 긴 만료일을 고르고 만료 시점을 기억해 두거나 만료 뒤 이 절차로 토큰을 다시 만드세요.
6. `Repository access`에서 `Only select repositories`를 고르고 **내 ShareDesk 설치 저장소 하나만** 선택합니다.
7. `Permissions` → `Repository permissions`에서 `Actions`를 `Read and write`로 바꿉니다.
8. 같은 화면의 `Account permissions`에서 `Starring`을 `Read and write`로 바꿉니다. 업데이트를 시작할 때 ShareDesk 저장소에 별을 남기는 데 씁니다. 다른 권한은 건드리지 않습니다.
9. `Generate token`을 눌러 만들어진 토큰 값을 복사합니다. 이 값은 화면을 떠나면 다시 볼 수 없습니다.
10. Vercel 프로젝트의 `Settings` → `Environment Variables`에서 `Production` 환경에 아래 값을 추가합니다.

```dotenv
SHAREDESK_GITHUB_TOKEN=복사한-토큰-값
```

11. Production을 다시 배포합니다. 환경 변수 변경은 기존 배포에 자동으로 반영되지 않습니다.

토큰은 비밀값입니다. 공개 저장소, 채팅, 이슈, 스크린샷에는 붙이지 마세요.

### 토큰 없이 쓰는 폴백 경로

`SHAREDESK_GITHUB_TOKEN`을 넣지 않은 설치도 업데이트할 수 있습니다. 이 경우 `업데이트 하기`를 누르면 기존처럼 GitHub 화면이 열립니다.

1. 열린 GitHub Actions 화면에서 `Run workflow`를 누릅니다.
2. 검사가 모두 통과하면 설치 저장소의 `main`에 업데이트 커밋이 생깁니다.
3. 저장소와 연결된 Vercel이 새 커밋을 Production에 배포합니다.

실패·충돌 시 동작은 원클릭과 같습니다. 검사가 실패하면 `main`에 커밋하지 않습니다.

GitHub 기본 권한으로 실행 중인 workflow 파일 자체를 바꾸는 것은 허용되지 않습니다. 나중에 ShareDesk의 업데이트 작업 방식이 바뀐 릴리스에서는 구버전 workflow를 조용히 유지하지 않고 작업을 멈추며, 아래의 `0.2.0보다 오래된 설치를 한 번 전환하기`와 같은 1회 전환을 안내합니다. 앱과 일반 업데이트 코드는 그 경우가 아니면 관리자가 위 절차(원클릭 또는 폴백)를 직접 시작했을 때만 갱신됩니다.

업데이트 버튼에 저장소가 연결되지 않았다고 나오면 Vercel Production 환경 변수에 아래 값을 추가한 뒤 다시 배포하세요.

```dotenv
SHAREDESK_GITHUB_REPOSITORY=내-GitHub계정/내-ShareDesk저장소
```

Deploy with Vercel로 만든 프로젝트는 Vercel의 Git 저장소 정보가 자동으로 잡히므로 이 값을 따로 넣지 않아도 됩니다. GitHub Actions가 성공했는데 Vercel 배포가 시작되지 않으면 Vercel 프로젝트의 `Settings` → `Git`에서 같은 설치 저장소의 `main`이 Production Branch로 연결됐는지 확인합니다.

## 0.5.0에서 달라지는 동작

0.5.0부터 사용자마다 역할이 생깁니다. 업데이트 뒤에는 다음이 적용됩니다.

- 기존 사용자는 모두 `수정 가능` 역할로 이어집니다. 쓰던 작업 방식은 바뀌지 않습니다.
- 운영(`STORAGE_DRIVER=drive`) 설치에서 `ACCESS_KEYS`로 들어오는 접속 키 손님은 `보기 전용`으로 바뀝니다. 접속 키로 파일을 올리거나 고치던 사용 방식은 업데이트 뒤 동작하지 않습니다. local 모드의 접속 키는 그대로 `수정 가능`입니다.
- 역할은 관리자 화면 사용자 표의 역할 열에서 언제든 조정할 수 있습니다.

## 0.2.0보다 오래된 설치를 한 번 전환하기

업데이트 버튼과 workflow가 없는 기존 설치본은 아래 전환을 **한 번만** 합니다. 먼저 설치 저장소의 `main`을 로컬에 열고, `git status`에 변경이 없는지 확인하세요.

Windows PowerShell:

```powershell
$shareDeskBootstrap = Join-Path $env:TEMP 'sharedesk-bootstrap.mjs'
Invoke-WebRequest 'https://github.com/Youkamii/sharedesk-template/releases/latest/download/sharedesk-bootstrap.mjs' -OutFile $shareDeskBootstrap
node $shareDeskBootstrap --apply
Remove-Item -LiteralPath $shareDeskBootstrap
```

macOS 또는 Linux:

```bash
sharedesk_bootstrap="$(mktemp)"
curl -fL 'https://github.com/Youkamii/sharedesk-template/releases/latest/download/sharedesk-bootstrap.mjs' -o "$sharedesk_bootstrap"
node "$sharedesk_bootstrap" --apply
rm -f "$sharedesk_bootstrap"
```

스크립트는 릴리스의 파일 해시를 확인한 뒤 앱 코드와 업데이트 파일을 로컬 작업 폴더에 적용합니다. `.env.local`, `.vercel`, `.git`과 ShareDesk가 관리하지 않는 파일은 건드리지 않습니다. 기존 코드가 공식 0.1.0과 다르면 임의로 덮어쓰지 않고 충돌 경로를 보여 줍니다.

적용 뒤에는 다음을 실행합니다.

```powershell
npm ci
npm test
npm run lint
npx tsc --noEmit --incremental false
npm run build
git status --short
```

변경 내용을 확인하고 설치 저장소의 `main`에 커밋·push합니다. Vercel 배포가 끝나면 운영 주소에서 관리자 로그인과 파일 목록을 확인합니다. 이후 버전부터는 화면의 `업데이트` 버튼을 사용합니다.

## AI에게 기존 설치 업데이트 맡기기

코딩 AI에서 설치 저장소를 연 뒤 아래 요청문을 그대로 보낼 수 있습니다.

```text
이 ShareDesk 설치본을 최신 안정 버전으로 업데이트해줘.

먼저 docs/UPDATE.md를 읽고 현재 저장소·브랜치·git status·origin·Vercel 연결을 확인해라. 기존 업데이트 workflow가 있으면 화면 버튼과 같은 GitHub Actions 흐름을 사용하고, 없으면 docs/UPDATE.md의 1회 bootstrap을 사용해라.

.env.local, OAuth 값, Drive ID와 Drive 안의 파일·사용자·초대·메모는 바꾸거나 출력하지 마라. 공식 코드와 다른 파일이 있어 updater가 충돌을 보고하면 덮어쓰지 말고 경로와 선택지를 설명한 뒤 멈춰라.

변경이 필요하면 먼저 이 설치 저장소에 업데이트용 GitHub 이슈를 만들고, npm test, npm run lint, npx tsc --noEmit --incremental false, npm run build가 모두 통과한 뒤 그 이슈 번호를 넣어 한 커밋으로 만들어라. 허용된 설치 저장소만 push하고, 연결된 Vercel Production 배포와 운영 주소를 확인해라. 자동 검사와 실제 운영 확인을 구분해서 보고해라.
```

## 로컬 개인 사용

Vercel 없이 로컬에서만 쓰는 설치는 작업 폴더에서 다음으로 새 버전 여부를 확인할 수 있습니다.

```powershell
node scripts/sharedesk-update.mjs --check
```

실제 적용은 먼저 Git 작업 폴더가 깨끗한지 확인한 뒤 `node scripts/sharedesk-update.mjs --apply`를 실행하고, 위 검사 명령을 다시 수행합니다. 로컬 파일은 `LOCAL_STORAGE_ROOT`에 있으므로 코드 업데이트와 별도로 해당 폴더 전체를 백업하세요.
