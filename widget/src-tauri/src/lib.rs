//! ShareDesk 위젯 껍데기.
//!
//! 화면은 전부 데스크(웹)가 그린다. 이 껍데기가 하는 일은 넷뿐이다:
//! 1. 프로필 폴더마다 쿠키 저장소와 데스크 주소를 분리해 창 하나를 띄운다.
//! 2. 데스크 원점에 `sharedesk_widget` 쿠키를 심어 서버가 위젯 화면을 그리게 한다.
//!    (사용자 에이전트를 통째로 바꾸면 브라우저 버전 문자열을 꾸며 내야 해서
//!    구글 로그인 쪽 판정을 건드릴 수 있다 — 쿠키는 데스크 원점에만 간다.)
//! 3. 트레이·항상 위·부팅 시 실행·창 위치 기억 같은 바탕화면 살림을 맡는다.
//! 4. 새 창 요청(target=_blank)은 기본 브라우저로 넘기고, 껍데기 자체는
//!    공개 템플릿 저장소의 고정 릴리스를 보고 갱신한다.
//!
//! 배치 토글 "벽 붙임"(#28)은 페이지가 켜고 끄며, 껍데기는 벽에 붙이기·커서 판정·클릭 투과만 맡는다
//! (wall.rs와 아래 "벽 붙임" 절). "압정"(#30)은 껍데기 설정이 원본이고 페이지가 set_pinned로 켜고 끈다
//! (아래 "압정" 절). 배치 모드 셋의 설계와 OS별 구현은 widget/README.md에 있다.

mod locale;
mod settings;
mod wall;

use std::error::Error;
use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::cookie::{time::Duration as CookieDuration, Cookie, SameSite};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, LogicalSize, Manager, PhysicalPosition, PhysicalSize, RunEvent, Url, Webview,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_opener::OpenerExt as _;
use tauri_plugin_updater::UpdaterExt as _;

use settings::Settings;

/// 서버(src/lib/widget-mode.ts)가 읽는 쿠키 이름. 값은 껍데기 버전이다.
pub const WIDGET_COOKIE: &str = "sharedesk_widget";
const MAIN_WINDOW: &str = "main";
const TRAY_ID: &str = "main";
const DEFAULT_SIZE: (f64, f64) = (340.0, 520.0);
const MIN_SIZE: (f64, f64) = (260.0, 320.0);
const SCREEN_MARGIN: i32 = 16;
const COOKIE_MAX_AGE_DAYS: i64 = 400;
const STARTUP_UPDATE_CHECK_DELAY: Duration = Duration::from_secs(90);
// 데스크 페이지가 window.open을 남발해도 기본 브라우저 창이 쏟아지지 않게
const EXTERNAL_OPEN_MIN_GAP: Duration = Duration::from_secs(1);
// 벽 붙임: 켜져 있고 창이 보이면 25ms마다 커서를 보고, 아니면 250ms마다 표식만 본다
const WALL_POLL: Duration = Duration::from_millis(25);
const WALL_IDLE_POLL: Duration = Duration::from_millis(250);

pub struct Profile {
    pub name: String,
    pub dir: PathBuf,
    // 같은 프로필을 두 번 띄우면 WebView2가 같은 데이터 폴더를 두고 다투므로 잠근다
    _lock: File,
}

pub struct WidgetState {
    pub profile: Profile,
    pub settings: Mutex<Settings>,
    pending_update: Mutex<Option<tauri_plugin_updater::Update>>,
    update_status: Mutex<Option<String>>,
    update_url: Option<String>,
    last_external_open: Mutex<Option<Instant>>,
    lang: locale::Lang,
    wall: Mutex<WallState>,
}

/// 벽 붙임의 껍데기 쪽 상태. 원본은 페이지의 localStorage이고, 페이지가 로드될 때마다
/// set_wall_mode(true)를 다시 부르므로 여기서는 저장하지 않는다.
#[derive(Default)]
struct WallState {
    enabled: bool,
    /// 페이지가 알린 "마우스를 받아야 하는 영역"
    zone: Option<wall::Zone>,
    side: Option<wall::Side>,
    /// 폴링 스레드가 판정한 펼침 여부 — 클릭 투과는 enabled && !expanded일 때만
    expanded: bool,
    /// 껍데기가 마지막으로 붙인 바깥 좌표. 이 좌표로 오는 Moved는 자기 되먹임이다.
    target: Option<PhysicalPosition<i32>>,
    /// 사용자가 창을 옮긴 마지막 시각 — wall::SETTLE이 지나고 버튼을 놓으면 폴링 스레드가 다시 붙인다
    moved_at: Option<Instant>,
    /// 켜기·끄기·페이지 로드마다 올린다. 폴링 스레드는 번호가 바뀌면 호버 판정을 접힌 상태에서
    /// 새로 시작하고, 그사이 계산한 옛 판정은 버린다.
    epoch: u64,
    /// 그림자를 끄기 전의 틀 두께(바깥 − 안쪽, 잰 때의 배율로 나눈 논리값). 켜진 동안 창 크기를
    /// 적을 때 지금 배율을 곱해 뺀다.
    frame: LogicalSize<f64>,
}

impl WidgetState {
    fn settings(&self) -> Settings {
        self.settings.lock().expect("settings lock").clone()
    }

    fn update_settings(&self, change: impl FnOnce(&mut Settings)) {
        let mut guard = self.settings.lock().expect("settings lock");
        change(&mut guard);
        if let Err(error) = settings::save(&self.profile.dir, &guard) {
            eprintln!("설정 저장 실패: {error}");
        }
    }

    /// 저장된 데스크 주소의 원점(스킴+호스트+포트). 없으면 None.
    fn desk_origin(&self) -> Option<String> {
        let desk = self.settings().desk_url?;
        Url::parse(&desk).ok().map(|url| url.origin().ascii_serialization())
    }
}

