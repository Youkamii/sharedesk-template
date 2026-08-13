# Design System — ShareDesk

## Product Context

- **What this is:** 호스트의 Google Drive 저장 공간을 여러 사람이 각자의 Google 계정으로 함께 쓰는 웹 기반 공유 바탕화면이다.
- **Who it is for:** 가족, 친구, 소규모 팀처럼 파일을 복잡한 권한 설정 없이 같은 공간에 놓고 쓰려는 사람들.
- **Project type:** 상호작용이 많은 웹 앱.

## Aesthetic Direction

- **Direction:** Dusk Room OS — 해 질 녘 작은 작업실을 닮은 따뜻한 도트 데스크톱.
- **Decoration level:** 배경은 expressive, 실제 조작 영역은 intentional.
- **Mood:** 조용하고 포근하지만 장난감 같지는 않다. 누군가 먼저 와서 불을 켜 둔 공동 작업실처럼 느껴져야 한다.
- **References:** [Galmuri](https://github.com/quiple/galmuri), [retro desktop references](https://dribbble.com/search/retro-desktop), [pixel interface references](https://dribbble.com/search/pixel-art-interface).

## Typography

- **Desktop UI:** Galmuri11 — 한글이 흐트러지지 않는 실제 비트맵 계열 글꼴. 데스크톱 화면의 아이콘, 창, 작업표시줄에 사용한다.
- **Login/Admin Body:** Geist Sans — 로그인, 가입, 관리 화면과 긴 설명에 먼저 사용한다.
- **Data:** Geist Mono — 용량, 시간, 진행률처럼 숫자 정렬이 필요한 곳에만 사용한다.
- **Loading:** `/public/fonts/Galmuri11.woff2`를 자체 호스팅한다. OFL 1.1 라이선스 파일을 함께 둔다.
- **Scale:** 데스크톱 UI는 9–20px 범위에서 정보 밀도와 모바일 화면에 맞춰 조절한다. 핵심 라벨은 11–14px을 기본으로 삼는다.

## Color

- **Approach:** 표현력 있는 배경 위에 제한된 UI 팔레트.
- **Night:** `#10172b` — 가장 깊은 배경과 그림자.
- **Panel:** `#182446` — 짙은 보조 버튼과 작은 패널 면.
- **Taskbar:** `#10172b` — 하단 작업표시줄.
- **Window:** `#f4e7c5` — 폴더·미리보기 창의 밝은 본문.
- **Title:** `#596078` — 비활성 창 제목줄. 활성 창은 `#2d5c5b`를 사용한다.
- **Peach:** `#f2a56f` — 선택, 진행, 주요 포인트.
- **Amber:** `#ffd27d` — 기본 강조와 따뜻한 빛.
- **Cream:** `#fff4d2` — 주요 글자와 밝은 면.
- **Teal:** `#61b3a6` — 연결됨, 완료.
- **Error:** `#e96872`; **Warning:** `#f1b65b`; **Info:** `#79a8e8`.
- 모든 아이콘 이름에는 배경과 관계없이 읽히는 짙은 그림자를 준다.

## Spacing

- **Base unit:** 4px.
- **Density:** 데스크톱은 compact, 터치 화면은 comfortable.
- **Scale:** 2, 4, 8, 12, 16, 24, 32, 48px.

## Layout

- **Approach:** 실제 OS 관례를 따르는 자유 배치 캔버스 + 구조적인 창 내부.
- **Desktop:** 위 상태바 34px, 아래 도크 58px, 나머지는 아이콘 캔버스.
- **Trash:** 휴지통은 화면 오른쪽 아래에 고정하고 작업표시줄에는 넣지 않는다. 바탕화면 아이콘보다 앞, 열린 창보다 뒤에 두며 뚜껑·손잡이·세로 홈이 보이는 금속 휴지통 형태를 유지한다.
- **Icon footprint:** 바탕화면 크기에 비례하는 상대 크기를 쓴다. 아이콘 위치와 창 크기도 현재 바탕화면을 기준으로 저장·복원하여, 작은 화면에서는 작게 보이고 큰 화면에서는 크게 보이게 한다.
- **Windows:** 제목줄로 이동, 오른쪽 아래에서 크기 변경. 모바일에서는 화면 대부분을 차지한다.
- **Corners:** 일반 UI 0–4px, 도크와 알림만 8–12px. 둥근 카드 일색을 피한다.
- **Borders:** 1px 선 대신 2px 빛/어둠 면을 겹친 픽셀 프레임을 쓴다.

## Motion

- **Approach:** intentional.
- **Duration:** 눌림 70ms, 메뉴/창 140ms, 알림 220ms.
- **Easing:** 위치 이동은 ease-out, 작은 강조는 `steps(2, end)`.
- `prefers-reduced-motion`에서는 등장과 흔들림을 없앤다.

## Interaction Rules

- 폴더는 더블클릭/Enter로 창에서 연다. 파일은 지원 형식이면 미리보기 창으로 열고, 지원하지 않으면 내려받는다. 우클릭 메뉴에서는 미리보기와 다운로드를 따로 고를 수 있다.
- 한 번 클릭은 선택만 한다. 빈 공간 클릭은 선택을 푼다.
- 우클릭 메뉴는 선택한 대상 또는 바탕화면에 맞는 동작만 보여 준다.
- 드래그가 끝났을 때만 공유 위치를 저장하고, 다른 사용자의 변경은 조용히 다시 불러온다.
- 업로드 중에는 파일명과 전체 진행 개수를 작업표시줄 위에 보여 준다.
- 화면 오른쪽 아래에 고정된 휴지통을 누르면 휴지통 창이 열린다. 작업표시줄에는 휴지통 버튼을 두지 않는다.
- 빈 폴더에 사람을 흉내 내는 안내 문구를 놓지 않는다. 폴더 메모지와 새 폴더·텍스트 문서 작업을 직접 보여 준다.

## Safe Choices and Deliberate Risks

- **Safe:** 아이콘, 작업표시줄, 제목줄, 더블클릭, 우클릭이라는 익숙한 데스크톱 문법을 그대로 쓴다.
- **Safe:** 삭제는 기존 확인 단계를 유지하고 업로드/다운로드 동작도 바꾸지 않는다.
- **Risk:** 회색 Windows 95 복각 대신 포근한 해 질 녘 작업실을 써서 제품 고유의 장소감을 만든다. 대신 배경 디테일은 아이콘 영역 밖으로 제한한다.
- **Risk:** 한글 픽셀 글꼴을 전면 사용한다. 대신 긴 설명은 크기와 줄 간격을 올려 읽기 어려움을 막는다.

## Decisions Log

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-08-10 | Dusk Room OS를 초기 디자인 방향으로 채택 | 사용자가 요청한 도트 스타일과 실제 파일 작업의 읽기 쉬움을 함께 살리기 위해 |
| 2026-08-10 | 배경은 생성 에셋, 아이콘과 창은 코드로 제작 | 배경은 감성을 높이고 조작 요소는 흐려짐 없이 선명하게 유지하기 위해 |
| 2026-08-12 | 휴지통을 작업표시줄 밖의 화면 오른쪽 아래에 고정 | 파일 작업 버튼과 휴지통을 구분하고 익숙한 데스크톱 배치를 따르기 위해 |
