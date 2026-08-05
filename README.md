# ShareDesk

구글 드라이브 폴더 하나를 **키 하나로 함께 쓰는 공유 저장소**로 만들어주는 웹앱.

- 사용자는 구글 계정이 필요 없다 — 접속 키만 입력하면 탐색기 화면이 열린다.
- 구글에 로그인하는 사람은 드라이브 주인 한 명뿐 (최초 1회).
- 목록·폴더 이동·업로드(드래그앤드롭)·다운로드·새 폴더·이름변경·삭제(휴지통) 지원.

## 동작 구조

```
사용자 (키 입력) → ShareDesk 서버 (키 검사 → Drive API 대행) → 주인의 드라이브 'ShareDesk' 폴더
```

- OAuth scope는 `drive.file` — 이 앱이 만든 폴더·파일만 접근 가능. 주인 드라이브의 다른 파일은 애초에 보이지 않는다.
- 삭제는 드라이브 휴지통으로 이동 (주인이 복구 가능).
- 대용량 업로드는 서버를 거치지 않고 브라우저 → 구글 직행(resumable) 경로를 쓴다.

## 최초 설정 (주인 1회)

1. **구글 클라우드 콘솔** (console.cloud.google.com)
   - 새 프로젝트 생성 → "API 및 서비스 → 라이브러리"에서 **Google Drive API 사용 설정**
   - "OAuth 동의 화면": User Type **외부**, 앱 이름 지정 → 만들기 → **앱 게시(프로덕션)** 로 전환
     (테스트 상태로 두면 로그인이 7일마다 만료된다)
   - "사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID" → 유형 **데스크톱 앱**
   - 발급된 **클라이언트 ID / 클라이언트 보안 비밀**을 복사

2. **로컬 설정**
   ```bash
   npm install
   # .env.local 파일에 두 값을 기입:
   #   GOOGLE_CLIENT_ID=...
   #   GOOGLE_CLIENT_SECRET=...
   npm run setup
   ```
   출력된 URL을 브라우저에서 열어 로그인·동의하면, 스크립트가 자동으로:
   - refresh token 획득 → `.env.local` 기록
   - 드라이브에 `ShareDesk` 루트 폴더 생성
   - 접속 키·세션 비밀 생성 (`ACCESS_KEYS`가 비어 있을 때)

3. **실행**
   ```bash
   npm run dev   # http://localhost:3000
   ```
   접속 키를 아는 사람은 누구나 `http://<주소>/?key=<접속키>` 링크로 바로 입장할 수 있다.

## 환경 변수 (.env.local — 절대 커밋 금지)

| 변수 | 설명 |
|---|---|
| `ACCESS_KEYS` | 접속 키, 쉼표로 여러 개 |
| `SESSION_SECRET` | 세션 쿠키 서명 비밀 (setup이 생성) |
| `STORAGE_DRIVER` | `drive` 또는 `local`(개발용 로컬 폴더) |
| `LOCAL_STORAGE_ROOT` | local 드라이버가 쓸 폴더 (기본 `.devstorage`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth 클라이언트 (데스크톱 앱 유형) |
| `GOOGLE_REFRESH_TOKEN` | setup이 획득 |
| `DRIVE_ROOT_FOLDER_ID` | setup이 생성한 루트 폴더 ID |

## 배포 (Vercel)

1. 이 repo를 Vercel에 연결
2. 위 환경 변수 전부를 Vercel 프로젝트 환경 변수로 등록 (`STORAGE_DRIVER=drive`)
3. 배포 후 `https://<도메인>/?key=<접속키>` 링크를 공유

## 개발 모드

자격증명 없이 UI를 만지려면 `.env.local`에 `STORAGE_DRIVER=local`만 두면 된다.
`.devstorage/` 폴더가 가짜 드라이브 역할을 한다.

## 알아둘 것

- 키가 유출되면 키를 아는 모두가 접근 가능하다. 키를 바꾸려면 `ACCESS_KEYS` 수정 후 재배포/재시작.
- 무료 드라이브 용량은 15GB (주인 계정 기준).
- 구글 문서·시트 등 구글 네이티브 형식은 다운로드 미지원 (일반 파일만).
