// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Sur le PC, ce binaire sert de boucle de développement (`tauri dev`) ; sur téléphone, c'est `run` de la bibliothèque.
fn main() {
    zenytt_mobile_lib::run()
}
