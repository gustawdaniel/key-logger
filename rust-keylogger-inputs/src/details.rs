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
    // Czyścimy tylko białe znaki z końca i początku (w tym \n)
    s.trim().to_string()
}

impl SystemDetails {
    pub fn details() -> SystemDetails {
        // Dodajemy '| head -n 1' aby wybrać tylko jeden, pierwszy event
        let cmd = "grep -E 'Handlers|EV=' /proc/bus/input/devices | \
                   grep -B1 'EV=120013' | \
                   grep -Eo 'event[0-9]+' | head -n 1";

        SystemDetails {
            os: shell_command("uname"),
            username: shell_command("whoami"),
            event_path: format!("/dev/input/{}", shell_command(cmd)),
        }
    }
}