pub fn run() {
    let args: Vec<String> = std::env::args().collect();
    let profile_name = settings::profile_name_from_args(&args);
    let preset_desk = settings::desk_url_from_args(&args);
    // `--update-url 주소`: 발행 전 점검용. 서명 검증은 그대로라 우리 키로 서명되지 않은 갱신은 거부된다.
    let update_url = settings::update_url_from_args(&args);
    // `--install-update-now`: 점검용. 확인 직후 새 버전이 있으면 트레이 클릭 없이 바로 설치한다.
    let install_now = args.iter().any(|arg| arg == "--install-update-now");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--profile", profile_name.as_str()])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            save_desk_url,
            widget_info,
            hide_widget,
            set_wall_mode,
            set_wall_zone,
            widget_placement,
            set_pinned
        ])
        .setup(move |app| {
            let profile = open_profile(app.handle(), &profile_name)?;
            let mut loaded = settings::load(&profile.dir);
            if let Some(preset) = preset_desk.as_deref() {
                match settings::normalize_desk_url(preset) {
                    Ok(url) => loaded.desk_url = Some(url),
                    Err(reason) => eprintln!("--desk 주소를 쓸 수 없습니다 ({reason})"),
                }
            }
            let state = WidgetState {
                profile,
                settings: Mutex::new(loaded),
                pending_update: Mutex::new(None),
                update_status: Mutex::new(None),
                update_url,
                last_external_open: Mutex::new(None),
                lang: locale::Lang::detect(),
                wall: Mutex::new(WallState::default()),
            };
            app.manage(state);

            let window = build_main_window(app.handle())?;
            enter_desk(&window)?;
            build_tray(app.handle())?;
            spawn_wall_watcher(app.handle().clone());

            // dev 빌드는 서명된 릴리스가 아니므로 시작 시 자동 확인을 건너뛴다 (주소를 명시하면 점검 의도로 본다)
            let explicit_update_url = app.state::<WidgetState>().update_url.is_some();
            if !cfg!(debug_assertions) || explicit_update_url {
                let handle = app.handle().clone();
                let delay = if explicit_update_url {
                    Duration::from_secs(3)
                } else {
                    STARTUP_UPDATE_CHECK_DELAY
                };
                tauri::async_runtime::spawn(async move {
                    sleep_off_thread(delay).await;
                    check_update(handle.clone(), false).await;
                    if install_now {
                        install_pending_update(handle).await;
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // 닫기 = 트레이로 숨김. 완전 종료는 트레이 메뉴의 "종료"뿐이다.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                hide_main_window(window.app_handle());
            }
            // 포커스를 잃을 때 위치를 적는다. 여기서 트레이 메뉴를 다시 만들지 않는다 —
            // 포커스가 들어오는 순간(머리띠를 누른 직후)에 메뉴를 갈아 끼우면 창 끌기가 끊긴다(실측).
            // 숨기기·보이기는 hide_main_window/show_main_window가 트레이를 맞춘다.
            WindowEvent::Focused(false) => remember_window_rect(window.app_handle()),
            // 벽 붙임 중 머리띠로 옮기면 멎은 뒤 가까운 벽에 다시 붙인다 (폴링 스레드가 처리)
            WindowEvent::Moved(_) => note_wall_move(window),
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("위젯을 시작하지 못했습니다")
        .run(|app, event| {
            if let RunEvent::ExitRequested { .. } = event {
                remember_window_rect(app);
            }
        });
}

/// 비동기 문맥에서 잠깐 기다린다 — blocking 풀의 스레드 하나를 그 시간만큼 빌린다
/// (tokio time 기능을 직접 의존하지 않기 위해; 시작 때 한 번뿐이라 충분하다).
async fn sleep_off_thread(duration: Duration) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(duration))
        .await
        .ok();
}

// ── 프로필 ─────────────────────────────────────────────────────────────────

fn open_profile(app: &AppHandle, name: &str) -> Result<Profile, Box<dyn Error>> {
    let dir = app
        .path()
        .app_data_dir()?
        .join("profiles")
        .join(name);
    fs::create_dir_all(&dir)?;
    let lock = acquire_profile_lock(&dir).map_err(|reason| {
        format!("프로필 '{name}'을(를) 열 수 없습니다: {reason}")
    })?;
    Ok(Profile {
        name: name.to_string(),
        dir,
        _lock: lock,
    })
}

fn acquire_profile_lock(dir: &Path) -> Result<File, String> {
    let file = File::options()
        .create(true)
        .write(true)
        .truncate(false)
        .open(dir.join("widget.lock"))
        .map_err(|error| error.to_string())?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(std::fs::TryLockError::WouldBlock) => {
            Err("이미 실행 중입니다 (같은 프로필)".to_string())
        }
        Err(std::fs::TryLockError::Error(error)) => Err(error.to_string()),
    }
}

/// macOS는 데이터 폴더 대신 16바이트 식별자로 저장소를 나눈다 — 프로필 이름의 FNV-1a 해시.
#[cfg(target_os = "macos")]
fn data_store_id(profile: &str) -> [u8; 16] {
    let mut out = [0u8; 16];
    for (index, chunk) in out.chunks_mut(8).enumerate() {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325 ^ (index as u64);
        for byte in profile.bytes() {
            hash ^= byte as u64;
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        chunk.copy_from_slice(&hash.to_le_bytes());
    }
    out
}

// ── 창 ─────────────────────────────────────────────────────────────────────

fn build_main_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let state = app.state::<WidgetState>();
    let settings = state.settings();
    // 데스크 주소가 있으면 빈 부팅 페이지에서 쿠키를 심은 뒤 데스크로 넘어간다.
    // 처음부터 데스크 주소로 열면 첫 요청이 쿠키 없이 나가 웹 화면이 그려진다.
    let start = if settings.desk_url.is_some() {
        "boot.html"
    } else {
        "index.html"
    };
    let opener_handle = app.clone();
    let navigation_handle = app.clone();
    let (width, height) = settings
        .window
        .map(|rect| (rect.logical_width, rect.logical_height))
        .filter(|(w, h)| w.is_finite() && h.is_finite() && *w >= MIN_SIZE.0 && *h >= MIN_SIZE.1)
        .unwrap_or(DEFAULT_SIZE);
    let mut builder = WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App(start.into()))
        .title("ShareDesk Widget")
        .decorations(false)
        .transparent(true)
        .skip_taskbar(true)
        .resizable(true)
        // 압정이면 항상 위로 만들지 않는다 — 만든 뒤 apply_pinned가 맨 아래에 고정한다
        .always_on_top(settings.always_on_top && !settings.pinned)
        .visible(false)
        .inner_size(width, height)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        // Windows에서 HTML5 드롭(파일 업로드)을 받으려면 껍데기의 드롭 처리를 꺼야 한다
        .disable_drag_drop_handler()
        // 웹뷰가 갈 수 있는 곳은 웹 페이지와 껍데기 로컬 페이지뿐 — 파일을 떨어뜨려도 file://로 가지 않는다
        .on_navigation(move |url| {
            let allowed = matches!(url.scheme(), "http" | "https" | "tauri" | "about");
            if !allowed {
                eprintln!("[nav] 막음: {url}");
                let _ = &navigation_handle;
            }
            allowed
        })
        // target=_blank·window.open은 기본 브라우저로 — 위젯 안에 두 번째 창을 만들지 않는다.
        // 데스크 원점의 주소만, 초당 한 번만 연다 (악성·오작동 페이지의 브라우저 창 폭주 방지).
        .on_new_window(move |url, _features| {
            open_external(&opener_handle, url.as_str());
            NewWindowResponse::Deny
        })
        // 새 문서가 로드되기 시작하면 벽 붙임을 푼다. 벽 붙임을 아는 화면(데스크)은 로드되며
        // 다시 켜고, 모르는 화면(로그인·첫 실행 주소 입력)이 투과된 채 클릭을 못 받는 일이 없게.
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Started {
                reset_wall(window.app_handle());
            }
        });
    #[cfg(any(windows, target_os = "linux"))]
    {
        builder = builder.data_directory(state.profile.dir.join("webview"));
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder.data_store_identifier(data_store_id(&state.profile.name));
    }
    let window = builder.build()?;

    match settings.window {
        Some(rect) => {
            let _ = window.set_position(PhysicalPosition::new(rect.x, rect.y));
            ensure_on_screen(&window);
        }
        None => position_bottom_right(&window),
    }
    if settings.pinned {
        apply_pinned(&window, true);
    }
    let _ = window.show();
    Ok(window)
}

