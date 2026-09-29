//! 프로필별 설정 — 데스크 주소·항상 위·창 위치를 `settings.json`에 둔다.
//! 프로필 폴더 하나가 인스턴스 하나다: 쿠키 저장소(webview/)와 이 파일이 함께 산다.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::Url;

const FILE: &str = "settings.json";
const MAX_PROFILE_NAME_LENGTH: usize = 40;
pub const DEFAULT_PROFILE: &str = "default";

/// 창 위치는 물리 픽셀, 크기는 논리 픽셀(DPI 배율 제외)이다. 크기를 논리값으로 두는 이유는
/// 복원을 창 빌더의 inner_size로 하기 때문이다 — 만들어진 창에 set_size를 쓰면 테두리 없는
/// 창에서 제목줄 높이만큼 더해져 실행할 때마다 창이 자란다.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub logical_width: f64,
    pub logical_height: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 정규화된 데스크 주소 (끝 슬래시 없음). 없으면 첫 실행 화면을 띄운다.
    pub desk_url: Option<String>,
    pub always_on_top: bool,
    // 창 항목이 옛 형식이거나 깨져 있어도 나머지 설정(데스크 주소·로그인)은 지켜야 한다
    #[serde(deserialize_with = "lenient_window")]
    pub window: Option<WindowRect>,
}

fn lenient_window<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<WindowRect>, D::Error> {
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(serde_json::from_value::<WindowRect>(value).ok())
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            desk_url: None,
            always_on_top: true,
            window: None,
        }
    }
}

pub fn load(dir: &Path) -> Settings {
    fs::read(dir.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// 임시 파일에 쓰고 이름을 바꿔 반쯤 쓰인 설정이 남지 않게 한다.
pub fn save(dir: &Path, settings: &Settings) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let target = dir.join(FILE);
    let tmp = dir.join(format!("{FILE}.tmp"));
    fs::write(&tmp, serde_json::to_vec_pretty(settings)?)?;
    fs::rename(&tmp, &target)
}

/// `--이름 값` 또는 `--이름=값` 꼴 인자의 첫 값. 없으면 None.
pub fn arg_value(args: &[String], name: &str) -> Option<String> {
    let flag = format!("--{name}");
    let prefix = format!("--{name}=");
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if let Some(value) = arg.strip_prefix(&prefix) {
            return Some(value.to_string());
        }
        if *arg == flag {
            return iter.next().cloned();
        }
    }
    None
}

/// `--profile 이름`: 없거나 허용 문자(영숫자·-·_) 밖이면 기본 프로필이다.
pub fn profile_name_from_args(args: &[String]) -> String {
    sanitize_profile_name(arg_value(args, "profile").as_deref())
}

/// `--desk 주소`: 데스크 주소를 미리 넣는다 (설치 스크립트·점검용).
pub fn desk_url_from_args(args: &[String]) -> Option<String> {
    arg_value(args, "desk")
}

/// `--update-url 주소`: 업데이트 확인 주소 재정의 (발행 전 점검용, tauri.conf.json의 endpoints를 대신한다).
pub fn update_url_from_args(args: &[String]) -> Option<String> {
    arg_value(args, "update-url")
}

pub fn sanitize_profile_name(value: Option<&str>) -> String {
    match value {
        Some(value)
            if !value.is_empty()
                && value.len() <= MAX_PROFILE_NAME_LENGTH
                && value
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') =>
        {
            value.to_string()
        }
        _ => DEFAULT_PROFILE.to_string(),
    }
}

/// 브라우저 주소창에서 그대로 복사해 오기 쉬운 데스크 안 경로 — 주소 끝에서 떼어 낸다.
const DESK_ROUTES: [&str; 5] = ["/files", "/admin", "/join", "/pending", "/api"];

