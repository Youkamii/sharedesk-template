# 위젯 껍데기 — 배치 모드 설계 기록

개발자용 문서다. 사용자 안내는 [docs/WIDGET.ko.md](../docs/WIDGET.ko.md)에 있다.
위젯 창을 화면 어디에 어떻게 둘지 정하는 **배치 모드 셋**의 정의, 사용자 기대, OS별 구현과 실측 결과를 적는다.
맥에서 작업할 사람이 이 문서만 보고 Windows와 같은 효과를 낼 수 있게 쓰는 것이 목적이다.

## 배치 모드 셋

위젯은 늘 셋 중 하나다. 서랍/창가(화면 내용)와는 따로 논다.

| 모드 | 사용자 기대 | 켜고 끄는 곳 | 상태 원본 |
| --- | --- | --- | --- |
| 떠 있기 (기본) | 다른 창 위에 늘 보인다. 트레이 `항상 위`를 끄면 보통 창처럼 다른 창에 가려진다. | 트레이 `항상 위` | 껍데기 설정 `alwaysOnTop` (프로필별) |
| 벽 붙임 (#28) | 화면 좌우 가장자리에 숨어 작은 손잡이만 남는다. 손잡이에 커서를 대면 펼쳐지고, 떠나면 접힌다. 손잡이가 보여야 하므로 켜진 동안 껍데기가 항상 위를 보장한다(트레이 `항상 위` 설정값과 상관없이, 끄면 그 값으로 돌아간다). | 머리띠 `벽` | 페이지 localStorage `sharedesk.widget-wall` (데스크 원점별). 껍데기는 기억하지 않고, 페이지가 로드될 때마다 다시 켜 달라고 한다. |
| 압정 (#30) | 바탕화면에 압정으로 꽂은 메모처럼 **다른 창 뒤, 바탕화면 위**에 머문다. 위젯을 눌러도 앞으로 나오지 않는다. 다른 창을 치우면 그 자리에 있다. | 머리띠 `압정` | 껍데기 설정 `pinned` (프로필별, 기본 false) |

### 전환 규칙

- **벽 붙임과 압정은 함께 켜지지 않는다.** 머리띠 단추를 누르면 페이지가 `placementSteps`(src/lib/client/widget.ts)의 차례대로 처리한다: 켜려는 쪽의 반대편을 먼저 끄고 켠다. 벽을 끌 때는 `set_wall_mode(false)`의 응답을 기다린 뒤 `set_pinned(true)`를 부른다.
- 껍데기도 방어한다.
  - 벽 붙임이 켜진 채 `set_pinned(true)`가 오면 "벽 붙임을 먼저 끄세요"로 거절한다(페이지는 벽을 먼저 끄므로 정상 경로에는 영향이 없다).
  - 압정인 채로 `set_wall_mode(true)`가 오면 **벽에 붙이는 데 성공한 뒤에** 압정을 풀고 페이지에 `sharedesk:widget-pinned`(detail `false`)를 쏜다. 붙이기에 실패하면 압정은 그대로 두고 Err — 압정도 벽도 아닌 상태가 되지 않는다. 다른 데스크 주소로 바꿨더니 그 원점의 localStorage에는 벽이 켜져 있던 경우 같은, 페이지 순서를 거치지 않은 요청을 막는다.
  - 트레이 `항상 위`는 압정 중에 꺼진 것으로 보인다(`alwaysOnTop && !pinned`). 누르면 압정을 먼저 풀고 항상 위로 돌아가며, 같은 이벤트로 페이지 단추를 맞춘다. 트레이에 압정 항목은 없다.
- 창의 z 플래그는 한 규칙 `settings::z_flags(벽, 압정, alwaysOnTop)`으로 정한다: 벽 붙임 → 항상 위, 압정 → 맨 아래, 둘 다 아니면 `alwaysOnTop`. `apply_z`가 두 플래그가 함께 켜지지 않는 순서로 적용한다(맨 아래로 갈 때는 항상 위를 먼저 내리고, 아닐 때는 맨 아래를 먼저 푼다).
- `alwaysOnTop`과 `pinned`는 별개 값이다. 압정을 켜도 `alwaysOnTop`은 그대로 남고, 압정을 풀면 그 값으로 돌아간다. 둘 다 설정 파일에서 타입이 틀리면 그 항목만 기본값(`true`·`false`)으로 읽는다.
- `set_pinned`는 적용 뒤의 실제 상태를 돌려준다. 창에 먼저 적용하고 성공해야 설정에 적으며, 같은 값이면 디스크·z순서·트레이를 건드리지 않는다.
- 페이지의 압정 상태는 셋이다: `"unknown"`(껍데기가 아직 답하기 전 — `압정` 단추를 잠근다), `"unsupported"`(껍데기가 없거나 옛 껍데기), 껍데기가 알려 준 `true`/`false`. 옛 껍데기(0.2.0 이하)는 `widget_placement`가 없다 — 거절 문구(`not found|not allowed`, 벽 붙임의 `isUnsupportedCommandError`와 같은 판정)를 보고 `"unsupported"`로 두고, 단추를 누르면 아무것도 바꾸지 않고 "위젯을 업데이트하면 압정을 쓸 수 있습니다"만 알린다.
- 압정은 페이지가 바뀌어도(로그인 화면 포함) 유지된다. 벽 붙임은 새 문서가 로드되기 시작하면 껍데기가 푼다(`on_page_load` → `reset_wall`).

## 관련 파일·명령·설정 키

| 종류 | 이름 | 위치 |
| --- | --- | --- |
| 껍데기 명령 | `widget_placement` → 지금 압정 여부(bool), `set_pinned(enabled)` → 적용 뒤 실제 상태(bool) | `src-tauri/src/lib.rs` "압정" 절 |
| 껍데기 명령 | `set_wall_mode(enabled)` → 붙인 벽, `set_wall_zone(zone)` | `src-tauri/src/lib.rs` "벽 붙임" 절, `src-tauri/src/wall.rs` |
| 껍데기 명령 | `hide_widget` (첫 실행 주소 화면 `src/index.html`과 옛 데스크 머리띠가 부른다) | `src-tauri/src/lib.rs` |
| 권한 | 데스크 페이지(`remote.json`): `allow-hide-widget`, `allow-set-wall-mode`, `allow-set-wall-zone`, `allow-widget-placement`, `allow-set-pinned`. 로컬 페이지(`default.json`, 첫 실행 주소 화면·부팅 화면): 그 페이지들이 부르는 것만 — 창 끌기, `allow-hide-widget`, `allow-save-desk-url`, `allow-widget-info` | `src-tauri/build.rs`, `src-tauri/capabilities/{default,remote}.json` |
| 원점 검사 | 원격 capability는 모든 http(s) 원점에 열려 있으므로, 원격에 연 명령은 명령 안에서 `require_page`로 호출 웹뷰의 지금 주소를 다시 거른다. 벽 붙임·압정 명령은 저장된 데스크 원점만, `hide_widget`은 데스크 원점 또는 껍데기 로컬 페이지(스킴·호스트·포트가 `local_page_url`과 같음)만 받는다 | `src-tauri/src/lib.rs` |
| 설정 파일 | `settings.json`의 `alwaysOnTop`, `pinned`, `window` | 프로필 폴더(`%APPDATA%\com.youkamii.sharedesk-widget\profiles\<프로필>`), `src-tauri/src/settings.rs` |
| 페이지 저장 | localStorage `sharedesk.widget-wall`, `sharedesk.widget-mode` | `src/lib/client/widget.ts` |
| 껍데기 → 페이지 이벤트 | `sharedesk:widget-pinned`, `sharedesk:wall-hover`, `sharedesk:wall-side`, `sharedesk:widget-visibility` | `lib.rs`의 `PINNED_EVENT`, `wall.rs`의 `HOVER_EVENT`·`SIDE_EVENT` ↔ `widget.ts`의 같은 이름 상수 |
| 화면 | 머리띠 단추 `서랍` `창가` \| `벽` `압정` | `src/app/widget/WidgetView.tsx` |
| 순수 함수 | `widgetPlacement`, `placementSteps`, `readWidgetPinned`, `setWidgetPinned` | `src/lib/client/widget.ts`, 테스트 `tests/widget.test.ts` |

## OS별 구현

### Windows (구현·실측됨)

| 모드 | 구현 |
| --- | --- |
| 떠 있기 | `set_always_on_top(true)` → `HWND_TOPMOST` (`WS_EX_TOPMOST`) |
| 벽 붙임 | 창을 좌우 벽에 붙이고(`wall::snap_position`), 페이지가 내용을 벽 너머로 민다. 껍데기 폴링 스레드가 25ms마다 커서를 보고(`cursor_position`) 펼침·접힘을 정한다. 접힌 동안 `set_ignore_cursor_events(true)`로 클릭을 뒤 창에 넘기고, 켜진 동안 `set_shadow(false)`로 창 그림자 윤곽을 없앤다. 머리띠로 옮기는 중인지는 `GetAsyncKeyState(VK_LBUTTON)`로 본다. |
| 압정 | 켜기: `set_always_on_top(false)` → `set_always_on_bottom(true)`. 끄기: `set_always_on_bottom(false)` → `set_always_on_top(z_flags의 값)`. 두 플래그가 함께 켜지는 순간이 없게 이 순서를 지킨다(`apply_z`). 시작 때 압정이면 창 빌더에 `.always_on_top(alwaysOnTop && !pinned).always_on_bottom(pinned)`를 주어 만들 때부터 맨 아래다(tao가 생성 때 같은 플래그를 세운다). |

압정이 버티는 이유 (tao 0.37.1): `set_always_on_bottom(true)`는 창 상태에 `ALWAYS_ON_BOTTOM` 플래그를 세우고 `SetWindowPos(HWND_BOTTOM)`을 부른다(`platform_impl/windows/window_state.rs:341`). 그리고 `WM_WINDOWPOSCHANGING`에서 이 플래그가 있으면 `hwndInsertAfter`를 늘 `HWND_BOTTOM`으로 바꾼다(`platform_impl/windows/event_loop.rs:1140`). 그래서 창을 눌러 활성화하거나 트레이로 숨겼다 보이며 `set_focus`를 불러도 맨 아래에 남는다. 같은 값을 다시 적용하면 플래그 차이가 없어 아무 일도 하지 않으므로, 보이기 뒤 재적용은 넣지 않았다(실측으로 필요 없음을 확인).

#### Windows 실측 (2026-10-01, Windows 11 Pro 26200, 디버그 껍데기 0.3.0)

판정은 Win32로 했다: `WS_EX_TOPMOST` 여부, 최상위 창 Z순서의 위치, 그 창 아래에 보이는 최상위 창 수, 겹친 점의 `WindowFromPoint` 주인, 캡처.

| 확인 | 결과 |
| --- | --- |
| 압정 켜기 | `WS_EX_TOPMOST` 꺼짐, Z순서 22번째 → 517~525번째, 아래에 보이는 최상위 창은 바탕화면(Progman) 하나뿐 |
| 탐색기를 위젯 위로 활성화 | 겹친 점의 주인이 탐색기 — 위젯이 뒤로 간다 |
| 가려지지 않은 위젯 부분을 클릭 | 위젯이 포그라운드가 되지만(100ms 뒤) 여전히 탐색기 아래, 1초 뒤에도 그대로 |
| 압정 끄기 | 다시 `WS_EX_TOPMOST`, 탐색기를 활성화해도 위젯이 위 |
| 압정인 채 종료 후 재시작 (빌더 플래그로 다시 잼, `alwaysOnTop=true`) | 처음 관찰부터 `WS_EX_TOPMOST` 꺼짐, 아래에 보이는 창은 바탕화면 하나, 머리띠 `압정` 눌림(페이지가 `widget_placement`로 읽음) |
| 압정인 채 트레이 메뉴로 숨기기 → 보이기 | 보인 직후 포그라운드지만 맨 아래 유지, 탐색기 아래 |
| 압정 중 `벽` 누르기 | `pinned=false`, 항상 위, 오른쪽 벽에 붙어 접힘(클릭 투과) |
| 트레이 `항상 위`를 끈 채(`alwaysOnTop=false`) 벽 붙임 켜기 → 끄기 | 켜진 동안 `WS_EX_TOPMOST`(보장), 끄면 다시 꺼짐(설정값으로 복원) |
| 벽 붙임 중 `압정` 누르기 | 벽 붙임 해제(투과 꺼짐, 커서가 떠나도 펼친 채), 맨 아래 |
| 압정 중 트레이 `항상 위` 누르기 | 압정 해제, 항상 위, 페이지 `압정` 단추도 꺼짐(`sharedesk:widget-pinned`) |
| 압정 중 바탕화면 빈 곳 클릭 | 위젯이 바탕화면 위에 그대로 보인다 |
| 압정 중 Win+D | **숨는다** (아래 "바탕화면 보기" 절) |
| 떠 있기 중 Win+D | 그대로 보인다 |

참고: 같은 순서를 다섯 번 돌렸는데, 첫 회차에 "압정 끄기" 클릭이 한 번 반영되지 않았다(설정 `pinned`가 그대로). 원인은 확인하지 못했고 이후 네 번은 모두 정상이었다.

### macOS (실측 2026-10-06 — macOS 27.0.1 arm64, 디버그 껍데기 0.3.0, tauri 2.12·tao 0.37.1·wry 0.57)

판정은 `CGWindowListCopyWindowInfo`의 창 레벨(`kCGWindowLayer`: 보통 창 0, tao의 항상 위 5, 맨 아래 −1)과 위치, 접근성 API(`background only`), 캡처로 했다. 데스크는 로컬 모드 `next dev`로 띄웠다 — `next start`는 세션 쿠키에 `Secure`가 붙어 http://localhost 로그인이 위젯 안에서 되지 않는다.

| 확인 | 결과 |
| --- | --- |
| 시작 직후 떠 있기 | **고친 뒤** 레벨 5. 고치기 전에는 0이었다 — 빌더의 `always_on_top`이 생성된 창에 남지 않는다(`build` 직후 `is_always_on_top` false, Accessory 정책과 무관). 창을 띄운 직후 `apply_z`로 한 번 다시 건다(`build_main_window`) |
| 압정 켜기 (머리띠) | 레벨 −1, 앞에 있던 터미널 창 뒤로 들어간다. 가려진 부분은 아예 눌리지 않는다(뒤 창이 받는다) — 풀려면 보이는 부분을 누르거나 트레이 `항상 위` |
| 압정인 채 종료 후 재시작 | 처음부터 레벨 −1 |
| 압정 중 트레이 `항상 위` | 압정 해제, 레벨 5, 설정 `pinned=false`·`alwaysOnTop=true` |
| 벽 붙임 켜기 | 오른쪽 벽에 붙는다(x 1572→1580 = 작업영역 폭 1920 − 340, 바깥·안쪽 여백 0). 내용이 벽 너머로 밀리고 손잡이만 남으며 빈 자리는 뒤 창이 비친다 |
| 손잡이에 커서 | 펼쳐지고 머리띠 `벽`이 눌린 표시. 커서가 떠나면 유예 뒤 접힌다 |
| 벽 붙임 끄기 | 펼친 채 그 자리에 남는다 |
| 서랍에서 파일 더블클릭 | `~/Downloads/<이름>`에 저장되고 "Saved <이름>" 알림(아래 `on_download`) |
| 트레이 | 메뉴 막대 상태 항목, 우클릭 메뉴가 OS 언어(한국어)로 뜬다. Accessory 정책으로 Dock 아이콘 없음(`background only` true) |
| 처음 실행 → 부팅 → 데스크 | `tauri://localhost/boot.html`에서 쿠키를 심고 `/files`로 가면 서버가 위젯 변형(로그인 카드·서랍)을 그린다 |

맥에서 눈에 띄는 점:

- 위젯이 활성 앱이 아닐 때 첫 클릭은 앱을 활성화하는 데 쓰이고 단추에는 닿지 않는다(WKWebView가 first mouse를 받지 않는다). 두 번째 클릭부터 듣는다.
- 맥 내려받기는 전송 목록에 오르지 않아 손잡이 게이지·전송 바에 보이지 않는다.
- 미실측: Spaces 전환·Mission Control·바탕화면 보기(핫코너/F11)에서의 압정, 배율이 다른 보조 모니터, 드롭 업로드, 끌어내기(DownloadURL을 WKWebView가 모르므로 아무 일 없음 — 코드로 안다).

구현 메모 — 코드가 tao의 어떤 호출로 떨어지는가:

| 모드 | 맞춰야 하는 것 |
| --- | --- |
| 떠 있기 | tao `set_always_on_top(true)` → `NSWindow.level`을 올린다(tao 0.37.1 `platform_impl/macos/window.rs`, 값은 `ffi.rs`의 `NSFloatingWindowLevel`). 다른 앱의 보통 창 위에 뜨는지 확인. |
| 벽 붙임 | `set_ignore_cursor_events` → `setIgnoresMouseEvents:`(tao). 투명 창이 마우스를 무시하는 동안에도 폴링 스레드의 `cursor_position`이 계속 커서를 주는지, `set_shadow(false)`가 맥에서 그림자 윤곽을 없애는지, `work_area`가 메뉴 막대·Dock을 빼고 주는지, Retina 배율에서 손잡이 영역 좌표가 맞는지 실측이 필요하다. 주 버튼 상태는 `CGEventSourceButtonState`로 이미 본다(`wall.rs` `primary_button_down`). |
| 압정 | tao `set_always_on_bottom(true)` → 창 레벨 `BelowNormalWindowLevel`(tao `ffi.rs:69`, 값 −1, `set_level_async`로 적용). 보통 창(레벨 0) 아래이고 바탕화면 아이콘 레벨(`kCGDesktopIconWindowLevel`, 큰 음수)보다는 위라 "다른 창 뒤, 바탕화면 아이콘 위"가 될 것으로 추정한다. 끄기는 `set_always_on_bottom(false)`(보통 레벨) 뒤 `set_always_on_top(alwaysOnTop)`. |

맥에서만 더한 것(2026-10-06, `#[cfg(target_os = "macos")]`라 Windows 빌드에는 들어가지 않는다):

- **내려받기** — WKWebView에는 저장 대화상자(`showSaveFilePicker`)가 없어 페이지가 `<a download>`로 떨어지는데, wry 0.57은 내려받기 핸들러가 없으면 그 요청을 취소한다(`wkwebview/navigation.rs`). 껍데기가 `on_download`로 받아 wry가 정한 `~/Downloads/<이름>`(겹치면 ` (n)`)에 저장하고, 끝나면 `sharedesk:widget-download`(detail `{success, name}`)로 페이지에 알린다 — 맥의 Finished 이벤트에는 경로가 비어 있어 요청 때의 경로를 주소별로 적어 둔다. Windows(WebView2)는 페이지가 저장 대화상자로 직접 받으므로 핸들러를 달지 않는다(달면 WebView2의 기본 내려받기 표시가 사라진다). 맥 내려받기는 전송 목록에 오르지 않아 손잡이 게이지·전송 바에는 보이지 않는다.
- **트레이 앱** — `skip_taskbar`는 Windows·Linux 전용이라 맥에서는 Dock·Cmd+Tab에 보통 앱처럼 나왔다(접근성 API `background only: false`로 실측). `set_activation_policy(Accessory)`로 Dock 아이콘 없이 트레이에만 둔다.
- **시작 때 z 플래그 다시 걸기** — 빌더의 `always_on_top`·`always_on_bottom`이 생성된 창의 레벨에 남지 않아(위 표) 창을 띄운 직후 `apply_z(settings.pinned)`를 한 번 부른다. Windows는 빌더 플래그가 그대로 서므로 건드리지 않는다.

맥에서 압정에 기대하는 추가 동작 — 지금 코드에는 없다:

- **Spaces 전환 때 모든 데스크톱에 보이기**: `NSWindowCollectionBehaviorCanJoinAllSpaces`. Tauri에 `WebviewWindow::set_visible_on_all_workspaces(true)`가 있다(tao가 collectionBehavior에 OR한다).
- **Mission Control·바탕화면 보기(F11, 핫코너)에서 제자리 유지**: `NSWindowCollectionBehaviorStationary`(`1 << 4`). Tauri API가 없으므로 `window.ns_window()`로 `NSWindow` 포인터를 얻어 `collectionBehavior`에 OR해 `setCollectionBehavior:`를 부른다(objc2 같은 의존성이 필요하다). 압정을 풀 때 이 비트를 다시 빼야 한다.
- 위젯을 누르면 앱이 활성화되지만 창 레벨이 낮으므로 다른 앱 창 위로 올라오지 않을 것으로 추정한다 — 실측 필요.
- 압정 중 `Cmd+Tab`으로 위젯 앱을 골라도 앞으로 나오지 않는지 실측 필요(Windows는 클릭 활성화로 확인했다).

## 바탕화면 보기 (Windows Win+D / 맥 핫코너·F11)

- 사용자 기대: 압정은 "바탕화면에 붙어 있는" 모드이므로, 바탕화면 보기를 해도 바탕화면 위에 남아 있기를 기대할 수 있다.
- **Windows 실측: 압정 위젯은 Win+D에서 숨는다.** 최소화되는 것은 아니다(`IsIconic` 거짓, `IsWindowVisible` 참). 셸이 바탕화면 창(Progman)을 올려 그 아래로 가려지고, 위젯 가운데 점의 주인이 `Program Manager`가 된다. Win+D를 한 번 더 누르면 돌아온다. 떠 있기(항상 위)는 Win+D에도 그대로 보인다.
- 벽 붙임(항상 위)은 떠 있기와 같이 남을 것으로 추정한다 — 미실측.
- 맥: 위의 `Stationary`를 더하면 바탕화면 보기에서도 제자리에 남는 것이 기대 동작이다 — 미구현·미실측.
- Windows에서 Win+D에도 남게 하려면 바탕화면 창(WorkerW) 아래로 붙이거나, 바탕화면 보기를 감지해 다시 올리는 식의 별도 작업이 필요하다. 지금은 하지 않았다.

## 미실측 항목

- macOS: 위 macOS 절의 "미실측" 줄(Spaces·Mission Control·바탕화면 보기, 보조 모니터, 드롭 업로드).
- Windows: 벽 붙임 중 Win+D, 배율이 다른 모니터·보조 모니터에서의 압정, 가상 데스크톱 전환(Win+Ctrl+←/→) 때 압정, 압정으로 대부분 가려진 동안 WebView2가 `document.hidden`을 바꿔 주기 확인 간격이 달라지는지, 압정 중 보이는 부분에 파일을 끌어 놓는 업로드.
