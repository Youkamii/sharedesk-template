# AI에게 ShareDesk 구축 맡기기

Google Cloud나 Vercel이 낯설다면 코딩 AI에게 구축을 맡길 수 있습니다. AI가 저장소와 터미널을 확인하고, 사용자가 직접 눌러야 하는 화면만 한 단계씩 안내하도록 만든 문서입니다.

이 안내는 **내 Google Drive 저장 공간을 여러 사람이 각자의 Google 계정으로 함께 쓰는 ShareDesk를 새로 여는 호스트**를 위한 것입니다. 이미 만들어진 ShareDesk에 초대받은 참여자는 설치하지 않습니다.

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
5. Client secret, SESSION_SECRET, refresh token, callback URL, 초대 코드 같은 비밀값을 채팅·이슈·커밋·스크린샷에 요구하거나 출력하지 마라. 사용자가 .env.local, 로컬 터미널 입력, Google Cloud, Vercel 화면에 직접 넣도록 안내하라. callback URL은 npm run setup -- --finish가 묻는 로컬 터미널에만 사용자가 직접 붙여 넣게 하라.
6. 저장소 파일을 바꿔야 한다면 서로 다른 기능이나 수정마다 GitHub 이슈를 먼저 만들고, 검증 뒤 해당 파일만 따로 커밋해 이슈 번호를 남겨라. .env.local과 비밀값은 절대 커밋하지 마라. 추적 파일 변경이 없다면 빈 이슈나 빈 커밋을 만들지 마라.
7. 이 요청은 현재 작업 중인 내 ShareDesk 저장소의 필요한 변경, 기능별 GitHub 이슈와 로컬 커밋, 현재 작업 브랜치 push, 연결된 내 Vercel 프로젝트의 Production 배포를 허용한다. 작업 전에 실제 대상 저장소·브랜치·Vercel 프로젝트·Production 주소를 확인하고, 원본 템플릿이나 다른 사람의 저장소·프로젝트는 건드리지 마라.
8. 자동 검사 통과와 실제 운영 확인을 구분하라. 확인하지 않은 내용을 완료했다고 보고하지 마라. 저장소를 바꿨다면 검사와 기능별 커밋을 끝낸 뒤에만 push·배포하라.

진행 순서:
1. 현재 상태를 표로 정리하고, 완료·미완료·확인 필요로 나눠라.
2. 내 GitHub 저장소와 Vercel 프로젝트가 없을 때만 만들거나 연결하고, 바뀌지 않는 Production 주소를 기록하라.
3. Google Cloud에서 같은 프로젝트의 Drive API, Branding, Audience, Data Access, Web application OAuth 클라이언트를 확인하라. docs/INSTALL.md의 redirect URI 세 개와 scope 네 개가 정확히 맞는지 확인하게 하라.
4. 저장소에서 npm ci를 실행하고 .env.local을 안전하게 준비하라. Google Client ID와 Client secret은 사용자가 파일에 직접 넣게 하라.
5. npm run setup을 실행해 호스트 Google 동의를 시작하라. 동의 뒤 callback URL은 사용자가 npm run setup -- --finish의 질문에 직접 붙여 넣게 하고, AI는 그 값을 읽거나 재출력하지 마라.
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

## AI가 반드시 멈춰야 하는 순간

다음 값과 화면은 사용자가 직접 다뤄야 합니다. AI는 한 단계만 안내한 뒤 기다립니다.

| 순간 | 사용자가 직접 할 일 | AI가 확인할 결과 |
|---|---|---|
| Google Cloud OAuth 설정 | Drive API, Audience, scope, redirect URI를 화면에서 확인·저장 | 설정 항목과 주소가 [운영 설치 안내](./INSTALL.md)와 일치하는지 |
| Client ID와 secret 입력 | 로컬 `.env.local`에 직접 입력 | 값은 출력하지 않고 두 항목이 비어 있지 않은지만 확인 |
| 호스트 Google 동의 | 브라우저에서 호스트 계정을 선택하고 동의 | setup이 다음 단계로 이어지는지 |
| callback URL 입력 | `npm run setup -- --finish`가 묻는 로컬 터미널에 직접 붙여넣기 | setup 성공 여부만 확인 |
| Vercel 비밀값 입력 | Vercel Production 환경 변수 화면에 직접 입력 | 필요한 변수 이름과 배포 반영 여부 |
| 참여자 계정 확인 | 별도 Google 계정으로 로그인하고 초대 코드 입력 | 두 계정에서 같은 파일이 보이고 내려받아지는지 |

## 설치가 끝났다고 말할 수 있는 기준

코드 검사와 배포 성공만으로는 끝난 것이 아닙니다. 다음까지 실제로 확인해야 합니다.

- 고정 Production 주소에서 호스트 Google 로그인이 됩니다.
- 폴더와 파일이 새로고침 뒤에도 남고, 휴지통에 버린 항목을 복원할 수 있습니다.
- `/admin`에서 초대 코드를 만들 수 있습니다.
- 별도 Google 계정이 초대 코드로 들어옵니다.
- 호스트와 참여자 두 계정에서 같은 파일이 보이고 다운로드됩니다.
- 저장소 변경이 있다면 기능별 이슈와 커밋이 서로 맞고, 허용된 경우에만 push·배포됐습니다.

설치 화면과 오류별 자세한 설명은 [ShareDesk 운영 설치 안내](./INSTALL.md)를 따르세요.
