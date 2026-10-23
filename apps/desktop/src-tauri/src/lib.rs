// Les commandes Tauri reçoivent chaque état partagé en paramètre : leur nombre dépasse vite 7.
#![allow(clippy::too_many_arguments)]

mod commands;
mod legacy;
mod rdp_bridge;
mod sessions;
mod shortcut;
mod store;
mod tray;
mod vnc_bridge;

use commands::{
    assistant, backups, dashboard, databases, deploy, docker, files, github, identities, logs, mesh, monitoring, rdp, redis, security, servers,
    share, sites, sync, system, terminal, tunnels, vms, workspace,
};
use tauri::Manager;
use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

/// Renvoie la version de l'app, utilisée par l'UI pour vérifier que le pont Rust fonctionne.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Refuse toute commande quand Zenytt est verrouillé, sauf celles de l'écran de verrouillage.
/// Le contrôle est fait ici, une fois pour toutes, plutôt que dans chaque commande : une commande
/// ajoutée plus tard est protégée d'office.
fn guarded<R: tauri::Runtime>(
    handler: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke| {
        if workspace::is_locked() && !workspace::ALLOWED_WHILE_LOCKED.contains(&invoke.message.command()) {
            invoke.resolver.reject("Zenytt est verrouillé");
            return true;
        }
        handler(invoke)
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Une seule instance : une deuxième fenêtre se disputerait les ports des tunnels et
        // écraserait les réglages de la première. Relancer Zenytt ramène la fenêtre existante.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::show_main(app)))
        // Lancement à l'ouverture de session (réglage), réduit dans la zone de notification.
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![tray::HIDDEN_ARG])))
        // Journal local de l'app (dossier de logs, 5 fichiers de 2 Mo), sans aucun secret.
        .plugin(
            tauri_plugin_log::Builder::new()
                .clear_targets()
                .target(Target::new(TargetKind::LogDir { file_name: Some("zenytt".into()) }))
                .target(Target::new(TargetKind::Stdout))
                .level(log::LevelFilter::Info)
                .level_for("russh", log::LevelFilter::Warn)
                .level_for("russh_sftp", log::LevelFilter::Warn)
                .max_file_size(2_000_000)
                .rotation_strategy(RotationStrategy::KeepSome(5))
                .timezone_strategy(TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        // Mises à jour signées, publiées par la CI sur les releases GitHub.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Verrouillage configuré : Zenytt démarre verrouillé, avant de servir la moindre commande.
            // Sinon quitter puis relancer l'app suffirait à lever le verrou.
            workspace::app_lock_engage();
            let dir = app.path().app_config_dir()?;
            // Installation de la version précédente : profils repris avant la première lecture.
            legacy::migrate_local(&dir);
            let store = store::Store::open(&dir);
            if let Some(w) = store.warning() {
                log::warn!("{w}");
            }
            log::info!("Zenytt {} démarré", env!("CARGO_PKG_VERSION"));
            app.manage(store);
            app.manage(store::AuditLog::new(&dir, "app"));
            app.manage(sessions::Sessions::new());
            app.manage(monitoring::Monitor::default());
            app.manage(docker::DockerAccess::default());
            app.manage(vms::VmAccess::default());
            app.manage(commands::geo::Geo::default());
            app.manage(files::Transfers::default());
            app.manage(dashboard::DashboardCache::default());
            app.manage(tunnels::Tunnels::default());
            app.manage(logs::LogStreams::default());
            app.manage(share::Shares::default());
            app.manage(assistant::Assistant::default());
            app.manage(rdp_bridge::Bridges::default());
            legacy::start(app.handle());
            tray::setup(app.handle())?;
            // La fenêtre est créée cachée : elle n'apparaît que si l'app n'a pas été lancée
            // automatiquement à l'ouverture de session (elle reste alors dans la zone de notification).
            if !std::env::args().any(|a| a == tray::HIDDEN_ARG) {
                tray::show_main(app.handle());
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                handle.state::<tunnels::Tunnels>().autostart(&handle).await;
            });
            Ok(())
        })
        // Fermer la fenêtre ne quitte pas forcément : l'interface propose de réduire dans la zone
        // de notification (ou applique le choix retenu).
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" && tray::on_close_requested(window.app_handle()) {
                    api.prevent_close();
                }
            }
        })
        .invoke_handler(guarded(tauri::generate_handler![
            app_version,
            tray::app_ui_ready,
            tray::tray_update,
            tray::app_hide,
            tray::app_quit,
            tray::autostart_get,
            tray::autostart_set,
            servers::servers_list,
            servers::server_save,
            servers::server_delete,
            servers::servers_set_group,
            servers::host_trust,
            servers::ssh_connect,
            servers::ssh_disconnect,
            servers::ssh_diagnose,
            servers::snippets_list,
            servers::snippet_save,
            servers::snippet_delete,
            servers::putty_sessions,
            servers::ssh_config_sessions,
            servers::server_set_ai_access,
            identities::identities_list,
            identities::identity_save,
            identities::identity_delete,
            sync::sync_get,
            sync::sync_set,
            sync::sync_now,
            sync::sync_server_status,
            sync::sync_server_install,
            sync::sync_pairing_code,
            sync::sync_join,
            rdp::desktops_list,
            rdp::desktop_save,
            rdp::desktop_delete,
            rdp::desktop_launch,
            rdp::desktop_session_open,
            rdp::desktop_session_close,
            rdp::vnc_session_open,
            databases::db_instances,
            databases::db_version,
            databases::db_create,
            databases::db_schema_sql,
            databases::db_column_types,
            databases::db_login_get,
            databases::db_login_set,
            databases::db_backups,
            databases::db_import_dir,
            databases::db_backup,
            databases::db_restore,
            databases::db_backup_delete,
            databases::db_users,
            databases::db_user_create,
            databases::db_user_password,
            databases::db_user_drop,
            databases::db_activity,
            databases::db_kill,
            databases::db_databases,
            databases::db_tables,
            databases::db_query,
            databases::db_columns,
            databases::db_table_query,
            databases::db_update_cell_sql,
            databases::db_delete_row_sql,
            databases::db_insert_row_sql,
            databases::db_sqlite_files,
            redis::redis_servers,
            redis::redis_overview,
            redis::redis_scan,
            redis::redis_key,
            redis::redis_delete,
            redis::redis_set,
            redis::redis_expire,
            redis::redis_command,
            redis::redis_blocked,
            terminal::term_open,
            terminal::term_history,
            terminal::term_write,
            terminal::tmux_scroll,
            terminal::term_resize,
            terminal::term_close,
            terminal::shell_history,
            terminal::term_cwd,
            share::term_share_start,
            share::term_share_send,
            share::term_share_stop,
            share::term_join,
            share::term_join_write,
            share::term_join_close,
            assistant::ai_get,
            assistant::ai_set,
            assistant::ai_ask,
            assistant::ai_answer_proposal,
            assistant::ai_reset,
            files::fs_home,
            files::fs_find,
            files::fs_grep,
            files::fs_archive_name,
            files::fs_archive,
            files::fs_archive_list,
            files::fs_extract,
            files::fs_list,
            files::fs_exec,
            files::fs_read,
            files::fs_read_range,
            files::fs_write,
            files::fs_stat,
            files::fs_mkdir,
            files::fs_create,
            files::fs_rename,
            files::fs_remove,
            files::fs_chmod,
            files::fs_download,
            files::fs_upload,
            files::fs_cancel,
            files::fs_copy_between,
            monitoring::mon_metrics,
            system::system_info,
            system::system_power,
            system::system_cancel_power,
            system::system_wait_online,
            system::system_set_hostname,
            system::system_timezones,
            system::system_set_timezone,
            system::system_updates,
            system::system_apply_updates,
            system::provider_get,
            system::provider_set,
            system::provider_test,
            system::provider_action,
            monitoring::mon_processes,
            monitoring::mon_kill,
            monitoring::mon_services,
            monitoring::mon_service_action,
            monitoring::mon_service_logs,
            monitoring::agent_info,
            monitoring::agent_history,
            monitoring::agent_install,
            monitoring::agent_uninstall,
            monitoring::agent_save_config,
            monitoring::agent_test_notify,
            monitoring::disk_rules_list,
            monitoring::disk_rule_save,
            monitoring::schedule_list,
            monitoring::crontab_save,
            monitoring::timer_run,
            docker::docker_overview,
            docker::docker_stats,
            docker::docker_container_action,
            docker::docker_inspect,
            docker::docker_logs,
            docker::docker_compose_action,
            docker::docker_compose_command,
            docker::docker_compose_create,
            docker::docker_compose_file_info,
            docker::docker_occasional_set,
            docker::docker_on_purpose_set,
            mesh::mesh_list,
            mesh::mesh_create,
            mesh::mesh_add,
            mesh::mesh_remove,
            mesh::mesh_repair,
            mesh::mesh_delete,
            mesh::mesh_status,
            vms::vm_overview,
            vms::vm_detail,
            vms::vm_stats,
            vms::vm_action,
            vms::vm_delete,
            vms::vm_console_open,
            vms::vm_console_external,
            vms::vm_serial_command,
            vms::vm_vnc_restrict,
            docker::docker_compose_launch,
            docker::docker_projects_under,
            docker::docker_move_folder,
            docker::docker_compose_template,
            docker::docker_storage,
            docker::docker_remove_image,
            docker::docker_prune,
            docker::docker_catalog,
            docker::docker_catalog_defaults,
            docker::docker_catalog_render,
            docker::docker_volumes,
            docker::docker_remove_volume,
            docker::registries_list,
            docker::registry_save,
            docker::registry_delete,
            docker::registry_sessions,
            docker::registry_login,
            docker::registry_logout,
            docker::docker_restrict_preview,
            docker::docker_restrict_apply,
            sites::sites_state,
            sites::sites_read,
            sites::sites_write,
            sites::sites_set_enabled,
            sites::sites_delete,
            sites::sites_test,
            sites::sites_reload,
            sites::sites_plan,
            sites::sites_resolve,
            sites::sites_create_app,
            sites::sites_certbot,
            sites::sites_renew,
            sites::sites_check,
            sites::domains_check,
            sites::sites_preview,
            workspace::ui_state_get,
            workspace::ui_state_set,
            workspace::store_warning,
            legacy::app_notices,
            workspace::app_lock_get,
            workspace::app_lock_set,
            workspace::app_is_locked,
            workspace::app_lock_engage,
            workspace::app_unlock,
            workspace::logs_open_dir,
            workspace::settings_export,
            workspace::settings_import_encrypted,
            workspace::settings_import,
            workspace::settings_import_text,
            workspace::settings_text_encrypted,
            workspace::settings_share,
            workspace::settings_share_code,
            workspace::audit_list,
            workspace::tmux_check,
            workspace::tmux_install,
            workspace::tmux_sessions,
            workspace::tmux_kill,
            workspace::mcp_config,
            workspace::save_text_file,
            workspace::save_binary_file,
            workspace::read_local_file,
            workspace::read_text_file,
            dashboard::dashboard_summary,
            tunnels::tunnels_list,
            tunnels::tunnel_save,
            tunnels::tunnel_delete,
            tunnels::tunnel_start,
            tunnels::tunnel_stop,
            tunnels::tunnel_free_port,
            logs::logs_sources,
            logs::logs_start,
            logs::logs_stop,
            sites::nginx_backups,
            sites::nginx_backup_diff,
            sites::nginx_backup_restore,
            security::security_audit,
            security::security_fix_plan,
            security::security_fix_apply,
            security::findings_ignored,
            security::finding_ignore,
            security::finding_unignore,
            security::f2b_state,
            security::f2b_unban,
            security::f2b_set_ignore,
            security::f2b_ban,
            security::f2b_settings,
            security::f2b_settings_set,
            security::f2b_events,
            security::f2b_attempts,
            security::ip_labels_list,
            security::ip_label_set,
            commands::geo::geo_status,
            commands::geo::geo_install,
            commands::geo::geo_lookup,
            security::my_public_ip,
            security::fw_state,
            security::fw_allow,
            security::fw_delete,
            security::access_users,
            security::access_add_key,
            security::access_remove_key,
            backups::backup_overview,
            backups::backup_save,
            backups::backup_snapshots,
            backups::backup_list,
            backups::backup_restore,
            backups::backup_put_back,
            backups::backup_import_dump,
            backups::backup_stage_download,
            backups::backup_check,
            backups::backup_install_restic,
            backups::backup_mirror,
            deploy::deploy_suggest_host,
            deploy::deploy_prepare,
            deploy::deploy_keys,
            deploy::deploy_sudo_risk,
            deploy::deploy_key_create,
            deploy::deploy_key_revoke,
            github::github_status,
            github::github_set_token,
            github::github_repos,
            github::github_clones,
            github::github_clone_state,
            github::github_clone,
            github::github_pull,
        ]))
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Tauri");
}
