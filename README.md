# KeyLogger Ecosystem & Telemetry Pipeline

Ekosystem do rejestracji i analizy użycia klawiatury w czasie rzeczywistym, stworzony w języku Rust, z integracją OpenTelemetry, SigNoz, ClickHouse, Grafaną oraz autorskim dashboardem w SvelteKit 5.

---

## 🏗️ Ewolucja Implementacji i Dlaczego `evdev` zamiast `xinput2`?

Początkowo produkcyjna wersja keyloggera bazowała na rozszerzeniu **X11 XInput2 (`x11rb`)**. Wraz z migracją środowiska graficznego na **Wayland (Hyprland)**, konieczne było zastąpienie go bezpośrednią obsługą podsystemu jądra Linuksa **`evdev`**.

### ⚠️ Dlaczego XInput2 przestał działać pod Waylandem?
1. **Izolacja zdarzeń wejścia (Input Isolation):** Architektura Wayland z założenia uniemożliwia aplikacjom podsłuchiwanie zdarzeń wprowadzania innych programów. Kompozytor (np. Hyprland) przekazuje zdarzenia klawiatury (`wl_keyboard.key`) wyłącznie do okna (`wl_surface`), które w danym momencie posiada aktywny fokus.
2. **Brak zdarzeń z aplikacji natywnych:** Rozszerzenie `XInput2` (XI2) jest mechanizmem ściśle powiązanym z serwerem X11 / Xwayland. Klawisze wpisywane w oknach natywnych dla Waylanda (np. terminal Wayland, przeglądarka z flagami Wayland) nigdy nie trafiają do magistrali zdarzeń X11, przez co keylogger oparty o XI2 milczał.

### ✅ Dlaczego `evdev` rozwiązuje problem?
- **Niezależność od serwera wyświetlania (Display-Server Agnostic):** `evdev` odczytuje surowe zdarzenia ze strumieni `/dev/input/event*` bezpośrednio na poziomie jądra Linuksa. Działa identycznie pod **Waylandem** (Hyprland, Sway, GNOME, KDE), **klasycznym X11**, a nawet w **konsoli TTY** czy bez środowiska graficznego.
- **Niezależność od sesji X11:** Serwis `systemd --user` nie potrzebuje zmiennych środowiskowych `DISPLAY` ani `XAUTHORITY` — może wystartować przed kompozytorem i działać stabilnie w tle.
- **Bezpieczeństwo bez uprawnień roota:** Daemon nie wymaga uruchamiania jako `root` czy przez `sudo`. Wystarczy jednorazowe dodanie użytkownika do grupy `input` (`sudo usermod -aG input $USER`).
- **Inteligentna autodetekcja klawiatur:** Daemon skanuje `/proc/bus/input/devices` pod kątem urządzeń posiadających bity `EV_KEY` (0x2) oraz `EV_LED` (0x20000), automatycznie filtrując właściwe klawiatury od przycisków zasilania, switchy czy touchpadów.
- **Pełna kompatybilność wsteczna:** Zastosowano konwersję kodów z offsetem +8 odpowiadającym scancode'om X11 oraz zachowano standardowe nazewnictwo symboli (`Return`, `BackSpace`, `Control_L`), dzięki czemu baza SQLite, bufor Lookahead dla haseł oraz cały pipeline telemetrii OTLP działają bez żadnych zmian.

---

## 📊 Porównanie Implementacji w Repozytorium

| Cecha / Moduł | `rust-keylogger-inputs` | `rust-keylogger-xlib` | `rust-keylogger-xinput2` *(Legacy X11)* | `rust-keylogger-xinput2` / `evdev` ⭐ *(Aktualny Produkcyjny)* |
| :--- | :--- | :--- | :--- | :--- |
| **Mechanizm przechwytywania** | Surowy plik `/dev/input/event*` | X11 Client Library (Xlib) | Rozszerzenie X11 XInput2 (XI2) | **Podsystem jądra Linux `evdev`** (crate `evdev`) |
| **Wsparcie Wayland (Hyprland/Sway)** | Tak (niski poziom) | ❌ Nie | ❌ Nie (tylko okna Xwayland) | **✅ Pełne (wszystkie okna i TTY)** |
| **Wymagane uprawnienia** | **Root** / grupa `input` | Zwykły użytkownik X11 | Zwykły użytkownik X11 | **Zwykły użytkownik w grupie `input`** |
| **Zależność od sesji graficznej** | Brak | Wymaga `DISPLAY` i X11 | Wymaga `DISPLAY` i `XAUTHORITY` | **Brak (niezależny od sesji GUI)** |
| **Model zdarzeń** | Synchronyjne `read([u8; 24])` | Odpytywanie `XNextEvent` | Asynchroniczna pętla `x11rb` | Wielowątkowy odczyt strumieni `fetch_events()` |
| **Wykrywanie urządzeń** | Proste parsowanie `/proc` | Połączenie `XOpenDisplay` | `x11rb::connect` + `XISelectEvents` | **Autodetekcja `EV_KEY + EV_LED` w `/proc`** |
| **Przechowywanie danych** | Brak / stdout | Brak / stdout | SQLite (`WAL` mode) | **SQLite (`WAL` mode) + Zero-Delay RAM Blacklist** |

