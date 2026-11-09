use std::error::Error;
use std::fs;
use std::sync::mpsc::Sender;
use std::thread;
use std::time::SystemTime;

use evdev::{Device, EventSummary, KeyCode};

use crate::events::KeyEvent;

/// Mapowanie evdev KeyCode → czytelna nazwa klawisza (zgodna z nazwami XKeysymToString,
/// żeby nie łamać kompatybilności z parsowaniem w db.rs)
fn keycode_to_name(key: KeyCode) -> String {
    match key {
        KeyCode::KEY_A => "a",
        KeyCode::KEY_B => "b",
        KeyCode::KEY_C => "c",
        KeyCode::KEY_D => "d",
        KeyCode::KEY_E => "e",
        KeyCode::KEY_F => "f",
        KeyCode::KEY_G => "g",
        KeyCode::KEY_H => "h",
        KeyCode::KEY_I => "i",
        KeyCode::KEY_J => "j",
        KeyCode::KEY_K => "k",
        KeyCode::KEY_L => "l",
        KeyCode::KEY_M => "m",
        KeyCode::KEY_N => "n",
        KeyCode::KEY_O => "o",
        KeyCode::KEY_P => "p",
        KeyCode::KEY_Q => "q",
        KeyCode::KEY_R => "r",
        KeyCode::KEY_S => "s",
        KeyCode::KEY_T => "t",
        KeyCode::KEY_U => "u",
        KeyCode::KEY_V => "v",
        KeyCode::KEY_W => "w",
        KeyCode::KEY_X => "x",
        KeyCode::KEY_Y => "y",
        KeyCode::KEY_Z => "z",
        KeyCode::KEY_1 => "1",
        KeyCode::KEY_2 => "2",
        KeyCode::KEY_3 => "3",
        KeyCode::KEY_4 => "4",
        KeyCode::KEY_5 => "5",
        KeyCode::KEY_6 => "6",
        KeyCode::KEY_7 => "7",
        KeyCode::KEY_8 => "8",
        KeyCode::KEY_9 => "9",
        KeyCode::KEY_0 => "0",
        KeyCode::KEY_SPACE => "space",
        KeyCode::KEY_ENTER => "Return",
        KeyCode::KEY_TAB => "Tab",
        KeyCode::KEY_BACKSPACE => "BackSpace",
        KeyCode::KEY_ESC => "Escape",
        KeyCode::KEY_MINUS => "minus",
        KeyCode::KEY_EQUAL => "equal",
        KeyCode::KEY_LEFTBRACE => "bracketleft",
        KeyCode::KEY_RIGHTBRACE => "bracketright",
        KeyCode::KEY_SEMICOLON => "semicolon",
        KeyCode::KEY_APOSTROPHE => "apostrophe",
        KeyCode::KEY_GRAVE => "grave",
        KeyCode::KEY_BACKSLASH => "backslash",
        KeyCode::KEY_COMMA => "comma",
        KeyCode::KEY_DOT => "period",
        KeyCode::KEY_SLASH => "slash",
        KeyCode::KEY_LEFTSHIFT => "Shift_L",
        KeyCode::KEY_RIGHTSHIFT => "Shift_R",
        KeyCode::KEY_LEFTCTRL => "Control_L",
        KeyCode::KEY_RIGHTCTRL => "Control_R",
        KeyCode::KEY_LEFTALT => "Alt_L",
        KeyCode::KEY_RIGHTALT => "Alt_R",
        KeyCode::KEY_LEFTMETA => "Super_L",
        KeyCode::KEY_RIGHTMETA => "Super_R",
        KeyCode::KEY_CAPSLOCK => "Caps_Lock",
        KeyCode::KEY_F1 => "F1",
        KeyCode::KEY_F2 => "F2",
        KeyCode::KEY_F3 => "F3",
        KeyCode::KEY_F4 => "F4",
        KeyCode::KEY_F5 => "F5",
        KeyCode::KEY_F6 => "F6",
        KeyCode::KEY_F7 => "F7",
        KeyCode::KEY_F8 => "F8",
        KeyCode::KEY_F9 => "F9",
        KeyCode::KEY_F10 => "F10",
        KeyCode::KEY_F11 => "F11",
        KeyCode::KEY_F12 => "F12",
        KeyCode::KEY_UP => "Up",
        KeyCode::KEY_DOWN => "Down",
        KeyCode::KEY_LEFT => "Left",
        KeyCode::KEY_RIGHT => "Right",
        KeyCode::KEY_HOME => "Home",
        KeyCode::KEY_END => "End",
        KeyCode::KEY_PAGEUP => "Prior",
        KeyCode::KEY_PAGEDOWN => "Next",
        KeyCode::KEY_INSERT => "Insert",
        KeyCode::KEY_DELETE => "Delete",
        KeyCode::KEY_PRINT => "Print",
        KeyCode::KEY_SCROLLLOCK => "Scroll_Lock",
        KeyCode::KEY_PAUSE => "Pause",
        KeyCode::KEY_NUMLOCK => "Num_Lock",
        KeyCode::KEY_KP0 => "KP_0",
        KeyCode::KEY_KP1 => "KP_1",
        KeyCode::KEY_KP2 => "KP_2",
        KeyCode::KEY_KP3 => "KP_3",
        KeyCode::KEY_KP4 => "KP_4",
        KeyCode::KEY_KP5 => "KP_5",
        KeyCode::KEY_KP6 => "KP_6",
        KeyCode::KEY_KP7 => "KP_7",
        KeyCode::KEY_KP8 => "KP_8",
        KeyCode::KEY_KP9 => "KP_9",
        KeyCode::KEY_KPENTER => "KP_Enter",
        KeyCode::KEY_KPDOT => "KP_Decimal",
        KeyCode::KEY_KPPLUS => "KP_Add",
        KeyCode::KEY_KPMINUS => "KP_Subtract",
        KeyCode::KEY_KPASTERISK => "KP_Multiply",
        KeyCode::KEY_KPSLASH => "KP_Divide",
        _ => "",
    }
    .to_string()
}

