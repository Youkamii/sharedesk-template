fn main() {
    // 앱 명령에 allow-<명령> 권한을 만들어 capability에서 고를 수 있게 한다.
    // 원격 데스크 페이지에는 hide_widget·벽 붙임(set_wall_mode·set_wall_zone)·압정(widget_placement·set_pinned)만
    // 연다 (capabilities/remote.json).
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "hide_widget",
            "save_desk_url",
            "widget_info",
            "set_wall_mode",
            "set_wall_zone",
            "widget_placement",
            "set_pinned",
        ])),
    )
    .expect("tauri-build 실패");
}
