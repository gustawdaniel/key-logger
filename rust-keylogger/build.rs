// Build script to ensure linkage with X11 and Xi libraries
fn main() {
    println!("cargo:rustc-link-lib=X11");
    println!("cargo:rustc-link-lib=Xi");
}
