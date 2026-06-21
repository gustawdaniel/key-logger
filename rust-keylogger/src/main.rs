use std::error::Error;

use std::sync::mpsc;

mod details;
mod x11_logger;
mod events;
mod db;

fn main() -> Result<(), Box<dyn Error>> {
    let sys = details::SystemDetails::details();
    println!("OS: {}, User: {}", sys.os, sys.username);

    // Inicjalizacja kanału mpsc do komunikacji między wątkiem loggera i zapisywacza bazy danych
    let (tx, rx) = mpsc::channel();

    // Uruchomienie wątku zapisującego w tle
    db::start_db_thread(rx);

    // Run X11 event loop (blocks indefinitely)
    x11_logger::run(tx)?;
    Ok(())
}

// Dead helper removed – not used in X11 logger