/// Wyszukuje urządzenia wejściowe będące prawdziwymi klawiaturami
/// (posiadające EV_KEY + EV_LED capability — identyczna logika co w rust-keylogger-evdev)
fn find_keyboard_devices() -> Vec<String> {
    let mut keyboards = Vec::new();

    if let Ok(content) = fs::read_to_string("/proc/bus/input/devices") {
        let mut current_handlers: Vec<String> = Vec::new();
        let mut has_led = false;
        let mut has_key_capability = false;

        for line in content.lines() {
            if line.starts_with("N: Name=") {
                if has_led && has_key_capability {
                    for h in &current_handlers {
                        keyboards.push(format!("/dev/input/{}", h));
                    }
                }
                current_handlers.clear();
                has_led = false;
                has_key_capability = false;
            } else if line.starts_with("H: Handlers=") {
                let handlers_str = line.trim_start_matches("H: Handlers=");
                current_handlers = handlers_str
                    .split_whitespace()
                    .filter(|h| h.starts_with("event"))
                    .map(|h| h.to_string())
                    .collect();
            } else if line.starts_with("B: EV=") {
                if let Ok(v) = u64::from_str_radix(line.trim_start_matches("B: EV="), 16) {
                    has_led = (v & 0x20000) != 0;
                    has_key_capability = (v & 0x2) != 0;
                }
            }
        }
        // Ostatni blok
        if has_led && has_key_capability {
            for h in &current_handlers {
                keyboards.push(format!("/dev/input/{}", h));
            }
        }
    }

    keyboards
}

/// Główna pętla zdarzeń — uruchamia wątek per urządzenie i zbiera eventy przez mpsc
pub fn run(tx: Sender<KeyEvent>) -> Result<(), Box<dyn Error>> {
    let keyboards = find_keyboard_devices();

    if keyboards.is_empty() {
        return Err(
            "Nie znaleziono klawiatur w /dev/input/. Sprawdź uprawnienia (grupa 'input' lub sudo).".into(),
        );
    }

    eprintln!("[evdev_logger] Znalezione klawiatury:");
    for kb in &keyboards {
        if let Ok(dev) = Device::open(kb) {
            eprintln!("  {} → {}", kb, dev.name().unwrap_or("(brak nazwy)"));
        }
    }
    eprintln!("[evdev_logger] Nasłuchiwanie zdarzeń klawiatury...");

    // Dla każdej klawiatury uruchamiamy osobny wątek
    let mut handles = Vec::new();
    for path in keyboards {
        let tx = tx.clone();
        let handle = thread::spawn(move || {
            let mut device = match Device::open(&path) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("[evdev_logger] Błąd otwierania {}: {}", path, e);
                    return;
                }
            };

            loop {
                match device.fetch_events() {
                    Ok(events) => {
                        for event in events {
                            let (_event_type_str, key_code, value) = match event.destructure() {
                                EventSummary::Key(_, kc, v) => ("KEY", kc, v),
                                _ => continue,
                            };

                            // value: 1 = press, 0 = release, 2 = repeat (ignorujemy repeat)
                            if value == 2 {
                                continue;
                            }

                            let event_type = if value == 1 { "PRESS" } else { "RELEASE" };
                            let key_name = keycode_to_name(key_code);
                            let name_display = if key_name.is_empty() {
                                format!("{:?}", key_code)
                            } else {
                                key_name.clone()
                            };

                            // Keycode evdev jest offsetem +8 względem X11 keycode
                            // (X11 dodaje 8 do evdev scancode — zachowujemy compat z istniejącą bazą)
                            let raw_code = key_code.0 as u32;
                            let x11_keycode = raw_code + 8;

                            eprintln!("Key {}: {} (evcode={})", event_type.to_lowercase(), name_display, raw_code);

                            let _ = tx.send(KeyEvent {
                                event_type,
                                key_name: name_display,
                                keycode: x11_keycode,
                                timestamp: SystemTime::now(),
                            });
                        }
                    }
                    Err(e) => {
                        eprintln!("[evdev_logger] Błąd odczytu z {}: {}", path, e);
                        // Próbuj ponownie za chwilę zamiast padać
                        thread::sleep(std::time::Duration::from_secs(1));
                        break;
                    }
                }
            }
        });
        handles.push(handle);
    }

    // Blokuj wątek główny — wątki klawiatur działają w tle
    for h in handles {
        let _ = h.join();
    }

    Ok(())
}
