use rdev::{listen, Event, EventType};

fn callback(event: Event) {
    // println!("Wydarzenie: {:?}", event);
    match event.event_type {
        EventType::KeyPress(key) => println!("Wciśnięto: {:?}", key),
        EventType::KeyRelease(key) => println!("Puszczono: {:?}", key),
        _ => {}
    }
}

fn main() {
    // listen() automatycznie tworzy wymagany przez macOS RunLoop
    if let Err(error) = listen(callback) {
        println!("Błąd: {:?}", error);
    }
}