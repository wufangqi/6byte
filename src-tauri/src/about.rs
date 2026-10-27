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
}
