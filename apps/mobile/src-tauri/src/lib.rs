// Les commandes Tauri reçoivent chaque état partagé en paramètre : leur nombre dépasse vite 7.
#![allow(clippy::too_many_arguments)]

mod files;
mod ops;
mod servers;
mod sessions;
mod sync;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::new().level(log::LevelFilter::Info).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // Données et secrets dans le dossier privé de l'app (protégé par le système).
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            // shortcut: secrets in app-private storage, not Android Keystore/iOS Keychain; upgrade to a keystore plugin before store release
            zenytt_profiles::secrets::use_file(dir.join("secrets.json"));
            let store = zenytt_profiles::Store::open(&dir);
            if let Some(w) = store.warning() {
                log::warn!("{w}");
            }
            app.manage(store);
            app.manage(sessions::Sessions::default());
            app.manage(ops::Monitor::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            servers::servers_list,
            servers::server_save,
            servers::server_delete,
            servers::server_retry,
            servers::host_trust,
            sync::sync_get,
            sync::sync_now,
            sync::sync_join,
            ops::dashboard_summary,
            ops::docker_list,
            ops::docker_action,
            ops::docker_logs,
            ops::f2b_state,
            ops::f2b_unban,
            ops::term_open,
            ops::term_write,
            ops::term_resize,
            ops::term_close,
            files::files_list,
            files::files_download,
            files::files_upload,
            files::files_remove,
            files::files_rename,
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Zenytt Compagnon");
}
