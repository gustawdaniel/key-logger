use evdev::{Device, EventSummary, KeyCode};
fn main() {
    // Oficjalna biblioteka sama otwiera plik i parsuje pakiety 24-bajtowe za Ciebie
    // sudo evtest
    let mut device = Device::open("/dev/input/event11").unwrap();
    
    loop {
        // fetch_events() automatycznie blokuje wątek i czeka na sprzęt
        for event in device.fetch_events().unwrap() {
            // Zamieniamy niskopoziomowy InputEvent na wygodny EventSummary
            match event.destructure() {
                // Interesuje nas tylko typ Key, gdzie stan (value) wynosi 1 (wciśnięty)
                EventSummary::Key(_, key_code, 1) => {
                    // Ponieważ key_code to enum typu KeyCode, formatowanie {:?} 
                    // wypisze czytelny string, np. "KEY_C"
                    println!("Wciśnięto klawisz: {:?}", key_code);
                }
                _ => {} // Ignorujemy puszczenia klawiszy (value: 0) i inne eventy
            }
        }
    }
}