use std::path::Path;
use std::fs::OpenOptions;
use std::io::{Cursor, Read};
use byteorder::{NativeEndian, ReadBytesExt};

mod details;

fn main() {
    let system_details = details::SystemDetails::details();
    println!("Próba otwarcia: {}", system_details.event_path);
    
    let path = Path::new(system_details.event_path.as_str());
    let mut file_options = OpenOptions::new();
    file_options.read(true);

    // Otwieramy plik RAZ przed pętlą
    let mut event_file = file_options.open(path).expect(
        "Nie można otworzyć pliku. Czy uruchomiłeś program przez SUDO?"
    );

    let mut packet = [0u8; 24];

    loop {
        // read_exact zablokuje pętlę i czeka na realny ruch na klawiaturze
        event_file.read_exact(&mut packet).unwrap();

        let mut rdr = Cursor::new(packet);
        let _tv_sec  = rdr.read_u64::<NativeEndian>().unwrap();
        let _tv_usec = rdr.read_u64::<NativeEndian>().unwrap();
        let evtype   = rdr.read_u16::<NativeEndian>().unwrap();
        let code     = rdr.read_u16::<NativeEndian>().unwrap();
        let value    = rdr.read_i32::<NativeEndian>().unwrap();

        // evtype == 1 oznacza EV_KEY (zdarzenie klawisza)
        // value == 1 oznacza wciśnięcie (key down)
        if evtype == 1 && value == 1 {
            println!("Wciśnięto klawisz o kodzie: {}", code);
        }
    }
}