---

## 📡 Architektura Pipeline Telemetrii

```
                                [ Local Host: rog ]                                              [ Server: orc ]
 ┌────────────────────────┐
 │ rust-keylogger (evdev) │ ── (Linux /dev/input/event*)
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

### 1. Wymagania Wstępne (Uprawnienia do `/dev/input`)

Ponieważ demon korzysta bezpośrednio z podsystemu `evdev`, użytkownik musi posiadać uprawnienia do odczytu urządzeń wejściowych. Wystarczy jednorazowo dodać bieżącego użytkownika do grupy `input`:

```bash
sudo usermod -aG input $USER
```

> [!NOTE]
> Po wykonaniu powyższego polecenia należy się wylogować i zalogować ponownie (lub wykonać `newgrp input`), aby nowa grupa stała się aktywna w bieżącej sesji.

### 2. Instalacja Serwisu Użytkownika (Systemd User Service)

Wystarczy uruchomić skrypt instalacyjny:

```bash
./install.sh
```

Skrypt automatycznie:
1. Kompiluje `rust-keylogger-xinput2` (silnik `evdev`) w trybie `--release`.
2. Kopiuje pliki binarne do `~/.local/bin/`.
3. Instaluje i uruchamia dwa serwisy użytkownika:
   - `keylogger.service` — przechwytuje naciśnięcia klawiszy przez `evdev` i zapisuje do SQLite WAL.
   - `keystroke-forwarder.service` — przesyła logi i metryki (CPM, Error Rate, Top Keys) do OTel / SigNoz na `orc`.

### 3. Status Serwisów

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
- **Dziennik Dnia & Prompt Digest dla LLM (`📑 Day Journal`):**
  - Rekonstrukcja spójnych sesji pisania, komend terminala i promptów z całego dnia.
  - Generowanie gotowego promptu analitycznego dla modeli LLM (Claude, ChatGPT, Gemini) z podziałem na godziny i aplikacje.
  - **Surowy widok tekstu (`text/plain`):** Dedykowany endpoint `/api/journal/raw` z przyciskiem *📄 Surowy Tekst (Nowa Karta)* umożliwiający natychmiastowe kopiowanie całości przez `Ctrl+A` $\to$ `Ctrl+C`.
- **Services Hub (`/services`):** Nawigacja i bezpośrednie linki do wszystkich serwisów homelabu na serwerze `orc` (Grafana, SigNoz, Perses, SigNoz MCP, Keyboard Live View).

### Tryb Dual-Mode (`KEYLOGGER_BACKEND`)

Aplikacja wspiera dwa źródła danych sterowane zmienną środowiskową:
- `KEYLOGGER_BACKEND=sqlite` — lokalna baza danych (domyślnie dla dev).
- `KEYLOGGER_BACKEND=clickhouse` — zapytania do kontenera ClickHouse na serwerze `orc` (dla produkcji w Dockerze na port `3002`).

---

## 🔒 Bezpieczeństwo i Anonimizacja Haseł (Zero-Delay)

Szczegółowy opis architektury ochrony prywatności i procedur bezpieczeństwa znajduje się w:
👉 **[Pełna Dokumentacja Bezpieczeństwa i Anonimizacji (docs/SECURITY_AND_ANONYMIZATION.md)](file:///home/daniel/pro/key-logger/docs/SECURITY_AND_ANONYMIZATION.md)**

### Kluczowe zasady:
1. **Brak haseł w repozytorium:** Czarna lista haseł (`~/.config/rust-keylogger/blacklist.txt`) znajduje się poza gitem, chroniona uprawnieniami `chmod 600`.
2. **Zero-Delay Live Stream (0 ms):** Dzięki algorytmowi *lookahead prefix matching* zwykłe wpisywanie znaków trafia do bazy natychmiast, a buforowane w pamięci RAM są wyłącznie znaki będące początkiem zdefiniowanego hasła.
3. **Niszczenie w pamięci RAM:** Po wykryciu całego hasła znaki są bezpowrotnie usuwane z RAM — do SQLite ani ClickHouse nie trafia ani jeden bajt.
4. **Skrypt czyszczący historię:** Narzędzie `scripts/scrub_secrets.py` pozwala w dowolnym momencie przeskanować i usunąć wybrane hasła z istniejących baz SQLite oraz ClickHouse (`ALTER TABLE ... DELETE`).

---

## 📊 Integracja z Grafaną i Perses

Na serwerze `orc` w Grafanie został wygenerowany dedykowany dashboard **Keyboard Analytics**:
- Tabela podglądu ostatnich logów keystroke z ClickHouse.
- Wykresy czasowe CPM (zapytań na minutę) oraz Error Rate %.
- Rozkład najczęściej używanych klawiszy.
- Przyciski nawigacyjne do pozostałych dashboardów oraz Svelte Live View.
