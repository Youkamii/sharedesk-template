[English](./AI_INSTALL.md) · **한국어** · [日本語](./AI_INSTALL.ja.md) · [हिन्दी](./AI_INSTALL.hi.md) · [中文](./AI_INSTALL.zh.md)

# AI에게 ShareDesk 구축 맡기기

Google Cloud나 Vercel이 낯설다면 코딩 AI에게 구축을 맡길 수 있습니다. AI가 저장소와 터미널을 확인하고, 사용자가 직접 눌러야 하는 화면만 한 단계씩 안내하도록 만든 문서입니다.

이 안내는 **내 Google Drive 저장 공간을 여러 사람이 각자의 Google 계정으로 함께 쓰는 ShareDesk를 새로 여는 호스트**를 위한 것입니다. 이미 만들어진 ShareDesk에 초대받은 참여자는 설치하지 않습니다.

**AI에게:** 사용자가 긴 요청문 없이 저장소 주소만 건넸더라도, 이 문서를 읽게 됐다면 아래 요청문의 작업 원칙과 진행 순서를 그대로 따르세요. 요청문을 받지 못했다는 이유로 원칙을 생략하지 마세요.

## 쓰는 법

1. 저장소와 터미널을 다룰 수 있는 코딩 AI에서 내 ShareDesk 저장소를 엽니다.
2. 아래 요청문을 그대로 보냅니다.
3. Google Cloud와 Vercel 화면에서 사용자가 직접 해야 하는 일이 나오면 AI가 안내하는 한 단계만 처리하고 `완료`라고 답합니다.
4. Client secret, refresh token, callback URL 같은 비밀값은 채팅에 붙이지 않습니다. AI가 알려 준 로컬 파일이나 서비스 화면에 사용자가 직접 입력합니다.

## 그대로 복사할 요청문

