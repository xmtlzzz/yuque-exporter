// Windows subsystem so a release build opens without a console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{Manager, RunEvent, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// The sidecar owns the HTTP server and, through it, every export job.
struct Sidecar(Mutex<Option<CommandChild>>);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let port = std::env::var("YUQUE_EXPORTER_PORT").unwrap_or_else(|_| "7878".to_string());

            // Start the sidecar once, before the window tries to load.
            {
                let state = app.state::<Sidecar>();
                let mut guard = state.0.lock().expect("sidecar lock");
                if guard.is_none() {
                    let cmd = app
                        .shell()
                        .sidecar("yuque-exporter-core")
                        .expect("sidecar binary missing")
                        .args(["--port", &port, "--no-open"]);
                    let (mut rx, child) = cmd.spawn().expect("failed to start sidecar");
                    *guard = Some(child);

                    // Drain sidecar output so its pipe never fills and stalls it.
                    tauri::async_runtime::spawn(async move {
                        while let Some(event) = rx.recv().await {
                            if let tauri_plugin_shell::process::CommandEvent::Stdout(line) = event {
                                println!("[sidecar] {}", String::from_utf8_lossy(&line));
                            }
                        }
                    });
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                let url = format!("http://127.0.0.1:{}", port);
                // The window may load before the server binds; retry briefly.
                std::thread::spawn(move || {
                    for _ in 0..80 {
                        if std::net::TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
                            break;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(250));
                    }
                    if let Ok(parsed) = url.parse() {
                        let _ = window.navigate(parsed);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                let state: State<Sidecar> = app.state();
                let mut guard = state.0.lock().expect("sidecar lock");
                if let Some(child) = guard.take() {
                    let _ = child.kill();
                }
            }
        });
}