/// 데스크 주소가 있으면 위젯 쿠키를 심고 /files로 간다. 없으면 첫 실행 화면 그대로.
fn enter_desk(window: &WebviewWindow) -> Result<(), Box<dyn Error>> {
    let state = window.state::<WidgetState>();
    let Some(desk) = state.settings().desk_url else {
        return Ok(());
    };
    let desk_url = Url::parse(&desk)?;
    plant_widget_cookie(window, &desk_url)?;
    window.navigate(Url::parse(&format!("{desk}/files"))?)?;
    Ok(())
}

fn plant_widget_cookie(window: &WebviewWindow, desk: &Url) -> Result<(), Box<dyn Error>> {
    let host = desk.host_str().ok_or("데스크 주소에 호스트가 없습니다")?;
    let cookie = Cookie::build((WIDGET_COOKIE, env!("CARGO_PKG_VERSION")))
        .domain(host.to_string())
        .path("/")
        .secure(desk.scheme() == "https")
        .http_only(false)
        .same_site(SameSite::Lax)
        .max_age(CookieDuration::days(COOKIE_MAX_AGE_DAYS))
        .build();
    window.set_cookie(cookie)?;
    Ok(())
}

/// 껍데기에 내장된 로컬 페이지 주소 (Windows는 http://tauri.localhost, 그 외는 tauri://localhost)
fn local_page_url(page: &str) -> Url {
    #[cfg(windows)]
    let base = "http://tauri.localhost/";
    #[cfg(not(windows))]
    let base = "tauri://localhost/";
    Url::parse(&format!("{base}{page}")).expect("로컬 페이지 주소")
}

