use std::fs::File;
use std::io::{BufRead, BufReader};
use std::process::Command;

#[derive(Debug)]
pub struct SystemDetails {
    pub os: String,
    pub username: String,
    pub event_path: String,
}

fn shell_command(cmd: &str) -> String {
    let my_cmd = Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .output()
        .expect("failed to execute process");

    let s = String::from_utf8(my_cmd.stdout).expect("Found invalid UTF-8");
    s.trim().to_string()
}

impl SystemDetails {
    pub fn details() -> SystemDetails {
        let mut chosen_event = String::new();

        if let Ok(file) = File::open("/proc/bus/input/devices") {
            let reader = BufReader::new(file);
            
            let mut current_name = String::new();
            let mut current_event = String::new();
            let mut current_ev_mask = String::new();

            for line in reader.lines().map_while(Result::ok) {
                if line.starts_with("N: Name=") {
                    current_name = line.to_lowercase();
                }

                if line.starts_with("H: Handlers=") {
                    if let Some(pos) = line.find("event") {
                        let event_part = &line[pos..];
                        current_event = event_part.split_whitespace().next().unwrap_or("").to_string();
                    }
                }

                if line.starts_with("B: EV=") {
                    current_ev_mask = line.trim().to_string();
                }

                // Koniec bloku urządzenia
                if line.is_empty() {
                    // 1. Szukamy konkretnie Twojej wbudowanej klawiatury ASUS N-KEY
                    // 2. Odrzucamy myszki (mouse) i inne peryferia, które psuły nam statystykę
                    if current_name.contains("n-key") && !current_name.contains("mouse") {
                        // 3. Sprawdzamy maskę zdarzeń. Interfejs z literami ma końcówkę '13' (EV=120013)
                        //    Interfejs kontrolny (event10) ma zazwyczaj inną maskę (np. EV=12001f lub EV=1b)
                        if current_ev_mask.contains("120013") {
                            chosen_event = current_event.clone();
                            break; // Znaleźliśmy ten jeden jedyny właściwy interfejs
                        }
                    }
                    
                    // Reset
                    current_name.clear();
                    current_event.clear();
                    current_ev_mask.clear();
                }
            }
        }

        // Jeśli specyficzny filtr ASUS zawiedzie, bierzemy twardy fallback na event11
        if chosen_event.is_empty() {
            panic!("Nie znaleziono klawiatury!");
        }

        SystemDetails {
            os: shell_command("uname"),
            username: shell_command("whoami"),
            event_path: format!("/dev/input/{}", chosen_event),
        }
    }
}