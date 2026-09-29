//! 트레이 메뉴 문구 — 데스크 언어는 껍데기가 알 수 없으므로 OS 언어를 따른다.
//! 데스크가 지원하는 다섯 언어(en·ko·ja·hi·zh)만 두고 나머지는 영어다.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    Ko,
    Ja,
    Hi,
    Zh,
}

pub struct Labels {
    pub show: &'static str,
    pub hide: &'static str,
    pub always_on_top: &'static str,
    pub autostart: &'static str,
    pub change_desk: &'static str,
    pub open_in_browser: &'static str,
    pub check_update: &'static str,
    pub install_update: &'static str,
    pub up_to_date: &'static str,
    pub update_failed: &'static str,
    pub quit: &'static str,
}

const EN: Labels = Labels {
    show: "Show widget",
    hide: "Hide widget",
    always_on_top: "Always on top",
    autostart: "Start at login",
    change_desk: "Change desk address…",
    open_in_browser: "Open desk in browser",
    check_update: "Check for updates",
    install_update: "Install update {v}",
    up_to_date: "Up to date ({v})",
    update_failed: "Update check failed",
    quit: "Quit",
};

const KO: Labels = Labels {
    show: "위젯 보이기",
    hide: "위젯 숨기기",
    always_on_top: "항상 위",
    autostart: "부팅 시 실행",
    change_desk: "데스크 주소 바꾸기…",
    open_in_browser: "브라우저에서 데스크 열기",
    check_update: "업데이트 확인",
    install_update: "업데이트 설치 {v}",
    up_to_date: "최신 버전입니다 ({v})",
    update_failed: "업데이트 확인 실패",
    quit: "종료",
};

const JA: Labels = Labels {
    show: "ウィジェットを表示",
    hide: "ウィジェットを隠す",
    always_on_top: "常に手前に表示",
    autostart: "ログイン時に起動",
    change_desk: "デスクのアドレスを変更…",
    open_in_browser: "ブラウザでデスクを開く",
    check_update: "アップデートを確認",
    install_update: "アップデート {v} をインストール",
    up_to_date: "最新版です ({v})",
    update_failed: "アップデートの確認に失敗",
    quit: "終了",
};

const HI: Labels = Labels {
    show: "विजेट दिखाएँ",
    hide: "विजेट छिपाएँ",
    always_on_top: "हमेशा ऊपर",
    autostart: "लॉगिन पर शुरू करें",
    change_desk: "डेस्क पता बदलें…",
    open_in_browser: "ब्राउज़र में डेस्क खोलें",
    check_update: "अपडेट जाँचें",
    install_update: "अपडेट {v} इंस्टॉल करें",
    up_to_date: "नवीनतम संस्करण ({v})",
    update_failed: "अपडेट जाँच विफल",
    quit: "बंद करें",
};

const ZH: Labels = Labels {
    show: "显示小组件",
    hide: "隐藏小组件",
    always_on_top: "总在最前",
    autostart: "登录时启动",
    change_desk: "更改桌面地址…",
    open_in_browser: "在浏览器中打开桌面",
    check_update: "检查更新",
    install_update: "安装更新 {v}",
    up_to_date: "已是最新版本 ({v})",
    update_failed: "检查更新失败",
    quit: "退出",
};

impl Lang {
    pub fn detect() -> Self {
        Self::from_tag(sys_locale::get_locale().as_deref())
    }

    pub fn from_tag(tag: Option<&str>) -> Self {
        let Some(tag) = tag else { return Lang::En };
        let primary = tag
            .split(['-', '_'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        match primary.as_str() {
            "ko" => Lang::Ko,
            "ja" => Lang::Ja,
            "hi" => Lang::Hi,
            "zh" => Lang::Zh,
            _ => Lang::En,
        }
    }

    pub fn labels(self) -> &'static Labels {
        match self {
            Lang::En => &EN,
            Lang::Ko => &KO,
            Lang::Ja => &JA,
            Lang::Hi => &HI,
            Lang::Zh => &ZH,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_tag_maps_to_supported_language_or_english() {
        assert_eq!(Lang::from_tag(Some("ko-KR")), Lang::Ko);
        assert_eq!(Lang::from_tag(Some("ja_JP")), Lang::Ja);
        assert_eq!(Lang::from_tag(Some("zh-Hans-CN")), Lang::Zh);
        assert_eq!(Lang::from_tag(Some("hi")), Lang::Hi);
        assert_eq!(Lang::from_tag(Some("fr-FR")), Lang::En);
        assert_eq!(Lang::from_tag(None), Lang::En);
    }

    #[test]
    fn version_placeholders_exist_in_every_language() {
        for lang in [Lang::En, Lang::Ko, Lang::Ja, Lang::Hi, Lang::Zh] {
            let labels = lang.labels();
            assert!(labels.install_update.contains("{v}"));
            assert!(labels.up_to_date.contains("{v}"));
        }
    }
}
