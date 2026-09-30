//! 벽 붙임 (#28) — 상태를 모르는 순수 부분: 벽 고르기·붙일 좌표·호버 상태기계·커서 좌표 변환.
//!
//! 벽 붙임은 배치 토글이다. 켜면 창을 가까운 좌우 벽에 붙이고, 페이지(src/app/widget)는 내용
//! 전체를 벽 너머로 밀어내 손잡이만 남긴다. 창 자체는 움직이지 않으니 떨림이 없고, 비어 보이는
//! 나머지 자리는 커서 무시(set_ignore_cursor_events)로 뒤 창에 클릭을 넘긴다. 투과 중인 웹뷰는
//! mouseenter를 받지 못하므로 진입·이탈 판정은 껍데기의 폴링 스레드가 맡는다(lib.rs).
//! 스위처 Type4(#151)의 EdgeHover·pickEdgeSide·edgeSnapPosition·primary_button_down을 옮겨 왔다.
//! OS에 묻는 것은 마우스 주 버튼 상태(primary_button_down) 하나뿐이고 나머지는 상태 없는 계산이다.

use std::time::{Duration, Instant};

use tauri::{LogicalPosition, LogicalSize, PhysicalPosition, PhysicalSize};

/// 손잡이에서 판으로 옮겨 타는 순간(영역이 손잡이→창 전체로 바뀌는 사이)과
/// 가장자리의 미세한 떨림을 삼키는 이탈 유예.
pub const LEAVE_GRACE: Duration = Duration::from_millis(450);

/// 머리띠로 옮긴 창은 마지막 이동 뒤 이만큼 멎고 버튼을 놓았으면 가까운 벽에 다시 붙인다.
pub const SETTLE: Duration = Duration::from_millis(300);

/// 페이지(src/lib/client/widget.ts)의 WIDGET_WALL_HOVER_EVENT·WIDGET_WALL_SIDE_EVENT와 같은 이름.
pub const HOVER_EVENT: &str = "sharedesk:wall-hover";
pub const SIDE_EVENT: &str = "sharedesk:wall-side";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Left,
    Right,
}

impl Side {
    pub fn as_str(self) -> &'static str {
        match self {
            Side::Left => "left",
            Side::Right => "right",
        }
    }
}

/// 페이지가 알리는 "마우스를 받아야 하는 영역" — 창 안쪽 논리 좌표 [x, y, w, h].
/// 숨김 중엔 손잡이(+여유), 펼침 중엔 창 전체. `hold`면 커서가 떠나도 접지 않는다.
#[derive(serde::Deserialize, Clone, Debug, PartialEq)]
pub struct Zone {
    pub rect: [f64; 4],
    pub hold: bool,
}

/// 영역이 이보다 좁거나 낮으면 커서가 들어갈 수 없는 보고로 본다 (논리 px)
pub const MIN_ZONE: f64 = 8.0;

/// 페이지가 알린 영역을 창 안쪽(논리 크기)으로 잘라 쓴다. 네 값 중 하나라도 유한하지 않거나,
/// 자른 뒤 폭·높이가 MIN_ZONE 미만이면 유효하지 않은 보고로 보고 붙잡기(hold)로 바꾼다 —
/// 커서가 절대 들어갈 수 없는 영역을 그대로 믿으면 위젯이 영원히 클릭 투과로 굳고, 껍데기에는
/// 사용자가 되돌릴 방법이 없다. 붙잡으면 펼친 채로 남아 사용자가 조작할 수 있다.
pub fn checked_zone(zone: Zone, viewport: LogicalSize<f64>) -> Zone {
    if !zone.rect.iter().all(|value| value.is_finite()) {
        return Zone {
            rect: [0.0; 4],
            hold: true,
        };
    }
    let [x, y, width, height] = zone.rect;
    let left = x.max(0.0);
    let top = y.max(0.0);
    let right = (x + width).min(viewport.width);
    let bottom = (y + height).min(viewport.height);
    let rect = [left, top, (right - left).max(0.0), (bottom - top).max(0.0)];
    let reachable = rect[2] >= MIN_ZONE && rect[3] >= MIN_ZONE;
    Zone {
        rect,
        hold: zone.hold || !reachable,
    }
}

