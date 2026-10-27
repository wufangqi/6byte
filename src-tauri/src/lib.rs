mod ai;
mod bigfile;
mod codec;
mod commands;
mod grep;
mod secrets;
mod skip;
mod tree;
mod watcher;

use std::sync::Arc;

use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(bigfile::LargeFileCache::default())
        .manage(ai::AiHub::default())
        .manage(secrets::AiSecrets::system())
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(watcher::FileWatcher::new(Arc::new(move |event| {
                let _ = handle.emit("file-changed", event);
            })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::read_file,
            commands::write_file,
            commands::stat_file,
            commands::rename_file,
            commands::open_document,
            commands::read_range,
            commands::grep_files,
            commands::save_asset,
            commands::read_binary_base64,
            tree::list_dir_children,
            tree::reveal_in_os,
            commands::watch_file,
            commands::unwatch_file,
            ai::ai_start,
            ai::ai_cancel,
            ai::ai_set_key,
            ai::ai_bound_origin,
            ai::ai_clear_key,
            ai::ai_has_key,
            ai::ai_probe,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
