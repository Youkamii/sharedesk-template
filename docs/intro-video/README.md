# 소개 영상 만들기

ShareDesk 소개 영상(1920×1080 · 30fps · 약 81초 · 무음 + 한국어 자막)의 원본이다.
영상은 녹화본이 아니라 **한 페이지짜리 HTML을 1/30초 간격으로 스크린샷 찍어** 만든다.

| 파일 | 하는 일 |
| --- | --- |
| `storyboard.html` | 영상 전체. 모든 움직임은 `window.seek(t)`(초) 하나로만 그린다. |
| `render.mjs` | 스토리보드를 헤드리스 크로미엄으로 열어 PNG 시퀀스를 찍고 ffmpeg로 MP4를 만든다. |

결과물 `docs/sharedesk-intro.mp4` 는 **저장소에 커밋하지 않는다.** 필요할 때 아래 명령으로 다시 만든다.

## 준비

1. **ffmpeg / ffprobe** 가 PATH에 있어야 한다. (`ffmpeg -version` 으로 확인)
2. **playwright 는 저장소 밖에 설치한다.** 저장소 `package.json` 은 건드리지 않는다.

```bash
mkdir -p /경로/video-tool && cd /경로/video-tool
npm init -y
npm i playwright
npx playwright install chromium
```

`render.mjs` 의 `--tool-dir` 기본값은 이 작업을 만들 때 쓴 임시 폴더다.
다른 곳에 설치했으면 매번 `--tool-dir` 로 알려 준다.

## 렌더

```bash
# 최종본 — 1920x1080, 30fps, docs/sharedesk-intro.mp4
node docs/intro-video/render.mjs --tool-dir /경로/video-tool

# 빠른 초안 — 960x540, 10fps (1~2분)
node docs/intro-video/render.mjs --tool-dir /경로/video-tool \
  --scale 0.5 --fps 10 --out /tmp/draft.mp4
```

| 옵션 | 뜻 | 기본값 |
| --- | --- | --- |
| `--out <path>` | 결과 mp4 경로 | `docs/sharedesk-intro.mp4` |
| `--fps <n>` | 초당 프레임 수 | `30` |
| `--scale <f>` | 화면 배율 (0.5면 960×540) | `1` |
| `--crf <n>` | H.264 품질. 숫자가 클수록 용량이 준다 | `18` |
| `--tool-dir <path>` | playwright 설치 폴더 | 아래 참고 |
| `--frames-dir <path>` | PNG 시퀀스를 둘 임시 폴더 | OS 임시 폴더 |
| `--keep-frames` | 끝난 뒤 PNG를 지우지 않는다 | 끔 |

렌더러는 저장소 루트를 잠깐 `127.0.0.1` 로 내려 주는 작은 정적 서버를 띄운다.
`file://` 로 열면 크로미엄이 Galmuri11 글꼴 파일을 막는 경우가 있어서다. 새 창은 뜨지 않는다.

**대략의 시간과 용량** (Windows 11, 위 설정 기준)

- 초안(960×540 · 10fps · 810장): 약 1분 30초 · 2.5 MB
- 최종(1920×1080 · 30fps · 2430장): 아래 "실제 측정값" 참고

용량이 40 MB를 넘으면 `--crf 20` 처럼 숫자를 올려 다시 인코딩한다.

## 미리보기

브라우저에서 바로 열고 싶으면 저장소 루트에서 정적 서버를 띄운 뒤
`/docs/intro-video/storyboard.html` 을 연다. (예: `python -m http.server`)
오른쪽 아래 막대의 **재생** 단추와 슬라이더로 아무 지점이나 볼 수 있다.

`file://` 로 직접 열어도 화면은 보이지만 픽셀 글꼴이 안 잡힐 수 있다.

## 고칠 때 알아야 할 규칙

- **실제 시계를 쓰지 않는다.** CSS `animation`·`transition`, `requestAnimationFrame`,
  `Date.now()` 로 그림을 그리면 프레임마다 결과가 달라져 영상이 떨린다.
  모든 움직임은 `seek(t)` 안에서 `t` 로만 계산한다. `seek` 는 **몇 번을 불러도,
  어떤 순서로 불러도 같은 t면 같은 화면**이 나와야 한다(뒤로 감기 포함).
- 깜빡임이 필요하면 `blink(t, 주기)`, 한 글자씩 찍히는 글씨는 `typed(글, t, 시작, 초당글자수)`
  처럼 이미 있는 순수 함수를 쓴다.
- 장면 길이와 자막은 파일 안 `CAPS` 배열과 각 `draw*` 함수 위쪽에 모여 있다.
  총 길이는 `DURATION` 상수다. 길이를 바꾸면 `DURATION` 도 같이 고친다.
- 화면은 위 1920×930이 본 화면, 아래 150px이 자막 띠다.
- 글꼴은 `public/fonts/Galmuri11.woff2` 를 그대로 쓴다. 비트맵 글꼴이라 **11의 배수**
  (22px, 33px, 44px …)일 때 가장 또렷하다.
- 배경·실제 화면 캡처는 저장소의 진짜 자산을 상대 경로로 가져다 쓴다
  (`../../public/art/*.png`, `../sharedesk-desktop.png`). 이미지를 키울 때는
  `image-rendering: pixelated` 를 유지한다.
- 색과 간격은 `DESIGN.md`(Dusk Room OS)와 `src/app/files/desktop.module.css` 를 따른다.
  창·아이콘·작업표시줄은 실제 앱을 본뜬 HTML/CSS 모형이다. 앱을 띄워 녹화하지 않는다
  (로그인과 Google Drive가 필요하다).
- 내용은 `README.ko.md` 에 있는 사실만 말한다. 없는 기능을 지어내지 않는다.

## 장면 구성

| 시작 | 길이 | 장면 | 내용 |
| ---: | ---: | --- | --- |
| 0s | 7s | 훅 | 어두운 화면 → 픽셀 커서 → ShareDesk 로고와 "한 사람의 Google Drive, 모두의 바탕화면" |
| 7s | 8s | 문제 | 링크 부탁 · 권한 열기 · 흩어진 파일 |
| 15s | 9s | 참여 | 호스트 Drive ↕ 같은 주소 ↕ 각자의 Google 계정, 초대 코드 입력 |
| 24s | 12s | 바탕화면과 창 | 아이콘 끌기, 폴더 창, 사진 미리보기 → .txt 공동 편집, 폴더 메모 |
| 36s | 11s | 함께 | 접속자 목록, 채팅 버튼 반짝임과 읽지 않은 수, 역할 3가지 |
| 47s | 13s | 공유와 전송 | 우클릭 1시간 링크, 간이 링크 만들기, 생성된 링크, 새로고침 뒤 이어받기 |
| 60s | 11s | 용량과 개인 설정 | 도넛 표시, 배경 4종 전환, 언어 5가지 |
| 71s | 10s | 마무리 | 실제 화면 → 저장소 주소와 README 안내, 페이드아웃 |
