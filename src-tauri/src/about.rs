/// Issue chooser for the public repository. The URL is fixed so the webview cannot open arbitrary links.
const FEEDBACK_URL: &str = "https://github.com/wufangqi/6byte/issues/new/choose";

/// Operating system and CPU architecture, for the About dialog.
#[tauri::command]
pub fn app_platform() -> String {
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

/// Open the issue chooser in the system browser.
#[tauri::command]
pub fn open_feedback() -> Result<(), String> {
    spawn_browser(FEEDBACK_URL).map_err(|error| error.to_string())?;
    Ok(())
}

/// Open one http(s) address in the system browser. Other schemes are refused.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !external_url_allowed(&url) {
        return Err("only http and https links can be opened".into());
    }
    spawn_browser(url.trim()).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn external_url_allowed(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty()
        || trimmed
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    lower.starts_with("https://") || lower.starts_with("http://")
}

fn spawn_browser(url: &str) -> std::io::Result<std::process::Child> {
    #[cfg(windows)]
    {
        std::process::Command::new("explorer").arg(url).spawn()
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(url).spawn()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(url).spawn()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_names_os_and_arch() {
        let platform = app_platform();
        assert!(platform.contains(std::env::consts::OS));
        assert!(platform.contains(std::env::consts::ARCH));
    }

    #[test]
    fn external_links_are_http_only() {
        assert!(external_url_allowed("https://example.com/a"));
        assert!(external_url_allowed("  http://127.0.0.1/x  "));
        assert!(!external_url_allowed("javascript:alert(1)"));
        assert!(!external_url_allowed("file:///C:/secret.txt"));
        assert!(!external_url_allowed("https://example.com/\ncalc"));
        assert!(!external_url_allowed(""));
    }
}
