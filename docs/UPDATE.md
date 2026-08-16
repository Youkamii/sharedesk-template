# ShareDesk 업데이트

ShareDesk는 설치할 때 만들어진 **내 GitHub 저장소**를 업데이트하고, 그 저장소와 연결된 Vercel이 다시 배포하는 방식으로 새 버전을 적용합니다. Google Drive의 파일·사용자·초대·메모와 Vercel 환경 변수는 코드 업데이트 대상이 아닙니다.

## 업데이트 하기

ShareDesk는 새 버전을 자동으로 적용하지 않습니다. 관리자가 직접 시작한 경우에만 설치 저장소를 바꿉니다.

1. 관리자로 로그인한 뒤 작업표시줄에서 `업데이트 하기`를 누릅니다.
2. 열린 GitHub Actions 화면에서 업데이트할 때만 `Run workflow`를 누릅니다.
3. 검사가 모두 통과하면 설치 저장소의 `main`에 업데이트 커밋이 생깁니다.
4. 저장소와 연결된 Vercel이 새 커밋을 Production에 배포합니다.

검사나 빌드가 실패하면 `main`에 커밋하지 않으므로 현재 운영 배포는 그대로 남습니다. 설치본에서 ShareDesk 코드 파일을 직접 고친 경우에도 덮어쓰지 않고 충돌한 파일 이름을 표시하며 멈춥니다.

GitHub 기본 권한으로 실행 중인 workflow 파일 자체를 바꾸는 것은 허용되지 않습니다. 나중에 ShareDesk의 업데이트 작업 방식이 바뀐 릴리스에서는 구버전 workflow를 조용히 유지하지 않고 작업을 멈추며, 아래의 `0.2.0보다 오래된 설치를 한 번 전환하기`와 같은 1회 전환을 안내합니다. 앱과 일반 업데이트 코드는 그 경우가 아니면 관리자가 화면 버튼으로 시작한 때에만 갱신됩니다.

작업표시줄에 `업데이트 연결`이 보이면 그 버튼에서 안내를 연 뒤, Vercel Production 환경 변수에 아래 값을 추가하고 다시 배포하세요. 연결되면 같은 자리가 `업데이트 하기`로 바뀝니다.

```dotenv
SHAREDESK_GITHUB_REPOSITORY=내-GitHub계정/내-ShareDesk저장소
```

Deploy with Vercel로 만든 프로젝트는 Vercel의 Git 저장소 정보가 자동으로 잡히므로 이 값을 따로 넣지 않아도 됩니다. GitHub Actions가 성공했는데 Vercel 배포가 시작되지 않으면 Vercel 프로젝트의 `Settings` → `Git`에서 같은 설치 저장소의 `main`이 Production Branch로 연결됐는지 확인합니다.

## 0.2.0보다 오래된 설치를 한 번 전환하기

`업데이트 하기`와 workflow가 없는 기존 설치본은 아래 전환을 **한 번만** 합니다. 먼저 설치 저장소의 `main`을 로컬에 열고, `git status`에 변경이 없는지 확인하세요.

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

변경 내용을 확인하고 설치 저장소의 `main`에 커밋·push합니다. Vercel 배포가 끝나면 운영 주소에서 관리자 로그인과 파일 목록을 확인합니다. 이후 버전부터는 화면의 `업데이트 하기` 버튼을 사용합니다.

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
