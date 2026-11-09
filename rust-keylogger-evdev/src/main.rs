use evdev::{Device, EventSummary};
use std::fs;
use std::thread;
use std::sync::mpsc;

fn find_keyboard_devices() -> Vec<String> {
    let mut keyboards = Vec::new();

    // Odczytaj /proc/bus/input/devices i znajdź urządzenia z handlerem "kbd leds"
    // (czyli prawdziwe klawiatury, nie power button itp.)
    if let Ok(content) = fs::read_to_string("/proc/bus/input/devices") {
        let mut current_handlers: Vec<String> = Vec::new();
        let mut has_led = false;
        let mut has_key_capability = false;

        for line in content.lines() {
            if line.starts_with("N: Name=") {
                // Nowy blok — zapisz poprzednie jeśli spełnia kryteria
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
                // EV=120013 oznacza klawiaturę z LED
                // Bit 1 (0x2) = KEY, bit 17 (0x20000) = LED
                if let Ok(v) = u64::from_str_radix(line.trim_start_matches("B: EV="), 16) {
                    has_led = (v & 0x20000) != 0;  // LED capability
                    has_key_capability = (v & 0x2) != 0;  // KEY capability
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

fn main() {
    let keyboards = find_keyboard_devices();

    if keyboards.is_empty() {
        eprintln!("Nie znaleziono klawiatur! Spróbuj uruchomić z sudo.");
        std::process::exit(1);
    }

    println!("Znalezione klawiatury:");
    for kb in &keyboards {
        // Spróbuj odczytać nazwę urządzenia
        if let Ok(dev) = Device::open(kb) {
            println!("  {} → {}", kb, dev.name().unwrap_or("(brak nazwy)"));
        } else {
            println!("  {} → (brak dostępu)", kb);
        }
    }
    println!("Nasłuchiwanie... (Ctrl+C aby zakończyć)\n");

    let (tx, rx) = mpsc::channel::<(String, String)>();

    for path in keyboards {
        let tx = tx.clone();
        thread::spawn(move || {
            let mut device = match Device::open(&path) {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("Błąd otwierania {}: {}", path, e);
                    return;
                }
            };
            let name = device.name().unwrap_or("nieznane").to_string();

            loop {
                match device.fetch_events() {
                    Ok(events) => {
                        for event in events {
                            if let EventSummary::Key(_, key_code, 1) = event.destructure() {
                                let msg = format!("[{}] {:?}", name, key_code);
                                if tx.send((path.clone(), msg)).is_err() {
                                    return;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("Błąd odczytu z {}: {}", path, e);
                        return;
                    }
                }
            }
        });
    }

    // Odbieraj zdarzenia z wszystkich wątków
    for (_path, msg) in rx {
        println!("{}", msg);
    }
}