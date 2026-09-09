#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$HOME/.local/bin"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"

echo "==> 1. Budowanie binarnego rust-keylogger-xinput2 (release)..."
cd "$SCRIPT_DIR/rust-keylogger-xinput2"
cargo build --release

echo "==> 2. Zatrzymywanie ew. działającego serwisu i kopiowanie binarnego..."
systemctl --user stop keylogger.service 2>/dev/null || true
pkill -f rust-keylogger-xinput2 2>/dev/null || true
sleep 1

mkdir -p "$BIN_DIR"
cp "$SCRIPT_DIR/rust-keylogger-xinput2/target/release/rust-keylogger" "$BIN_DIR/rust-keylogger-xinput2"
chmod +x "$BIN_DIR/rust-keylogger-xinput2"

if [ -f "$BIN_DIR/keystroke-otlp-forwarder.py" ]; then
    chmod +x "$BIN_DIR/keystroke-otlp-forwarder.py"
fi

echo "==> 3. Instalowanie plików serwisów systemd user..."
mkdir -p "$SYSTEMD_USER_DIR"
cp "$SCRIPT_DIR/rust-keylogger-xinput2/keylogger.service" "$SYSTEMD_USER_DIR/"
cp "$SCRIPT_DIR/keystroke-forwarder.service" "$SYSTEMD_USER_DIR/"

echo "==> 4. Daemon-reload i uruchomienie serwisów systemd..."
systemctl --user daemon-reload
systemctl --user enable --now keylogger.service
systemctl --user enable --now keystroke-forwarder.service

echo ""
echo "✅ Instalacja zakończona sukcesem!"
echo ""
systemctl --user status keylogger.service --no-pager || true
echo ""
systemctl --user status keystroke-forwarder.service --no-pager || true