/// 위젯을 주 모니터 작업영역(작업표시줄 제외) 우하단에 붙인다
fn position_bottom_right(window: &WebviewWindow) {
    let Ok(Some(monitor)) = window.primary_monitor() else {
        return;
    };
    let size = window
        .outer_size()
        .unwrap_or(PhysicalSize::new(DEFAULT_SIZE.0 as u32, DEFAULT_SIZE.1 as u32));
    let area = monitor.work_area();
    let x = area.position.x + area.size.width as i32 - size.width as i32 - SCREEN_MARGIN;
    let y = area.position.y + area.size.height as i32 - size.height as i32 - SCREEN_MARGIN;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

/// 저장된 위치가 어떤 모니터에도 걸치지 않으면(모니터 분리·해상도 변경) 우하단으로 되돌린다
fn ensure_on_screen(window: &WebviewWindow) {
    let Ok(pos) = window.outer_position() else {
        position_bottom_right(window);
        return;
    };
    let size = window
        .outer_size()
        .unwrap_or(PhysicalSize::new(DEFAULT_SIZE.0 as u32, DEFAULT_SIZE.1 as u32));
    let on_some_monitor = window
        .available_monitors()
        .map(|monitors| {
            monitors.iter().any(|monitor| {
                let area = monitor.work_area();
                let (ax, ay) = (area.position.x, area.position.y);
                let (aw, ah) = (area.size.width as i32, area.size.height as i32);
                pos.x < ax + aw
                    && pos.x + size.width as i32 > ax
                    && pos.y < ay + ah
                    && pos.y + size.height as i32 > ay
            })
        })
        .unwrap_or(false);
    if !on_some_monitor {
        position_bottom_right(window);
    }
}

/// 창이 화면에 떠 있는가 (보이고 최소화되지 않음)
fn is_shown(window: &WebviewWindow) -> bool {
    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
}

/// 보이는 창의 위치(물리)·안쪽 크기(논리)를 설정에 적는다. 최소화 파킹 좌표(-32000)는 버린다.
fn remember_window_rect(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if !is_shown(&window) {
        return;
    }
    let (Ok(pos), Ok(size), Ok(scale)) = (
        window.outer_position(),
        window.inner_size(),
        window.scale_factor(),
    ) else {
        return;
    };
    if pos.x <= -30_000 || pos.y <= -30_000 || size.width == 0 || size.height == 0 {
        return;
    }
    // 벽 붙임 중엔 그림자를 꺼서 넓어진 틀 두께를 빼고 적는다 (다시 실행할 때 자라지 않게)
    let frame = with_wall(app, |wall| if wall.enabled { wall.frame } else { LogicalSize::new(0.0, 0.0) });
    let size = wall::framed_inner_size(size, frame, scale);
    let logical = size.to_logical::<f64>(scale);
    let rect = settings::WindowRect {
        x: pos.x,
        y: pos.y,
        logical_width: logical.width,
        logical_height: logical.height,
    };
    let state = app.state::<WidgetState>();
    if state.settings().window == Some(rect) {
        return;
    }
    state.update_settings(|settings| settings.window = Some(rect));
}

// 창을 숨겨도 WebView2는 페이지에 알리지 않아 document.hidden이 false로 남는다(실측).
// 그래서 페이지에 직접 표식을 심고 알린다 — 위젯 화면(src/lib/client/widget.ts)이 이 표식을 보고
// 주기 확인을 늦춘다. 표식 이름은 widget.ts의 WIDGET_HIDDEN_FLAG·WIDGET_VISIBILITY_EVENT와 같다.
fn tell_page_visibility(window: &WebviewWindow, hidden: bool) {
    let _ = window.eval(format!(
        "window.__sharedeskWidgetHidden={hidden};document.dispatchEvent(new Event('sharedesk:widget-visibility'));"
    ));
}

/// 창과 웹뷰를 함께 숨기고 페이지에도 알린다.
fn hide_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    remember_window_rect(app);
    tell_page_visibility(&window, true);
    let _ = AsRef::<Webview>::as_ref(&window).hide();
    let _ = window.hide();
    refresh_tray(app);
}

fn show_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let _ = window.unminimize();
    ensure_on_screen(&window);
    let _ = window.show();
    let _ = AsRef::<Webview>::as_ref(&window).show();
    let _ = window.set_focus();
    tell_page_visibility(&window, false);
    refresh_tray(app);
}

fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    if is_shown(&window) {
        hide_main_window(app);
    } else {
        show_main_window(app);
    }
}

/// 주소가 저장된 데스크와 같은 원점(스킴+호스트+포트)인가. 데스크 주소가 없으면 늘 거짓.
fn is_desk_origin(state: &WidgetState, url: &Url) -> bool {
    state.desk_origin().as_deref() == Some(url.origin().ascii_serialization().as_str())
}

/// 기본 브라우저로 여는 조건: http(s), 저장된 데스크와 같은 원점, 직전 열기에서 1초 이상 지남.
fn may_open_external(state: &WidgetState, url: &Url, now: Instant) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    if !is_desk_origin(state, url) {
        return false;
    }
    let mut last = state.last_external_open.lock().expect("open lock");
    if last.is_some_and(|at| now.duration_since(at) < EXTERNAL_OPEN_MIN_GAP) {
        return false;
    }
    *last = Some(now);
    true
}

