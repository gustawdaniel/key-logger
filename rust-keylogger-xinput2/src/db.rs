use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};
use rusqlite::{params, Connection};

use crate::events::KeyEvent;

fn load_blacklist() -> Vec<String> {
    let custom_path = env::var("KEYLOGGER_BLACKLIST_PATH").ok();
    let home_dir = env::var("HOME").unwrap_or_else(|_| ".".to_string());
    let default_path = PathBuf::from(home_dir)
        .join(".config")
        .join("rust-keylogger")
        .join("blacklist.txt");

    let path = custom_path.map(PathBuf::from).unwrap_or(default_path);

    if let Ok(content) = fs::read_to_string(&path) {
        let list: Vec<String> = content
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty() && !l.starts_with('#'))
            .collect();
        println!("[rust-keylogger] Wczytano {} wzorców czarnej listy z: {}", list.len(), path.display());
        list
    } else {
        Vec::new()
    }
}

fn key_name_to_char(key_name: &str, is_shift: bool) -> Option<char> {
    if is_shift {
        match key_name {
            "1" => Some('!'),
            "2" => Some('@'),
            "3" => Some('#'),
            "4" => Some('$'),
            "5" => Some('%'),
            "6" => Some('^'),
            "7" => Some('&'),
            "8" => Some('*'),
            "9" => Some('('),
            "0" => Some(')'),
            "minus" => Some('_'),
            "equal" => Some('+'),
            "bracketleft" => Some('{'),
            "bracketright" => Some('}'),
            "semicolon" => Some(':'),
            "apostrophe" => Some('"'),
            "grave" => Some('~'),
            "backslash" => Some('|'),
            "comma" => Some('<'),
            "period" => Some('>'),
            "slash" | "question" => Some('?'),
            "numbersign" => Some('#'),
            s if s.len() == 1 => s.chars().next().map(|c| c.to_ascii_uppercase()),
            _ => None,
        }
    } else {
        match key_name {
            "space" => Some(' '),
            "Return" => Some('\n'),
            "Tab" => Some('\t'),
            "minus" => Some('-'),
            "equal" => Some('='),
            "semicolon" => Some(';'),
            "apostrophe" => Some('\''),
            "grave" => Some('`'),
            "backslash" => Some('\\'),
            "comma" => Some(','),
            "period" => Some('.'),
            "slash" => Some('/'),
            "numbersign" => Some('#'),
            s if s.len() == 1 => s.chars().next().map(|c| c.to_ascii_lowercase()),
            _ => None,
        }
    }
}

/// Zwraca długość najdłuższego sufiksu `buffer_str`, który jest prefiksem dowolnego hasła z czarnej listy.
/// Jeśli 0 -> żaden fragment wpisanego tekstu nie może być początkiem hasła (można zrzucić natychmiast, 0ms delay).
fn longest_matching_prefix_len(buffer_str: &str, blacklist: &[String]) -> usize {
    for len in (1..=buffer_str.len()).rev() {
        let suffix = &buffer_str[buffer_str.len() - len..];
        for secret in blacklist {
            if secret.starts_with(suffix) {
                return len;
            }
        }
    }
    0
}

struct PendingEntry {
    ts: i64,
    event_type: String,
    key_name: String,
    keycode: u32,
    ch: Option<char>,
}

