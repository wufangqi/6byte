//! Directories the file tree and cross-file grep both skip.
//! One list, so the two walks cannot drift apart.

/// Build and VCS directories. Dot-directories are also skipped by each caller.
pub const SKIP_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    ".svn",
    ".hg",
    "__pycache__",
    ".idea",
    ".vscode",
    // Kept from the grep walk so search does not start entering these trees.
    ".next",
    "vendor",
];

pub fn is_skipped_dir(name: &str) -> bool {
    SKIP_DIR_NAMES.contains(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shares_the_workspace_ignore_list() {
        for name in [
            ".git",
            "node_modules",
            "target",
            "dist",
            ".svn",
            ".hg",
            "__pycache__",
            ".idea",
            ".vscode",
        ] {
            assert!(is_skipped_dir(name), "{name}");
        }
        assert!(!is_skipped_dir("src"));
        assert!(!is_skipped_dir("notes"));
    }
}