fn open_external(app: &AppHandle, url: &str) {
    let Ok(parsed) = Url::parse(url) else {
        return;
    };
    if !may_open_external(&app.state::<WidgetState>(), &parsed, Instant::now()) {
        eprintln!("[open] 막음: {url}");
        return;
    }
    if let Err(error) = app.opener().open_url(parsed.as_str(), None::<&str>) {
        eprintln!("브라우저 열기 실패: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with_desk(desk: &str) -> WidgetState {
        WidgetState {
            profile: Profile {
                name: "test".into(),
                dir: std::env::temp_dir(),
                _lock: File::create(std::env::temp_dir().join(format!(
                    "sharedesk-widget-open-test-{}.lock",
                    std::process::id()
                )))
                .unwrap(),
            },
            settings: Mutex::new(Settings {
                desk_url: Some(desk.into()),
                ..Settings::default()
            }),
            pending_update: Mutex::new(None),
            update_status: Mutex::new(None),
            update_url: None,
            last_external_open: Mutex::new(None),
            lang: locale::Lang::En,
            wall: Mutex::new(WallState::default()),
        }
    }

    #[test]
    fn external_open_is_limited_to_the_desk_origin_and_rate() {
        let state = state_with_desk("https://desk.example.com/sub");
        let now = Instant::now();
        let ok = Url::parse("https://desk.example.com/files").unwrap();
        assert!(may_open_external(&state, &ok, now));
        // 1초 안의 두 번째 요청은 막힌다
        assert!(!may_open_external(&state, &ok, now + Duration::from_millis(300)));
        assert!(may_open_external(&state, &ok, now + Duration::from_millis(1_500)));
        // 다른 원점·다른 스킴은 언제나 막힌다
        for bad in [
            "https://attacker.example/",
            "http://desk.example.com/files",
            "https://desk.example.com:8443/",
            "file:///C:/Windows/win.ini",
            "javascript:alert(1)",
        ] {
            let url = Url::parse(bad).unwrap();
            assert!(!may_open_external(&state, &url, now + Duration::from_secs(10)), "{bad}");
        }
        // 데스크 주소가 없으면 아무것도 열지 않는다
        let none = state_with_desk("");
        none.settings.lock().unwrap().desk_url = None;
        assert!(!may_open_external(&none, &ok, now + Duration::from_secs(20)));
    }

    #[test]
    fn wall_commands_answer_only_the_desk_page() {
        let state = state_with_desk("https://desk.example.com/sub");
        for good in [
            "https://desk.example.com/files",
            "https://desk.example.com/team/files?x=1",
            "https://desk.example.com:443/",
        ] {
            assert!(is_desk_origin(&state, &Url::parse(good).unwrap()), "{good}");
        }
        for bad in [
            "http://desk.example.com/files",
            "https://desk.example.com:8443/files",
            "https://attacker.example/files",
            "https://desk.example.com.attacker.example/",
            "http://tauri.localhost/index.html",
            "tauri://localhost/index.html",
        ] {
            assert!(!is_desk_origin(&state, &Url::parse(bad).unwrap()), "{bad}");
        }
        let none = state_with_desk("");
        none.settings.lock().unwrap().desk_url = None;
        assert!(!is_desk_origin(&none, &Url::parse("https://desk.example.com/").unwrap()));
    }
}

// ── 첫 실행 화면(로컬 페이지)이 부르는 명령 ────────────────────────────────

#[derive(serde::Serialize)]
struct WidgetInfo {
    version: &'static str,
    profile: String,
    desk_url: Option<String>,
    language: &'static str,
}

#[tauri::command]
fn widget_info(state: tauri::State<'_, WidgetState>) -> WidgetInfo {
    WidgetInfo {
        version: env!("CARGO_PKG_VERSION"),
        profile: state.profile.name.clone(),
        desk_url: state.settings().desk_url,
        language: match state.lang {
            locale::Lang::En => "en",
            locale::Lang::Ko => "ko",
            locale::Lang::Ja => "ja",
            locale::Lang::Hi => "hi",
            locale::Lang::Zh => "zh",
        },
    }
}

#[tauri::command]
fn save_desk_url(
    app: AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, WidgetState>,
    url: String,
) -> Result<String, String> {
    let normalized = settings::normalize_desk_url(&url).map_err(|reason| reason.to_string())?;
    state.update_settings(|settings| settings.desk_url = Some(normalized.clone()));
    enter_desk(&window).map_err(|error| error.to_string())?;
    refresh_tray(&app);
    Ok(normalized)
}

#[tauri::command]
fn hide_widget(app: AppHandle) {
    hide_main_window(&app);
}

// ── 벽 붙임 (#28) ───────────────────────────────────────────────────────────
//
// 페이지가 set_wall_mode로 켜고 끄며 set_wall_zone으로 커서를 받아야 하는 영역을 알린다.
// 폴링 스레드가 커서를 영역과 비교해 펼침·접힘을 정하고(wall::Hover), 바뀔 때마다 클릭 투과를
// 맞추고 페이지에 sharedesk:wall-hover를 쏜다. 창을 옮기면 멎은 뒤 다시 붙이고 sharedesk:wall-side를 쏜다.
// 동기 명령은 메인 스레드에서 돌고, 폴링 스레드의 창 조회는 메인 스레드의 답을 기다린다 —
// 그래서 폴링 스레드는 wall 잠금을 쥔 채 창을 조회하지 않는다(교착 방지).

/// 벽 붙임·압정 명령은 저장된 데스크 원점의 페이지만 부를 수 있다. 원격 capability가 데스크 주소를 미리
/// 알 수 없어 모든 http(s) 원점에 열려 있으므로, 명령 안에서 호출 웹뷰의 지금 주소로 다시 거른다
/// (may_open_external과 같은 기준).
fn require_desk_page(window: &WebviewWindow) -> Result<(), String> {
    let page = window.url().map_err(|error| error.to_string())?;
    if is_desk_origin(&window.state::<WidgetState>(), &page) {
        Ok(())
    } else {
        Err("데스크 페이지에서만 쓸 수 있는 명령입니다".to_string())
    }
}

/// wall 잠금 안에서 f를 부른다. 창 조회·이동은 이 안에서 하지 않는다(교착 방지).
fn with_wall<T>(manager: &impl Manager<tauri::Wry>, f: impl FnOnce(&mut WallState) -> T) -> T {
    let state = manager.state::<WidgetState>();
    let mut wall = state.wall.lock().expect("wall lock");
    f(&mut wall)
}

/// 켜면 가까운 벽에 붙이고 그 벽을 돌려준다. 끄면 영역·투과를 풀고 창은 그 자리에 둔다.
#[tauri::command]
fn set_wall_mode(app: AppHandle, window: WebviewWindow, enabled: bool) -> Result<Option<wall::Side>, String> {
    require_desk_page(&window)?;
    // 벽 붙임은 항상 위를 전제한다(손잡이가 보여야 한다). 페이지가 먼저 압정을 풀지만, 압정인 채로
    // 켜 달라는 요청이 오면 여기서도 풀고 페이지에 알린다 (#30 상호 배타)
    if enabled && app.state::<WidgetState>().settings().pinned {
        set_pinned_state(&app, &window, false);
        tell_page_pinned(&window, false);
    }
    // 그림자를 끄기 전에 틀 두께를 논리값으로 잰다 (이미 켜져 있었으면 그때 잰 값을 이어 쓴다)
    let measured = match (window.outer_size(), window.inner_size(), window.scale_factor()) {
        (Ok(outer), Ok(inner), Ok(scale)) if scale > 0.0 => PhysicalSize::new(
            outer.width.saturating_sub(inner.width),
            outer.height.saturating_sub(inner.height),
        )
        .to_logical::<f64>(scale),
        _ => LogicalSize::new(0.0, 0.0),
    };
    let epoch = with_wall(&app, |wall| {
        let frame = if wall.enabled { wall.frame } else { measured };
        *wall = WallState {
            enabled,
            epoch: wall.epoch.wrapping_add(1),
            frame: if enabled { frame } else { LogicalSize::new(0.0, 0.0) },
            ..WallState::default()
        };
        wall.epoch
    });
    // 메인 스레드(동기 명령)라 그림자가 바로 꺼진다 — 달라진 틀 여백을 재어 붙이도록 먼저 적용한다
    apply_wall_window(&app);
    if !enabled {
        return Ok(None);
    }
    match snap_to_wall(&window, epoch) {
        Some(side) => Ok(Some(side)),
        None => {
            reset_wall(&app);
            Err("창을 벽에 붙이지 못했습니다".to_string())
        }
    }
}

#[tauri::command]
fn set_wall_zone(window: WebviewWindow, zone: Option<wall::Zone>) -> Result<(), String> {
    require_desk_page(&window)?;
    // 페이지가 준 사각형을 그대로 믿지 않는다 — 창 안쪽으로 자르고, 들어갈 수 없는 영역이면 붙잡는다
    let viewport = match (window.inner_size(), window.scale_factor()) {
        (Ok(size), Ok(scale)) if scale > 0.0 => size.to_logical::<f64>(scale),
        _ => LogicalSize::new(f64::INFINITY, f64::INFINITY),
    };
    let zone = zone.map(|zone| wall::checked_zone(zone, viewport));
    with_wall(&window, |wall| {
        // 끈 뒤에 늦게 도착한 보고는 버린다
        if wall.enabled {
            wall.zone = zone;
        }
    });
    Ok(())
}

/// 벽 붙임을 모두 푼다 (페이지 로드·붙이기 실패)
fn reset_wall(app: &AppHandle) {
    let changed = with_wall(app, |wall| {
        if !wall.enabled {
            return false;
        }
        *wall = WallState {
            epoch: wall.epoch.wrapping_add(1),
            ..WallState::default()
        };
        true
    });
    if changed {
        apply_wall_window(app);
    }
}

/// 창을 지금 상태에 맞춘다: 클릭 투과(켜짐 && 접힘)와 창 그림자(켜진 동안 끔).
/// 그림자 틀은 내용이 벽 너머로 빠진 빈 창의 윤곽으로 드러나므로 벽 붙임 동안 끈다(실측).
/// 늘 메인 스레드에서 그때의 상태를 읽어 적용하므로, 폴링 스레드의 판정과 명령이 엇갈려
/// 도착해도 마지막에는 최신 상태가 남는다. 같은 값을 다시 적용하면 아무 일도 하지 않는다.
fn apply_wall_window(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window(MAIN_WINDOW) else {
            return;
        };
        let (enabled, expanded) = with_wall(&handle, |wall| (wall.enabled, wall.expanded));
        let _ = window.set_shadow(!enabled);
        let _ = window.set_ignore_cursor_events(enabled && !expanded);
    });
}

