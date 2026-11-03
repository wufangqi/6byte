fn main() {
    #[cfg(windows)]
    {
        // The unit-test harness links the Tauri GUI stack. It lacks Tauri's
        // application manifest, so ask the linker to embed the comctl32 v6
        // dependency explicitly; without it the test binary dies at startup
        // with STATUS_ENTRYPOINT_NOT_FOUND (TaskDialogIndirect is v6-only).
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
    tauri_build::build()
}
