# KeyLogger Ecosystem & Telemetry Pipeline

Ekosystem do rejestracji i analizy użycia klawiatury w czasie rzeczywistym, stworzony w języku Rust, z integracją OpenTelemetry, SigNoz, ClickHouse, Grafaną oraz autorskim dashboardem w SvelteKit 5.

---

## 🏗️ Porównanie 3 Implementacji Keyloggera w Rust

W repozytorium znajdują się trzy różne podejścia do przechwytywania klawiszy pod Linuksem, pokazujące ewolucję architektury:

| Cecha / Moduł | `rust-keylogger-inputs` | `rust-keylogger-xlib` | `rust-keylogger-xinput2` ⭐ *(Produkcyjny)* |
| :--- | :--- | :--- | :--- |
| **Poziom abstrakcji** | Surowy plik `/dev/input/event*` | Warstwa X11 Client Library (Xlib) | Rozszerzenie X11 XInput2 (XI2) |
| **Wymagane uprawnienia** | **Root** / grupa `input` | Zwykły użytkownik X11 | Zwykły użytkownik X11 |
| **Model zdarzeń** | Synchronyjne `read([u8; 24])` | Odpytywanie `XNextEvent` | Asynchroniczna pętla `x11rb` z akceptacją masek |
| **Działanie w tle** | Niskopoziomowy daemom systemowy | Działa w sesji X11 | Działa w sesji X11 (systemd user) |
| **Przechowywanie danych** | Brak / stdout | Brak / stdout | **Baza danych SQLite** (`WAL` mode) |
| **Detekcja urządzeń** | Parsowanie `/proc/bus/input/devices` | Połączenie `XOpenDisplay` | Połączenie `x11rb::connect` + `XISelectEvents` |

---

## 📡 Architektura Pipeline Telemetrii

```
                                [ Local Host: rog ]                                              [ Server: orc ]
 ┌────────────────────────┐
 │ rust-keylogger-xinput2 │ ── (XInput2 events)
 └───────────┬────────────┘
             │
             ▼
  ~/.../keylog.db (SQLite WAL)
             │
             ▼
 ┌───────────────────────────┐      OTLP Logs      ┌─────────────────┐     OTLP      ┌─────────────────────────┐
 │ keystroke-otlp-forwarder  │ ──────────────────> │ OTel Collector  │ ────────────> │ SigNoz / ClickHouse     │
 │ (Python stdlib daemon)    │      OTLP Metrics   │ (port 4318)     │               │ (incus container on orc)│
 └───────────────────────────┘                     └─────────────────┘               └────────────┬────────────┘
                                                                                                  │
                                                                                 ┌────────────────┴────────────────┐
                                                                                 ▼                                 ▼
                                                                     ┌───────────────────────┐         ┌───────────────────────┐
                                                                     │ Grafana Dashboard     │         │ Svelte Live Dashboard │
                                                                     │ (Keyboard Analytics)  │         │ (Dual Mode: CH/SQLite)│
                                                                     └───────────────────────┘         └───────────────────────┘
```

---

## 🚀 Szybka Instalacja i Uruchomienie

### 1. Instalacja Serwisu Użytkownika (Systemd User Service)

Wystarczy uruchomić skrypt instalacyjny:

```bash
./install.sh
```

Skrypt automatycznie:
1. Kompiluje `rust-keylogger-xinput2` w trybie `--release`.
2. Kopiuje pliki binarne do `~/.local/bin/`.
3. Instaluje i uruchamia dwa serwisy użytkownika:
   - `keylogger.service` — przechwytuje naciśnięcia klawiszy i zapisuje do SQLite WAL.
   - `keystroke-forwarder.service` — przesyła logi i metryki (CPM, Error Rate, Top Keys) do OTel / SigNoz na `orc`.

### 2. Status Serwisów

```bash
systemctl --user status keylogger.service
systemctl --user status keystroke-forwarder.service
```

---

## 🌐 Dashboard Webowy (SvelteKit 5)

Dashboard SvelteKit w katalogu `svelte-dashboard/` oferuje:
- **Terminal na Żywo (Decoded Terminal):**
  - Mode **🧹 Clean (evaluated Backspace):** Wpisanie `abc` + `BackSpace` + `d` wyświetli `abd`.
  - Mode **🔤 Raw (tokens stream):** Wpisanie `abc` + `BackSpace` + `d` wyświetli `abc⌫d`.
- **Zautomatyzowane statystyki:** CPM (Characters Per Minute), Error Rate %, Wskaźnik Copy-Paste (czas od `Ctrl+C` do `Ctrl+V`), Heatmapa klawiszy.
- **Services Hub (`/services`):** Nawigacja i bezpośrednie linki do wszystkich serwisów homelabu na serwerze `orc` (Grafana, SigNoz, Perses, SigNoz MCP, Keyboard Live View).

### Tryb Dual-Mode (`KEYLOGGER_BACKEND`)

Aplikacja wspiera dwa źródła danych sterowane zmienną środowiskową:
- `KEYLOGGER_BACKEND=sqlite` — lokalna baza danych (domyślnie dla dev).
- `KEYLOGGER_BACKEND=clickhouse` — zapytania do kontenera ClickHouse na serwerze `orc` (dla produkcji w Dockerze na port `3002`).

---

## 📊 Integracja z Grafaną i Perses

Na serwerze `orc` w Grafanie został wygenerowany dedykowany dashboard **Keyboard Analytics**:
- Tabela podglądu ostatnich logów keystroke z ClickHouse.
- Wykresy czasowe CPM (zapytań na minutę) oraz Error Rate %.
- Rozkład najczęściej używanych klawiszy.
- Przyciski nawigacyjne do pozostałych dashboardów oraz Svelte Live View.