/// 창을 가까운 벽에 붙이고 그 벽을 돌려준다. 그사이 벽 붙임이 꺼졌거나 다시 켜졌으면(epoch) 손대지 않는다.
fn snap_to_wall(window: &WebviewWindow, epoch: u64) -> Option<wall::Side> {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten())?;
    let area = monitor.work_area();
    let area = wall::ScreenRect {
        x: area.position.x,
        y: area.position.y,
        width: area.size.width as i32,
        height: area.size.height as i32,
    };
    let outer = window.outer_position().ok()?;
    let inner = window.inner_position().ok()?;
    let size = window.inner_size().ok()?;
    let visible = wall::ScreenRect {
        x: inner.x,
        y: inner.y,
        width: size.width as i32,
        height: size.height as i32,
    };
    let side = wall::pick_side(visible, area);
    let target = wall::snap_position(outer, visible, area, side);
    let side_changed = with_wall(window, |wall| {
        if !wall.enabled || wall.epoch != epoch {
            return None;
        }
        // 옮기기 전에 목표를 적어 둔다 — 이 이동으로 오는 Moved를 되먹임으로 알아보게
        wall.target = Some(target);
        let changed = wall.side.is_some_and(|previous| previous != side);
        wall.side = Some(side);
        Some(changed)
    })?;
    if outer != target {
        let _ = window.set_position(target);
    }
    if side_changed {
        let _ = window.eval(wall::side_script(side));
    }
    Some(side)
}

/// 창이 움직였다 — 껍데기가 붙인 자리(되먹임)가 아니면 사용자가 옮긴 것으로 적는다.
fn note_wall_move(window: &Window) {
    let Ok(position) = window.outer_position() else {
        return;
    };
    with_wall(window, |wall| {
        if wall.enabled && wall.target != Some(position) {
            wall.moved_at = Some(Instant::now());
        }
    });
}

fn spawn_wall_watcher(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("wall-watcher".into())
        .spawn(move || {
            let mut hover = wall::Hover::new();
            let mut seen_epoch = 0;
            let mut active = false;
            loop {
                std::thread::sleep(if active { WALL_POLL } else { WALL_IDLE_POLL });
                active = wall_tick(&app, &mut hover, &mut seen_epoch);
            }
        });
    if let Err(error) = spawned {
        eprintln!("벽 붙임 감시를 시작하지 못했습니다: {error}");
    }
}