/// 화면 물리 좌표의 사각형
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScreenRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// 보이는(안쪽) 창의 중심이 작업영역 중심보다 왼쪽이면 왼쪽 벽, 아니면 오른쪽 벽.
pub fn pick_side(visible: ScreenRect, area: ScreenRect) -> Side {
    // 두 배로 비교해 반 픽셀 반올림을 피한다
    let window_center = 2 * i64::from(visible.x) + i64::from(visible.width);
    let area_center = 2 * i64::from(area.x) + i64::from(area.width);
    if window_center < area_center {
        Side::Left
    } else {
        Side::Right
    }
}

/// 보이는 가장자리가 벽에 딱 닿게 놓을 바깥 좌표(set_position에 넣는 값).
/// 바깥 사각형과 안쪽 사이의 보이지 않는 여백(투명 창의 그림자·크기 조절 테두리)은 벽 너머로
/// 내보낸다 — 여백까지 안에 두면 내용이 벽에서 그만큼 떠 보인다(스위처 실측 8px).
/// 세로는 보이는 사각형이 작업영역 안에 들도록 잡고, 작업영역보다 크면 위에 맞춘다.
pub fn snap_position(outer: PhysicalPosition<i32>, visible: ScreenRect, area: ScreenRect, side: Side) -> PhysicalPosition<i32> {
    let inset_left = visible.x - outer.x;
    let inset_top = visible.y - outer.y;
    let visible_x = match side {
        Side::Left => area.x,
        Side::Right => area.x + area.width - visible.width,
    };
    let max_y = area.y + (area.height - visible.height).max(0);
    let visible_y = visible.y.clamp(area.y, max_y);
    PhysicalPosition::new(visible_x - inset_left, visible_y - inset_top)
}

/// 벽 붙임 동안은 창 그림자를 꺼서 안쪽이 틀 두께만큼 넓어진다(실측: 340×520 → 356×529).
/// 창 크기를 적을 때는 그 두께를 빼서 그림자가 켜진 보통 창의 안쪽 크기로 돌려놓는다 —
/// 그대로 적으면 다시 실행할 때마다 창이 틀 두께만큼 자란다.
pub fn framed_inner_size(current: PhysicalSize<u32>, frame: PhysicalSize<u32>) -> PhysicalSize<u32> {
    PhysicalSize::new(
        current.width.saturating_sub(frame.width),
        current.height.saturating_sub(frame.height),
    )
}

/// 옮긴 창을 지금 다시 붙일 때인가: 마지막 이동 뒤 SETTLE이 지났고 주 버튼을 놓았을 때.
/// 머리띠를 잡은 채 멈추면 OS의 창 이동 루프 안에서도 폴링이 돌기 때문에, 버튼을 보지 않으면
/// 놓지도 않은 창이 벽으로 튄다(적대 리뷰).
pub fn settle_due(moved_at: Instant, now: Instant, button_down: bool) -> bool {
    !button_down && now.duration_since(moved_at) >= SETTLE
}

/// 마우스 주 버튼이 지금 눌려 있는가 — 창 이동 루프 안에서는 웹뷰가 이벤트를 받지 못하므로
/// 시스템에 직접 묻는다. Windows·macOS 외에는 "안 눌림"으로 본다(스위처 primary_button_down).
#[allow(unreachable_code)]
pub fn primary_button_down() -> bool {
    #[cfg(windows)]
    {
        #[link(name = "user32")]
        extern "system" {
            fn GetAsyncKeyState(v_key: i32) -> i16;
        }
        const VK_LBUTTON: i32 = 0x01;
        return (unsafe { GetAsyncKeyState(VK_LBUTTON) } as u16 & 0x8000) != 0;
    }
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            // 상태 조회라 입력 모니터링 권한이 필요 없다 (state_id 0 = combined session, button 0 = 왼쪽)
            fn CGEventSourceButtonState(state_id: i32, button: u32) -> bool;
        }
        return unsafe { CGEventSourceButtonState(0, 0) };
    }
    false
}

/// 화면 물리 좌표의 커서를 창 안쪽 논리 좌표로 바꾼다 (페이지가 보고한 영역과 같은 기준).
pub fn cursor_in_window(
    cursor: PhysicalPosition<f64>,
    inner_position: PhysicalPosition<i32>,
    scale_factor: f64,
) -> Option<LogicalPosition<f64>> {
    if !scale_factor.is_finite() || scale_factor <= 0.0 {
        return None;
    }
    Some(LogicalPosition::new(
        (cursor.x - f64::from(inner_position.x)) / scale_factor,
        (cursor.y - f64::from(inner_position.y)) / scale_factor,
    ))
}