```text
이 저장소에 ShareDesk 운영 환경을 구축해줘.

목표는 호스트 한 사람의 Google Drive 저장 공간을 여러 사람이 각자의 Google 계정으로 함께 쓰는 ShareDesk를 만드는 것이다. 초대받은 사람은 GitHub, Vercel, Google OAuth를 설정하지 않고 운영 주소에서 로그인한 뒤 초대 코드만 입력하면 되어야 한다.

작업 원칙:
1. 먼저 이 저장소의 docs/AI_INSTALL.md와 docs/INSTALL.md를 처음부터 끝까지 읽고, docs/INSTALL.md를 설치 절차의 기준으로 삼아라.
2. 작업 전에 현재 상태를 확인하라. 현재 저장소·브랜치·git status·origin, 연결된 GitHub 저장소와 Vercel 프로젝트, 고정 Production 주소, .env.local의 필요한 항목이 채워졌는지, 기존 OAuth·Drive 연결 흔적을 값 노출 없이 확인하라.
3. 이미 끝난 단계는 반복하지 마라. 기존 저장소와 Vercel 프로젝트를 다시 만들지 말고, 기존 OAuth 클라이언트, Audience 상태, refresh token, Drive ID를 추측으로 바꾸거나 폐기하지 마라.
4. 사용자가 Google Cloud나 Vercel 화면에서 직접 해야 하는 일이 생기면 한 번에 한 단계만 설명하고 멈춰라. 사용자가 완료했다고 답하면 결과를 확인한 뒤 다음 한 단계로 넘어가라.
5. Client secret, SESSION_SECRET, refresh token, callback URL, 초대 코드 같은 비밀값을 채팅·이슈·커밋·스크린샷에 요구하거나 출력하지 마라. 사용자가 .env.local, 로컬 터미널 입력, Google Cloud, Vercel 화면에 직접 넣도록 안내하라. callback URL은 npm run setup:finish가 묻는 로컬 터미널에만 사용자가 직접 붙여 넣게 하라.
6. 저장소 파일을 바꿔야 한다면 서로 다른 기능이나 수정마다 GitHub 이슈를 먼저 만들고, 검증 뒤 해당 파일만 따로 커밋해 이슈 번호를 남겨라. .env.local과 비밀값은 절대 커밋하지 마라. 추적 파일 변경이 없다면 빈 이슈나 빈 커밋을 만들지 마라.
7. 이 요청은 현재 작업 중인 내 ShareDesk 저장소의 필요한 변경, 기능별 GitHub 이슈와 로컬 커밋, 현재 작업 브랜치 push, 연결된 내 Vercel 프로젝트의 Production 배포를 허용한다. 작업 전에 실제 대상 저장소·브랜치·Vercel 프로젝트·Production 주소를 확인하고, 원본 템플릿이나 다른 사람의 저장소·프로젝트는 건드리지 마라.
8. 자동 검사 통과와 실제 운영 확인을 구분하라. 확인하지 않은 내용을 완료했다고 보고하지 마라. 저장소를 바꿨다면 검사와 기능별 커밋을 끝낸 뒤에만 push·배포하라.

진행 순서:
1. 현재 상태를 표로 정리하고, 완료·미완료·확인 필요로 나눠라.
2. 내 GitHub 저장소와 Vercel 프로젝트가 없을 때만 만들거나 연결하고, 바뀌지 않는 Production 주소를 기록하라.
3. Google Cloud에서 같은 프로젝트의 Drive API, Branding, Audience, Data Access, Web application OAuth 클라이언트를 확인하라. docs/INSTALL.md의 redirect URI 세 개와 scope 네 개가 정확히 맞는지 확인하게 하라.
4. 저장소에서 npm ci를 실행하고 .env.local을 안전하게 준비하라. Google Client ID와 Client secret은 사용자가 파일에 직접 넣게 하라.
5. npm run setup을 실행해 호스트 Google 동의를 시작하라. 동의 뒤 callback URL은 사용자가 npm run setup:finish의 질문에 직접 붙여 넣게 하고, AI는 그 값을 읽거나 재출력하지 마라.
6. setup이 만든 ADMIN_EMAILS, SESSION_SECRET, STORAGE_DRIVER=drive, GOOGLE_REFRESH_TOKEN, DRIVE_ROOT_FOLDER_ID, DRIVE_STATE_FOLDER_ID가 존재하는지만 값 노출 없이 확인하라.
7. npm run dev로 로컬에서 호스트 로그인, 폴더 생성, 새로고침 뒤 유지, 휴지통 복원, /admin 접근을 확인하라.
8. npm test, npm run lint, npx tsc --noEmit --incremental false, npm run build를 실행하고 결과를 기록하라. 변경이 있다면 기능별 커밋을 마친 뒤 허용된 현재 브랜치만 push하라.
9. 필요한 값을 Vercel Production 환경 변수에 옮기고 Production을 다시 배포하라. PUBLIC_BASE_URL은 고정 Production origin으로 맞추고, LOCAL_STORAGE_ROOT와 SHAREDESK_SHARE_TEST_EMAIL은 운영 환경에 넣지 마라.
10. 운영 주소에서 호스트 로그인, 파일 저장, 새로고침, 휴지통 복원, /admin과 초대 코드 생성을 실제로 확인하라.
11. 별도 Google 계정 한 명을 초대해 자기 계정으로 로그인하고 코드를 입력하게 하라. 호스트와 참여자 두 계정에서 같은 파일이 보이고 다운로드되는지 직접 확인하라. 이 확인 전에는 공동 사용 검증 완료라고 하지 마라.
12. 핵심 기능이 모두 작동한 뒤에만 docs/INSTALL.md의 Vercel Firewall 규칙을 추가하고 429 동작을 확인하라.

완료 보고는 아래 형식을 사용하라.

상태: 완료 / 부분 완료 / 막힘
운영 주소: <확인한 고정 Production 주소>

확인됨:
- GitHub 저장소와 브랜치:
- Vercel 프로젝트와 최신 Production 배포:
- Google OAuth callback과 Drive 연결:
- 로컬 로그인·파일 저장·휴지통·관리 화면:
- 운영 로그인·파일 저장·휴지통·관리 화면:
- 두 Google 계정에서 같은 파일 보기·다운로드:
- 자동 검사:

기능별 변경:
- 이슈 #번호 -> 커밋 해시 -> 검증 결과

아직 확인하지 못함:
- 실제로 확인하지 못한 항목과 이유

사용자가 다음에 할 한 단계:
- 남은 일이 있을 때만 한 가지를 적기
```