/// 폴링 한 번. 벽 붙임이 켜져 있고 창이 보이면 true(다음은 WALL_POLL 뒤), 아니면 false(WALL_IDLE_POLL 뒤).
fn wall_tick(app: &AppHandle, hover: &mut wall::Hover, seen_epoch: &mut u64) -> bool {
    let (enabled, zone, epoch, moved_at) =
        with_wall(app, |wall| (wall.enabled, wall.zone.clone(), wall.epoch, wall.moved_at));
    if epoch != *seen_epoch {
        hover.reset();
        *seen_epoch = epoch;
    }
    if !enabled {
        return false;
    }
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return false;
    };
    // 트레이에 숨어 있으면 쉰다. 호버 판정은 그대로 두어, 다시 보일 때 커서가 밖이면 곧 접힌다.
    if !is_shown(&window) {
        return false;
    }
    let now = Instant::now();
    // 머리띠를 쥔 채 멈춘 동안은 미룬다 — 버튼을 놓은 뒤에만 붙인다
    if let Some(at) = moved_at.filter(|&at| wall::settle_due(at, now, wall::primary_button_down())) {
        settle_after_move(&window, epoch, at);
    }
    let (Ok(cursor), Ok(inner), Ok(scale)) = (
        window.cursor_position(),
        window.inner_position(),
        window.scale_factor(),
    ) else {
        return true;
    };
    let Some(cursor) = wall::cursor_in_window(cursor, inner, scale) else {
        return true;
    };
    if let Some(expanded) = hover.update(zone.as_ref(), cursor, now) {
        set_wall_expanded(&window, epoch, expanded);
    }
    true
}

/// 옮긴 창이 멎었다 — 붙어 있던 자리와 다르면 다시 가까운 벽을 골라 붙인다.
/// `seen_move`는 판정에 쓴 이동 시각이다. 그사이 또 옮겼으면 다음 차례에 다시 본다.
fn settle_after_move(window: &WebviewWindow, epoch: u64, seen_move: Instant) {
    let settled = with_wall(window, |wall| {
        if !wall.enabled || wall.epoch != epoch || wall.moved_at != Some(seen_move) {
            return None;
        }
        wall.moved_at = None;
        Some(wall.target)
    });
    let Some(target) = settled else {
        return;
    };
    if window.outer_position().ok() != target {
        snap_to_wall(window, epoch);
    }
}

fn set_wall_expanded(window: &WebviewWindow, epoch: u64, expanded: bool) {
    let current = with_wall(window, |wall| {
        if !wall.enabled || wall.epoch != epoch {
            return false;
        }
        wall.expanded = expanded;
        true
    });
    if current {
        apply_wall_window(window.app_handle());
        let _ = window.eval(wall::hover_script(expanded));
    }
}

// ── 압정 (#30) ──────────────────────────────────────────────────────────────
//
// 배치 모드 셋(떠 있기·벽 붙임·압정) 중 하나. 켜면 창이 다른 창 뒤, 바탕화면 위에 머문다.
// 원본은 껍데기 설정(settings.pinned)이고, 페이지는 로드 때 widget_placement로 읽어 단추를 맞추고
// set_pinned로 켜고 끈다. 벽 붙임과의 순서(압정을 켜기 전에 벽을 끄고, 벽을 켜기 전에 압정을 푼다)는
// 페이지가 맡고, 껍데기는 set_wall_mode(true)와 트레이 "항상 위"에서 방어적으로 압정을 푼다.
// Windows: tao가 ALWAYS_ON_BOTTOM 플래그를 WM_WINDOWPOSCHANGING에서 HWND_BOTTOM으로 강제하므로
// 창을 눌러 활성화해도 맨 아래에 남는다. macOS: 창 레벨 BelowNormalWindowLevel (widget/README.md).

/// 페이지(src/lib/client/widget.ts)의 WIDGET_PINNED_EVENT와 같은 이름 — 껍데기가 압정을 스스로 풀었을 때 쏜다
const PINNED_EVENT: &str = "sharedesk:widget-pinned";

#[derive(serde::Serialize)]
struct Placement {
    pinned: bool,
}

/// 창에 압정을 적용한다. 두 플래그가 함께 켜지는 순간이 없도록 순서를 지킨다:
/// 켜기는 항상 위를 내린 뒤 맨 아래로, 끄기는 맨 아래를 푼 뒤 설정의 항상 위로.
fn apply_pinned(window: &WebviewWindow, pinned: bool) {
    if pinned {
        let _ = window.set_always_on_top(false);
        let _ = window.set_always_on_bottom(true);
    } else {
        let _ = window.set_always_on_bottom(false);
        let always_on_top = window.state::<WidgetState>().settings().always_on_top;
        let _ = window.set_always_on_top(always_on_top);
    }
}

/// 설정에 적고 창에 적용하고 트레이("항상 위" 체크)를 맞춘다
fn set_pinned_state(app: &AppHandle, window: &WebviewWindow, pinned: bool) {
    app.state::<WidgetState>()
        .update_settings(|settings| settings.pinned = pinned);
    apply_pinned(window, pinned);
    refresh_tray(app);
}

fn tell_page_pinned(window: &WebviewWindow, pinned: bool) {
    let _ = window.eval(format!(
        "document.dispatchEvent(new CustomEvent('{PINNED_EVENT}',{{detail:{pinned}}}));"
    ));
}

/// 지금 배치 — 페이지가 로드될 때 압정 단추를 맞추려고 읽는다
#[tauri::command]
fn widget_placement(window: WebviewWindow) -> Result<Placement, String> {
    require_desk_page(&window)?;
    Ok(Placement {
        pinned: window.state::<WidgetState>().settings().pinned,
    })
}

/// 압정을 켜고 끄고, 적용된 값을 돌려준다
#[tauri::command]
fn set_pinned(app: AppHandle, window: WebviewWindow, enabled: bool) -> Result<bool, String> {
    require_desk_page(&window)?;
    set_pinned_state(&app, &window, enabled);
    Ok(enabled)
}