/// 벽 붙임 호버 상태기계 — 폴링 스레드가 WALL_POLL(lib.rs)마다 `update`를 부른다.
/// 진입하면 바로 펼치고, 떠나면 LEAVE_GRACE 뒤에 접는다.
pub struct Hover {
    /// Some = 펼침 중(마지막으로 영역 안에 있던 시각), None = 접힘
    last_inside: Option<Instant>,
}

impl Hover {
    pub const fn new() -> Self {
        Hover { last_inside: None }
    }

    /// 벽 붙임을 새로 켜거나 페이지가 다시 로드되면 접힌 상태에서 새로 시작한다.
    pub fn reset(&mut self) {
        self.last_inside = None;
    }

    /// 영역이 없으면(페이지가 아직 알리지 않음) 접힌 채 아무것도 내지 않는다.
    /// 상태가 바뀔 때만 Some(펼침 여부)를 돌려준다.
    pub fn update(&mut self, zone: Option<&Zone>, cursor: LogicalPosition<f64>, now: Instant) -> Option<bool> {
        let Some(zone) = zone else {
            return self.leave(now);
        };
        let [x, y, width, height] = zone.rect;
        let inside = zone.hold
            || (cursor.x >= x && cursor.x <= x + width && cursor.y >= y && cursor.y <= y + height);
        if inside {
            let entered = self.last_inside.is_none();
            self.last_inside = Some(now);
            return entered.then_some(true);
        }
        self.leave(now)
    }

    fn leave(&mut self, now: Instant) -> Option<bool> {
        match self.last_inside {
            Some(at) if now.duration_since(at) >= LEAVE_GRACE => {
                self.last_inside = None;
                Some(false)
            }
            _ => None,
        }
    }
}

/// 페이지에 호버 상태를 알리는 스크립트 (껍데기 → 페이지는 eval로 이벤트를 쏘는 것이 관례)
pub fn hover_script(expanded: bool) -> String {
    format!("document.dispatchEvent(new CustomEvent('{HOVER_EVENT}',{{detail:{expanded}}}));")
}