pub fn start_db_thread(rx: Receiver<KeyEvent>) {
    thread::spawn(move || {
        let db_path = env::var("KEYLOGGER_DB_PATH").unwrap_or_else(|_| {
            let home_dir = env::var("HOME").unwrap_or_else(|_| ".".to_string());
            let path = PathBuf::from(home_dir)
                .join(".local")
                .join("share")
                .join("rust-keylogger");

            if let Err(e) = std::fs::create_dir_all(&path) {
                eprintln!("Błąd podczas tworzenia katalogu na bazę {}: {}", path.display(), e);
            }

            path.join("keylog.db").to_string_lossy().into_owned()
        });

        println!("Baza SQLite: {}", db_path);

        let mut conn = match Connection::open(&db_path) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("Nie udało się połączyć z bazą danych: {}", e);
                return;
            }
        };

        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");

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

        let mut blacklist = load_blacklist();
        let mut last_blacklist_reload = Instant::now();
        let mut is_shift = false;
        let mut buffer: Vec<PendingEntry> = Vec::with_capacity(64);

        let flush_to_db = |conn: &mut Connection, items: Vec<PendingEntry>| {
            if items.is_empty() {
                return;
            }
            if let Ok(tx) = conn.transaction() {
                {
                    let mut stmt = match tx.prepare_cached(
                        "INSERT INTO keystrokes (timestamp, event_type, key_name, keycode) VALUES (?1, ?2, ?3, ?4)"
                    ) {
                        Ok(s) => s,
                        Err(e) => {
                            eprintln!("Błąd prepare statement: {}", e);
                            return;
                        }
                    };
                    for item in items {
                        if let Err(e) = stmt.execute(params![item.ts, item.event_type, item.key_name, item.keycode]) {
                            eprintln!("Błąd wstawiania do bazy danych: {}", e);
                        }
                    }
                }
                let _ = tx.commit();
            }
        };

        loop {
            // Przeładuj czarną listę co 30 sekund
            if last_blacklist_reload.elapsed() > Duration::from_secs(30) {
                blacklist = load_blacklist();
                last_blacklist_reload = Instant::now();
            }

            // Szybki timeout 80ms — bez zauważalnego delaya dla człowieka
            match rx.recv_timeout(Duration::from_millis(80)) {
                Ok(event) => {
                    let ts = match event.timestamp.duration_since(UNIX_EPOCH) {
                        Ok(n) => n.as_millis() as i64,
                        Err(_) => 0,
                    };

                    if event.key_name == "Shift_L" || event.key_name == "Shift_R" {
                        is_shift = event.event_type == "PRESS";
                    }

                    let ch = if event.event_type == "PRESS" {
                        key_name_to_char(&event.key_name, is_shift)
                    } else {
                        None
                    };

                    buffer.push(PendingEntry {
                        ts,
                        event_type: event.event_type.to_string(),
                        key_name: event.key_name,
                        keycode: event.keycode,
                        ch,
                    });

                    // 1. Sprawdź czy pełne hasło zostało właśnie wpisane
                    if !blacklist.is_empty() {
                        let text: String = buffer.iter().filter_map(|k| k.ch).collect();
                        let mut found_secret = false;

                        for secret in &blacklist {
                            if let Some(pos) = text.find(secret) {
                                let mut char_idx = 0;
                                let mut remove_indices = Vec::new();

                                for (buf_idx, item) in buffer.iter().enumerate() {
                                    if item.ch.is_some() {
                                        if char_idx >= pos && char_idx < pos + secret.len() {
                                            remove_indices.push(buf_idx);
                                        }
                                        char_idx += 1;
                                    }
                                }

                                for &idx in remove_indices.iter().rev() {
                                    buffer.remove(idx);
                                }
                                println!(
                                    "[rust-keylogger] [ANONIMIZACJA] Wycięto sekwencję hasła (długość: {} znaków).",
                                    secret.len()
                                );
                                found_secret = true;
                                break;
                            }
                        }

                        if found_secret {
                            continue;
                        }
                    }

                    // 2. ZERO-DELAY FLUSH: Sprawdź czy końcówka bufora pasuje do jakiegokolwiek prefiksu hasła
                    let text: String = buffer.iter().filter_map(|k| k.ch).collect();
                    let prefix_len = if blacklist.is_empty() {
                        0
                    } else {
                        longest_matching_prefix_len(&text, &blacklist)
                    };

                    if prefix_len == 0 {
                        // Żaden fragment nie przypomina hasła -> zrzuć natychmiast (0ms delay)!
                        let to_flush = std::mem::replace(&mut buffer, Vec::with_capacity(64));
                        flush_to_db(&mut conn, to_flush);
                    } else {
                        // Trzymamy tylko znaki wchodzące w skład prefiksu, resztę wcześniejszych zrzucamy
                        let total_chars = text.len();
                        let safe_chars_count = total_chars.saturating_sub(prefix_len);

                        let mut char_count = 0;
                        let mut split_idx = 0;
                        for (idx, item) in buffer.iter().enumerate() {
                            if item.ch.is_some() {
                                char_count += 1;
                                if char_count > safe_chars_count {
                                    split_idx = idx;
                                    break;
                                }
                            }
                        }

                        if split_idx > 0 {
                            let to_flush: Vec<PendingEntry> = buffer.drain(..split_idx).collect();
                            flush_to_db(&mut conn, to_flush);
                        }
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    // Po 80ms pauzy w pisaniu sprawdzamy czarną listę i zrzucamy jeśli brak prefiksu
                    if !buffer.is_empty() {
                        let text: String = buffer.iter().filter_map(|k| k.ch).collect();
                        let prefix_len = if blacklist.is_empty() {
                            0
                        } else {
                            longest_matching_prefix_len(&text, &blacklist)
                        };

                        if prefix_len == 0 || buffer.len() > 32 {
                            let to_flush = std::mem::replace(&mut buffer, Vec::with_capacity(64));
                            flush_to_db(&mut conn, to_flush);
                        }
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    let to_flush = std::mem::replace(&mut buffer, Vec::new());
                    flush_to_db(&mut conn, to_flush);
                    break;
                }
            }
        }
    });
}
