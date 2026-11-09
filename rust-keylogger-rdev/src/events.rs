use std::time::SystemTime;

#[derive(Debug, Clone)]
pub struct KeyEvent {
    pub event_type: &'static str,
    pub key_name: String,
    pub keycode: u32,
    pub timestamp: SystemTime,
}