/// 페이지에 붙은 벽이 바뀌었음을 알리는 스크립트
pub fn side_script(side: Side) -> String {
    format!(
        "document.dispatchEvent(new CustomEvent('{SIDE_EVENT}',{{detail:'{}'}}));",
        side.as_str()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const AREA: ScreenRect = ScreenRect { x: 0, y: 0, width: 1920, height: 1032 };

    fn visible(x: i32, y: i32) -> ScreenRect {
        ScreenRect { x, y, width: 340, height: 520 }
    }

    #[test]
    fn side_follows_the_window_center() {
        assert_eq!(pick_side(visible(100, 100), AREA), Side::Left);
        assert_eq!(pick_side(visible(1500, 100), AREA), Side::Right);
        // 중심이 정확히 가운데면 오른쪽 (스위처와 같은 규칙)
        assert_eq!(pick_side(visible(960 - 170, 100), AREA), Side::Right);
        assert_eq!(pick_side(visible(960 - 171, 100), AREA), Side::Left);
        // 음수 좌표의 보조 모니터에서도 그 모니터 중심을 기준으로 한다
        let left_monitor = ScreenRect { x: -1920, y: 677, width: 1920, height: 1032 };
        assert_eq!(pick_side(visible(-1800, 700), left_monitor), Side::Left);
        assert_eq!(pick_side(visible(-400, 700), left_monitor), Side::Right);
    }

    #[test]
    fn snap_pushes_the_invisible_frame_past_the_wall() {
        // 바깥 사각형이 안쪽보다 왼쪽 8px, 위 1px 크다 (투명 창의 보이지 않는 테두리)
        let outer = PhysicalPosition::new(92, 199);
        let inner = visible(100, 200);
        assert_eq!(snap_position(outer, inner, AREA, Side::Left), PhysicalPosition::new(-8, 199));
        // 오른쪽 벽: 보이는 오른쪽 가장자리가 1920에 닿는다 → 안쪽 x = 1580, 바깥은 8px 왼쪽
        assert_eq!(snap_position(outer, inner, AREA, Side::Right), PhysicalPosition::new(1572, 199));
        // 여백이 없으면 그대로
        let flush = PhysicalPosition::new(100, 200);
        assert_eq!(snap_position(flush, inner, AREA, Side::Left), PhysicalPosition::new(0, 200));
    }

    #[test]
    fn snap_keeps_the_visible_window_inside_the_work_area_vertically() {
        // 아래로 삐져나간 창은 작업영역 바닥에 맞춘다 (1032 - 520 = 512)
        let low = visible(100, 900);
        let outer = PhysicalPosition::new(92, 899);
        assert_eq!(snap_position(outer, low, AREA, Side::Left), PhysicalPosition::new(-8, 511));
        // 위로 나간 창은 작업영역 위에 맞춘다
        let high = visible(100, -50);
        let outer = PhysicalPosition::new(92, -51);
        assert_eq!(snap_position(outer, high, AREA, Side::Left), PhysicalPosition::new(-8, -1));
        // 작업영역보다 큰 창은 위에 맞춘다
        let tall = ScreenRect { x: 100, y: 300, width: 340, height: 2000 };
        let outer = PhysicalPosition::new(100, 300);
        assert_eq!(snap_position(outer, tall, AREA, Side::Right), PhysicalPosition::new(1580, 0));
        // 보조 모니터의 작업영역 기준
        let left_monitor = ScreenRect { x: -1920, y: 677, width: 1920, height: 1032 };
        let outer = PhysicalPosition::new(-1508, 599);
        let inner = visible(-1500, 600);
        assert_eq!(
            snap_position(outer, inner, left_monitor, Side::Left),
            PhysicalPosition::new(-1928, 676)
        );
    }

    #[test]
    fn remembered_size_drops_the_frame_that_the_hidden_shadow_added() {
        let frame = PhysicalSize::new(16, 9);
        assert_eq!(framed_inner_size(PhysicalSize::new(356, 529), frame), PhysicalSize::new(340, 520));
        // 그림자를 끄지 않았으면(틀 0) 그대로
        assert_eq!(framed_inner_size(PhysicalSize::new(340, 520), PhysicalSize::new(0, 0)), PhysicalSize::new(340, 520));
        assert_eq!(framed_inner_size(PhysicalSize::new(4, 4), frame), PhysicalSize::new(0, 0));
    }

    #[test]
    fn zone_is_clipped_to_the_window_and_unreachable_reports_hold_the_desk_open() {
        let viewport = LogicalSize::new(340.0, 520.0);
        let zone = |rect: [f64; 4], hold: bool| Zone { rect, hold };
        // 정상: 창 안의 영역과 창 전체는 그대로 통과
        assert_eq!(checked_zone(zone([300.0, 220.0, 22.0, 80.0], false), viewport), zone([300.0, 220.0, 22.0, 80.0], false));
        assert_eq!(checked_zone(zone([0.0, 0.0, 340.0, 520.0], false), viewport), zone([0.0, 0.0, 340.0, 520.0], false));
        // 벽 쪽으로 창 밖에 나간 손잡이 여유는 잘라 낸다 (오른쪽·왼쪽 벽)
        assert_eq!(checked_zone(zone([322.0, 220.0, 22.0, 80.0], false), viewport), zone([322.0, 220.0, 18.0, 80.0], false));
        assert_eq!(checked_zone(zone([-4.0, 220.0, 22.0, 80.0], false), viewport), zone([0.0, 220.0, 18.0, 80.0], false));
        // 페이지가 붙잡아 달라고 하면 그대로
        assert!(checked_zone(zone([322.0, 220.0, 22.0, 80.0], true), viewport).hold);
        // 커서가 들어갈 수 없는 보고 → 붙잡기
        for rect in [
            [0.0, 0.0, 0.0, 0.0],
            [100.0, 100.0, 7.9, 80.0],
            [-1000.0, -1000.0, 20.0, 20.0],
            [5000.0, 100.0, 22.0, 80.0],
            [100.0, 100.0, -50.0, 80.0],
            [f64::INFINITY, 0.0, 10.0, 10.0],
            [0.0, 0.0, f64::INFINITY, 80.0],
            [f64::NEG_INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::INFINITY],
            [f64::NAN, 0.0, 22.0, 80.0],
        ] {
            assert!(checked_zone(zone(rect, false), viewport).hold, "{rect:?}");
        }
    }

    #[test]
    fn resnap_waits_for_the_pointer_to_let_go() {
        let t0 = Instant::now();
        // 멈춘 지 오래여도 버튼을 쥐고 있으면(머리띠를 잡은 채 정지) 붙이지 않는다
        assert!(!settle_due(t0, t0 + Duration::from_secs(5), true));
        // 놓았고 SETTLE이 지났으면 붙인다
        assert!(settle_due(t0, t0 + SETTLE, false));
        // 놓았어도 방금 움직였으면 아직
        assert!(!settle_due(t0, t0 + SETTLE - Duration::from_millis(1), false));
    }

    #[test]
    fn cursor_is_measured_from_the_visible_client_origin() {
        let cursor = PhysicalPosition::new(1900.0, 500.0);
        let inner = PhysicalPosition::new(1580, 200);
        assert_eq!(cursor_in_window(cursor, inner, 1.0), Some(LogicalPosition::new(320.0, 300.0)));
        assert_eq!(cursor_in_window(cursor, inner, 2.0), Some(LogicalPosition::new(160.0, 150.0)));
        assert_eq!(cursor_in_window(cursor, inner, 0.0), None);
        assert_eq!(cursor_in_window(cursor, inner, f64::NAN), None);
    }

    fn zone(hold: bool) -> Zone {
        Zone { rect: [322.0, 220.0, 22.0, 80.0], hold }
    }

    #[test]
    fn hover_enters_immediately_and_leaves_only_after_grace() {
        let mut hover = Hover::new();
        let t0 = Instant::now();
        let on_handle = LogicalPosition::new(330.0, 260.0);
        let outside = LogicalPosition::new(10.0, 10.0);
        assert_eq!(hover.update(Some(&zone(false)), on_handle, t0), Some(true));
        assert_eq!(hover.update(Some(&zone(false)), on_handle, t0), None);
        // 유예 안의 이탈은 무시
        assert_eq!(hover.update(Some(&zone(false)), outside, t0 + Duration::from_millis(100)), None);
        // 유예 안에 돌아오면 접지 않고 유예가 다시 시작된다
        assert_eq!(hover.update(Some(&zone(false)), on_handle, t0 + Duration::from_millis(200)), None);
        assert_eq!(hover.update(Some(&zone(false)), outside, t0 + Duration::from_millis(600)), None);
        assert_eq!(hover.update(Some(&zone(false)), outside, t0 + Duration::from_millis(650)), Some(false));
        assert_eq!(hover.update(Some(&zone(false)), outside, t0 + Duration::from_millis(700)), None);
    }

    #[test]
    fn hold_keeps_the_desk_open_while_the_cursor_is_away() {
        let mut hover = Hover::new();
        let t0 = Instant::now();
        let outside = LogicalPosition::new(-500.0, -500.0);
        assert_eq!(hover.update(Some(&zone(true)), outside, t0), Some(true));
        assert_eq!(hover.update(Some(&zone(true)), outside, t0 + Duration::from_secs(10)), None);
        // hold가 풀리면 유예 뒤 접힌다
        assert_eq!(hover.update(Some(&zone(false)), outside, t0 + Duration::from_secs(10)), None);
        assert_eq!(hover.update(Some(&zone(false)), outside, t0 + Duration::from_secs(11)), Some(false));
    }

    #[test]
    fn missing_zone_never_opens_and_reset_starts_folded() {
        let mut hover = Hover::new();
        let t0 = Instant::now();
        let on_handle = LogicalPosition::new(330.0, 260.0);
        // 페이지가 영역을 아직 알리지 않았으면 커서가 어디 있든 펼치지 않는다
        assert_eq!(hover.update(None, on_handle, t0), None);
        assert_eq!(hover.update(Some(&zone(false)), on_handle, t0), Some(true));
        // 펼친 뒤 영역이 사라지면 유예 뒤 접힌다
        assert_eq!(hover.update(None, on_handle, t0 + Duration::from_millis(100)), None);
        assert_eq!(hover.update(None, on_handle, t0 + Duration::from_millis(500)), Some(false));
        // reset 뒤에는 다시 진입 신호를 낸다
        assert_eq!(hover.update(Some(&zone(false)), on_handle, t0), Some(true));
        hover.reset();
        assert_eq!(hover.update(Some(&zone(false)), on_handle, t0), Some(true));
    }

    #[test]
    fn page_scripts_use_the_shared_event_names() {
        assert_eq!(
            hover_script(true),
            "document.dispatchEvent(new CustomEvent('sharedesk:wall-hover',{detail:true}));"
        );
        assert_eq!(
            side_script(Side::Left),
            "document.dispatchEvent(new CustomEvent('sharedesk:wall-side',{detail:'left'}));"
        );
        assert_eq!(serde_json::to_string(&Side::Right).unwrap(), "\"right\"");
    }
}