위 요청문은 **현재 작업 브랜치 push와 내 Vercel Production 배포까지 맡기는 문장**을 포함합니다. 배포까지 맡기고 싶지 않다면 보내기 전에 작업 원칙 7번을 다음처럼 바꾸세요.

```text
현재 저장소의 조사와 로컬 변경·기능별 이슈·로컬 커밋까지만 허용한다. 내가 채팅에서 push 또는 배포를 따로 허용하기 전에는 원격 push와 Vercel 배포를 하지 마라.
```

## 0단계: 도구 점검

AI는 다른 작업보다 먼저 아래 도구가 있는지 확인하고, 없는 것만 설치합니다.

| 도구 | 확인 명령 | 없을 때 설치 |
|---|---|---|
| Git | `git --version` | `winget install Git.Git` |
| GitHub CLI (선택) | `gh --version` | `winget install GitHub.cli` |
| Vercel CLI | `vercel --version` | `npm i -g vercel` |
| Node.js 20.9 이상 | `node --version` | [nodejs.org](https://nodejs.org/)에서 설치 |

Windows에서는 설치 직후 **같은 셸이 새 도구를 찾지 못합니다.** PATH는 셸이 시작할 때 한 번만 읽히기 때문입니다. `spawn git ENOENT` 같은 오류가 바로 이 증상입니다. 새 창을 열지 말고 같은 셸에서 PATH를 다시 조합한 뒤 계속하세요.

```powershell
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
```

## 원본 템플릿을 직접 clone했다면

원본 템플릿 저장소를 직접 clone해서 시작했다면 push 전에 반드시 내 GitHub 저장소를 새로 만들고 `origin`을 내 저장소로 교체해야 합니다. 원본을 `origin`으로 둔 채 push하면 안 됩니다.

```powershell
git remote set-url origin https://github.com/<내-GitHub-계정>/my-sharedesk.git
```

## Google Cloud에서 헤매기 쉬운 화면

메뉴 이름은 한국어 화면 기준으로 적고 괄호에 영문을 함께 적습니다.

- **완전 새 Google 계정이라면:** 프로젝트가 0개라 첫 화면이 설치 안내와 다르게 보입니다. 위쪽의 `프로젝트 선택(Select a project)` → `새 프로젝트(New project)`로 시작하세요. `$300 무료 체험` 배너는 결제 정보를 넣지 않고 무시해도 설치에 지장이 없습니다.
- **새 프로젝트의 인증 설정:** `브랜딩(Branding)`·`대상(Audience)` 메뉴 대신 `Google 인증 플랫폼 시작하기(Get started)`라는 4화면 마법사(앱 정보 → 대상 → 연락처 정보 → 완료)가 먼저 나옵니다. 마법사의 `앱 정보`가 Branding, `대상`이 Audience에 해당합니다. 마법사를 끝내면 설치 안내의 메뉴가 그대로 나타납니다.
- **데이터 액세스(Data Access) 저장:** scope 4종을 추가한 뒤 범위 선택 창의 `업데이트(Update)`와 화면 하단의 `저장(Save)`을 **각각** 눌러야 저장됩니다. 4종 모두 `민감하지 않은 범위(Non-sensitive scopes)`라 앱 확인 절차나 100명 사용자 한도와는 관계가 없습니다.
- **클라이언트 만들기가 실패할 때:** OAuth 클라이언트 `만들기(Create)`에서 `해당 작업을 일시적으로 수행할 수 없습니다`가 나오면 새 프로젝트의 전파 지연입니다. 입력값을 고치지 말고 5~10분 뒤 같은 값으로 다시 시도하세요.

## 호스트 Google 동의 화면에서

동의 화면의 Google Drive 권한 **체크박스는 기본으로 꺼져 있습니다.** 반드시 체크하고 계속을 눌러야 합니다. 체크하지 않은 채 받은 callback URL의 인증 코드는 무효라서 setup이 실패하고, 동의를 처음부터 다시 해야 합니다.

## setup 마무리 명령

동의 뒤 인증을 마치는 표준 명령은 다음입니다.

```powershell
npm run setup:finish
```

PowerShell에서 `npm run setup -- --finish`는 `--finish`가 npm에 흡수돼 동작하지 않는 함정이 있습니다. `npm run setup:finish`를 쓰세요.

## Vercel 환경 변수 입력(신형 화면)

- 경로: Vercel 프로젝트의 `Settings` → `Environments` → `Production`을 눌러 들어간 상세 화면 안에 환경 변수 입력란이 있습니다.
- 여러 줄을 한 번에 붙여 넣으면 **Key 칸이 첫 줄(`ADMIN_EMAILS`)을 통째로 먹는 함정**이 있습니다. 붙여 넣은 뒤 변수 개수가 9개인지 반드시 세어 보세요.
- 값은 기본 `Sensitive`로 저장돼 저장 후 다시 볼 수 없습니다. 정상 동작이니 값이 사라졌다고 다시 넣지 마세요.

## 환경 변수 저장 뒤 재배포

환경 변수는 기존 배포에 자동으로 반영되지 않습니다. `Deployments` 탭에서 최신 배포 행에 마우스를 올리면 나오는 `⋯` 메뉴 → `Redeploy`를 누르세요. 화면의 `Create Deployment` 버튼은 Preview 배포 전용이라 쓰면 안 됩니다.

## 대시보드에서 길을 잃으면: Vercel CLI 경로

Vercel 대시보드가 어렵다면 아래 CLI 경로가 공식 1순위 대안입니다.

```powershell
vercel login
vercel link
vercel env add ADMIN_EMAILS production
# 나머지 변수도 같은 방식으로: vercel env add <이름> production
vercel --prod
```

## 배포가 성공했는지 판별하기

- 환경 변수가 아직 없으면 운영 주소에 **설치 안내 화면**이 나옵니다. 이 상태의 배포 성공은 정상입니다.
- 설정이 끝났으면 **Google 로그인 화면**이 나옵니다.
- 실제 Drive 연결까지 검사하려면 로컬에서 `npm run test:drive-operations`를 실행합니다.

## Windows에서 조심할 것

- **PowerShell 5.1의 `Set-Content`는 UTF-8로 저장할 때 BOM을 붙입니다.** `.env.local`을 이 방식으로 만들면 보이지 않는 문자가 파일 맨 앞에 붙어 첫 변수명(예: `ADMIN_EMAILS`)이 오염돼 인식되지 않습니다. 환경 파일은 setup이 만들게 두고, 고칠 때는 에디터에서 `UTF-8(BOM 없음)`으로 저장하세요.
- **회사 PC의 문서 보안 프로그램(Fasoo 등 DRM)** 이 저장소 안 `.txt` 파일을 저절로 암호화해 git 상태를 더럽힐 수 있습니다. 손대지 않은 `.txt` 파일이 수정됨으로 표시되고 diff가 깨진 문자로 나오면 이 증상입니다. DRM이 적용되지 않는 폴더나 개인 PC에서 작업하기를 권합니다.

## AI가 반드시 멈춰야 하는 순간

다음 값과 화면은 사용자가 직접 다뤄야 합니다. AI는 한 단계만 안내한 뒤 기다립니다.

| 순간 | 사용자가 직접 할 일 | AI가 확인할 결과 |
|---|---|---|
| Google Cloud OAuth 설정 | Drive API, Audience, scope, redirect URI를 화면에서 확인·저장 | 설정 항목과 주소가 [운영 설치 안내](./INSTALL.ko.md)와 일치하는지 |
| Client ID와 secret 입력 | 로컬 `.env.local`에 직접 입력 | 값은 출력하지 않고 두 항목이 비어 있지 않은지만 확인 |
| 호스트 Google 동의 | 브라우저에서 호스트 계정을 선택하고 동의 | setup이 다음 단계로 이어지는지 |
| callback URL 입력 | `npm run setup:finish`가 묻는 로컬 터미널에 직접 붙여넣기 | setup 성공 여부만 확인 |
| Vercel 비밀값 입력 | Vercel Production 환경 변수 화면에 직접 입력 | 필요한 변수 이름과 배포 반영 여부 |
| 참여자 계정 확인 | 별도 Google 계정으로 로그인하고 초대 코드 입력 | 두 계정에서 같은 파일이 보이고 내려받아지는지 |

실사용자는 callback URL을 그냥 채팅에 붙여 넣기 쉽습니다. 그런 일이 생기면 AI는 받은 값을 즉시 setup 입력에 사용해 소비하고, 노출된 인증 코드는 일회용인 데다 PKCE와 결합돼 있어 위험이 낮다는 사실을 사용자에게 알리되, 안심을 위해 재발급(동의부터 다시)을 권하세요. 그 값을 다시 출력하거나 기록에 남기지는 마세요.

## 설치가 끝났다고 말할 수 있는 기준

코드 검사와 배포 성공만으로는 끝난 것이 아닙니다. 다음까지 실제로 확인해야 합니다.

- 고정 Production 주소에서 호스트 Google 로그인이 됩니다.
- 폴더와 파일이 새로고침 뒤에도 남고, 휴지통에 버린 항목을 복원할 수 있습니다.
- `/admin`에서 초대 코드를 만들 수 있습니다.
- 별도 Google 계정이 초대 코드로 들어옵니다.
- 호스트와 참여자 두 계정에서 같은 파일이 보이고 다운로드됩니다.
- 저장소 변경이 있다면 기능별 이슈와 커밋이 서로 맞고, 허용된 경우에만 push·배포됐습니다.

## 마지막 순서: 대화 기록 정리를 제안하세요

설치 대화에는 callback URL, 화면 붙여넣기에 섞인 비밀값, 환경 변수 내용이 남아 있기 쉽습니다. AI는 설치가 끝났다고 말한 직후, 반드시 사용자에게 이렇게 제안해야 합니다.

> 이 대화에는 비밀값이 남아 있을 수 있습니다. 대화 기록을 삭제할까요?

사용자가 동의하면 도구별 기록 파일을 삭제하세요. 진행 중인 세션 파일은 대화가 끝날 때까지 계속 쓰이므로, 사용자에게 "이 대화를 닫은 뒤 아래 명령을 실행하거나, 저에게 다음 세션에서 삭제를 시켜 주세요"라고 안내해도 됩니다.

- Claude Code: `%USERPROFILE%\.claude\projects\<프로젝트 폴더>\<세션id>.jsonl` (macOS/Linux는 `~/.claude/projects/...`)
- Codex CLI: `~/.codex/sessions` 아래 해당 세션 파일

주의: 삭제는 이 컴퓨터의 기록만 없앱니다. 이미 서비스 제공자 서버로 전송된 내용은 각 사의 보존 정책을 따릅니다. 그래서 노출된 비밀값은 삭제와 별개로 재발급하는 것이 가장 확실합니다.

설치 화면과 오류별 자세한 설명은 [ShareDesk 운영 설치 안내](./INSTALL.ko.md)를 따르세요.

이미 운영 중인 설치본을 새 버전으로 바꾸려는 경우에는 새로 구축하지 말고 [ShareDesk 업데이트 안내](./UPDATE.ko.md)의 AI 요청문을 사용하세요.