/// 사용자가 적은 주소를 데스크 주소로 정리한다.
/// 스킴이 없으면 https를 붙이고, 물음표·조각·끝 슬래시와 데스크 안 경로(/files 등)는 버린다.
/// 데스크가 하위 경로에 있을 수 있으므로 그 밖의 경로는 남긴다.
pub fn normalize_desk_url(input: &str) -> Result<String, &'static str> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("empty");
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let mut url = Url::parse(&with_scheme).map_err(|_| "invalid")?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("scheme");
    }
    if url.host_str().map_or(true, str::is_empty) {
        return Err("host");
    }
    if url.username() != "" || url.password().is_some() {
        return Err("credentials");
    }
    url.set_query(None);
    url.set_fragment(None);
    let mut text = url.to_string();
    loop {
        while text.ends_with('/') {
            text.pop();
        }
        // 경로 조각 단위로만 뗀다("/myfiles"는 "/files"로 끝나지 않는다). 떼고 남은 것이 호스트를 가진
        // 주소여야 한다 — 호스트 이름이 "files"인 경우까지 잘라 내지 않게.
        let stripped = DESK_ROUTES.iter().find_map(|route| {
            text.strip_suffix(route)
                .filter(|rest| Url::parse(rest).is_ok_and(|u| u.host_str().is_some()))
                .map(str::to_string)
        });
        match stripped {
            Some(rest) => text = rest,
            None => break,
        }
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn profile_name_comes_from_args_and_falls_back_to_default() {
        assert_eq!(profile_name_from_args(&args(&["app"])), "default");
        assert_eq!(profile_name_from_args(&args(&["app", "--profile", "work"])), "work");
        assert_eq!(profile_name_from_args(&args(&["app", "--profile=home_2"])), "home_2");
        // 경로 문자·공백은 프로필 이름이 될 수 없다
        assert_eq!(profile_name_from_args(&args(&["app", "--profile", "../x"])), "default");
        assert_eq!(profile_name_from_args(&args(&["app", "--profile", ""])), "default");
        assert_eq!(profile_name_from_args(&args(&["app", "--profile"])), "default");
        assert_eq!(
            profile_name_from_args(&args(&["app", "--profile", &"a".repeat(41)])),
            "default"
        );
    }

    #[test]
    fn optional_urls_come_from_args() {
        assert_eq!(desk_url_from_args(&args(&["app"])), None);
        assert_eq!(
            desk_url_from_args(&args(&["app", "--desk", "https://d.example"])).as_deref(),
            Some("https://d.example")
        );
        assert_eq!(
            update_url_from_args(&args(&["app", "--update-url=http://localhost:4000/latest.json"])).as_deref(),
            Some("http://localhost:4000/latest.json")
        );
        assert_eq!(update_url_from_args(&args(&["app", "--update-url"])), None);
        // 같은 인자가 두 번이면 첫 값
        assert_eq!(
            arg_value(&args(&["app", "--desk", "a", "--desk", "b"]), "desk").as_deref(),
            Some("a")
        );
    }

    #[test]
    fn desk_url_normalizes_scheme_path_and_trailing_slash() {
        assert_eq!(
            normalize_desk_url("desk.example.com").unwrap(),
            "https://desk.example.com"
        );
        assert_eq!(
            normalize_desk_url("  https://desk.example.com/  ").unwrap(),
            "https://desk.example.com"
        );
        // 브라우저 주소창에서 복사한 데스크 안 경로는 떼어 낸다
        assert_eq!(
            normalize_desk_url("http://localhost:3000/files?x=1#y").unwrap(),
            "http://localhost:3000"
        );
        assert_eq!(
            normalize_desk_url("https://desk.example.com/admin/").unwrap(),
            "https://desk.example.com"
        );
        assert_eq!(
            normalize_desk_url("https://host.example/desk-a/files").unwrap(),
            "https://host.example/desk-a"
        );
        // 하위 경로 데스크는 경로를 남긴다 — 이름이 비슷해도 데스크 안 경로가 아니면 그대로
        assert_eq!(
            normalize_desk_url("https://host.example/desk-a/").unwrap(),
            "https://host.example/desk-a"
        );
        assert_eq!(
            normalize_desk_url("https://host.example/myfiles").unwrap(),
            "https://host.example/myfiles"
        );
        assert_eq!(normalize_desk_url("https://files/files").unwrap(), "https://files");
        assert_eq!(
            normalize_desk_url("https://desk.example.com/files/files/").unwrap(),
            "https://desk.example.com"
        );
        assert_eq!(normalize_desk_url(""), Err("empty"));
        assert_eq!(normalize_desk_url("ftp://x.example"), Err("scheme"));
        assert_eq!(normalize_desk_url("https://user:pw@x.example"), Err("credentials"));
        assert!(normalize_desk_url("https://").is_err());
    }

    #[test]
    fn settings_round_trip_survives_missing_fields() {
        let parsed: Settings = serde_json::from_str(r#"{"deskUrl":"https://d.example"}"#).unwrap();
        assert_eq!(parsed.desk_url.as_deref(), Some("https://d.example"));
        assert!(parsed.always_on_top);
        assert_eq!(parsed.window, None);
        let broken: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(broken, Settings::default());
        // 옛 형식(물리 width/height)은 창 항목만 버린다 — 파일 전체가 깨져 기본값으로 가지 않게
        let legacy: Settings = serde_json::from_str(
            r#"{"deskUrl":"https://d.example","window":{"x":1,"y":2,"width":404,"height":646}}"#,
        )
        .unwrap_or_default();
        assert_eq!(legacy.desk_url.as_deref(), Some("https://d.example"));
        assert_eq!(legacy.window, None);
    }

    #[test]
    fn save_and_load_round_trip() {
        let dir = std::env::temp_dir().join(format!(
            "sharedesk-widget-settings-{}",
            std::process::id()
        ));
        let settings = Settings {
            desk_url: Some("https://d.example".into()),
            always_on_top: false,
            window: Some(WindowRect { x: 10, y: 20, logical_width: 300.0, logical_height: 400.5 }),
        };
        save(&dir, &settings).unwrap();
        assert_eq!(load(&dir), settings);
        fs::remove_dir_all(&dir).unwrap();
    }
}