// ── 트레이 ──────────────────────────────────────────────────────────────────

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(
            app.default_window_icon()
                .expect("번들 아이콘이 없습니다")
                .clone(),
        )
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("ShareDesk Widget")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_main_window(app),
            "always-on-top" => {
                // 압정 중엔 "항상 위"가 꺼진 것으로 보인다 — 누르면 압정을 먼저 풀고 항상 위로 (#30 상호 배타)
                let state = app.state::<WidgetState>();
                let current = state.settings();
                let next = !(current.always_on_top && !current.pinned);
                state.update_settings(|settings| settings.always_on_top = next);
                if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                    if current.pinned {
                        set_pinned_state(app, &window, false);
                        tell_page_pinned(&window, false);
                    } else {
                        let _ = window.set_always_on_top(next);
                    }
                }
                refresh_tray(app);
            }
            "autostart" => {
                let launcher = app.autolaunch();
                let result = if launcher.is_enabled().unwrap_or(false) {
                    launcher.disable()
                } else {
                    launcher.enable()
                };
                if let Err(error) = result {
                    eprintln!("자동 실행 설정 실패: {error}");
                }
                refresh_tray(app);
            }
            "change-desk" => {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                    let _ = window.navigate(local_page_url("index.html"));
                }
                show_main_window(app);
            }
            "open-browser" => {
                if let Some(desk) = app.state::<WidgetState>().settings().desk_url {
                    open_external(app, &format!("{desk}/files"));
                }
            }
            "check-update" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    check_update(handle, true).await;
                });
            }
            "install-update" => {
                let handle = app.clone();
                tauri::async_runtime::spawn(async move {
                    install_pending_update(handle).await;
                });
            }
            "quit" => {
                remember_window_rect(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let state = app.state::<WidgetState>();
    let labels = state.lang.labels();
    let settings = state.settings();
    let visible = app
        .get_webview_window(MAIN_WINDOW)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    let pending_version = state
        .pending_update
        .lock()
        .expect("update lock")
        .as_ref()
        .map(|update| update.version.clone());
    let status = state.update_status.lock().expect("status lock").clone();

    let menu = Menu::new(app)?;
    menu.append(&MenuItem::with_id(
        app,
        "toggle",
        if visible { labels.hide } else { labels.show },
        true,
        None::<&str>,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        "always-on-top",
        labels.always_on_top,
        true,
        settings.always_on_top && !settings.pinned,
        None::<&str>,
    )?)?;
    menu.append(&CheckMenuItem::with_id(
        app,
        "autostart",
        labels.autostart,
        true,
        autostart,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        "change-desk",
        labels.change_desk,
        true,
        None::<&str>,
    )?)?;
    if settings.desk_url.is_some() {
        menu.append(&MenuItem::with_id(
            app,
            "open-browser",
            labels.open_in_browser,
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    match pending_version {
        Some(version) => menu.append(&MenuItem::with_id(
            app,
            "install-update",
            labels.install_update.replace("{v}", &version),
            true,
            None::<&str>,
        )?)?,
        None => menu.append(&MenuItem::with_id(
            app,
            "check-update",
            labels.check_update,
            true,
            None::<&str>,
        )?)?,
    }
    if let Some(status) = status {
        menu.append(&MenuItem::with_id(app, "status", status, false, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", labels.quit, true, None::<&str>)?)?;
    Ok(menu)
}

fn refresh_tray(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Ok(menu) = build_tray_menu(&handle) {
            if let Some(tray) = handle.tray_by_id(TRAY_ID) {
                let _ = tray.set_menu(Some(menu));
            }
        }
    });
}

// ── 업데이트 ────────────────────────────────────────────────────────────────

fn set_update_status(app: &AppHandle, status: Option<String>) {
    *app.state::<WidgetState>()
        .update_status
        .lock()
        .expect("status lock") = status;
    refresh_tray(app);
}

async fn check_update(app: AppHandle, announce: bool) {
    let labels = app.state::<WidgetState>().lang.labels();
    let override_url = app.state::<WidgetState>().update_url.clone();
    let result = async {
        let mut builder = app.updater_builder();
        if let Some(url) = override_url.as_deref() {
            let parsed = Url::parse(url).map_err(|e| tauri_plugin_updater::Error::Io(std::io::Error::other(e)))?;
            builder = builder.endpoints(vec![parsed])?;
        }
        let updater = builder.build()?;
        updater.check().await
    }
    .await;
    match result {
        Ok(Some(update)) => {
            let version = update.version.clone();
            eprintln!(
                "[update] 새 버전 {version} (현재 {})",
                env!("CARGO_PKG_VERSION")
            );
            *app.state::<WidgetState>()
                .pending_update
                .lock()
                .expect("update lock") = Some(update);
            if let Some(tray) = app.tray_by_id(TRAY_ID) {
                let _ = tray.set_tooltip(Some(labels.install_update.replace("{v}", &version)));
            }
            set_update_status(&app, None);
        }
        Ok(None) => {
            eprintln!("[update] 최신 버전입니다 ({})", env!("CARGO_PKG_VERSION"));
            if announce {
                set_update_status(
                    &app,
                    Some(labels.up_to_date.replace("{v}", env!("CARGO_PKG_VERSION"))),
                );
            }
        }
        Err(error) => {
            eprintln!("[update] 확인 실패: {error}");
            if announce {
                set_update_status(&app, Some(labels.update_failed.to_string()));
            }
        }
    }
}

async fn install_pending_update(app: AppHandle) {
    let update = app
        .state::<WidgetState>()
        .pending_update
        .lock()
        .expect("update lock")
        .take();
    let Some(update) = update else {
        return;
    };
    remember_window_rect(&app);
    eprintln!("[update] {} 내려받아 설치합니다", update.version);
    match update.download_and_install(|_, _| {}, || {}).await {
        Ok(()) => {
            eprintln!("[update] 설치 완료, 다시 시작합니다");
            app.restart()
        }
        Err(error) => {
            eprintln!("업데이트 설치 실패: {error}");
            let labels = app.state::<WidgetState>().lang.labels();
            set_update_status(&app, Some(labels.update_failed.to_string()));
        }
    }
}
