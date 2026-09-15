# Bezpieczeństwo, Prywatność i Anonimizacja Haseł (Zero-Delay Defense in Depth)

Niniejsza dokumentacja opisuje architekturę ochrony prywatności i anonimizacji poufnych danych (haseł, PIN-ów, tokenów API, kluczy prywatnych) w projekcie `key-logger`.

---

## 🎯 Główne Założenia Architektoniczne

1. **Zero Code Exposure**: Żadne hasło ani poufny ciąg nie może być nigdy wpisany w kodzie źródłowym ani trafić do repozytorium `git`.
2. **Zero Persistent Storage**: Sekwencje naciśnięć klawiszy tworzące hasła nie mogą trafić na dysk do bazy `keylog.db` (SQLite) ani do bazy `ClickHouse`.
3. **Zero-Delay Live Stream**: Mechanizm ochrony nie może powodować opóźnień w pokazywaniu znaków na żywo w terminalu (dla 99.99% wpisywanych znaków opóźnienie wynosi **0 ms**).
4. **Defense in Depth**: Wielowarstwowa ochrona (na poziomie daemona Rust, skryptu forwardera, backendu API oraz skryptu czyszczącego historię).

---

## 🏗️ Diagram Architektury (4 Warstwy Ochrony)

```mermaid
flowchart TD
    subgraph Warstwa 1: Konfiguracja Lokalna
        BL[~/.config/rust-keylogger/blacklist.txt<br/>Uprawnienia: chmod 600<br/>W .gitignore: Nigdy w repozytorium]
    end

    subgraph Warstwa 2: Przechwytywanie na Żywo (Daemon Rust)
        Input[Wciśnięcie klawisza przez użytkownika] --> Engine[rust-keylogger-xinput2]
        BL --> Engine
        Engine --> PrefixCheck{Dopasowanie prefiksu hasła?}
        PrefixCheck -- "NIE (99.99% przypadków)" --> InstantFlush[Zrzut do SQLite: 0 ms delay]
        PrefixCheck -- "TAK (początek hasła)" --> BufferRAM[Tymczasowy bufor w pamięci RAM]
        BufferRAM --> MatchCheck{Wpisano całe hasło?}
        MatchCheck -- "TAK" --> DropRAM[Zniszcz znaki w RAM - 0 bajtów na dysk]
        MatchCheck -- "NIE (inny znak)" --> FlushRAM[Zwolnij bufor do bazy natychmiast]
    end

    subgraph Warstwa 3: Pipeline & API
        InstantFlush --> SQLite[(SQLite keylog.db)]
        SQLite --> Forwarder[keystroke-otlp-forwarder.py]
        BL --> Forwarder
        Forwarder --> ClickHouse[(ClickHouse orc: signoz_logs)]
        ClickHouse --> SvelteAPI[SvelteKit backend.js]
        BL --> SvelteAPI
        SvelteAPI -- Sanitize Fallback [REDACTED] --> CleanView[Dashboard & Dziennik Dnia]
    end

    subgraph Warstwa 4: Remediacja Przeszłości
        Scrubber[scripts/scrub_secrets.py] -. Usuwa przeszłe wpisy .-> SQLite
        Scrubber -. ALTER TABLE DELETE .-> ClickHouse
    end
```

---

## ⚡ Algorytm Zero-Delay Lookahead Prefix Matching

Typowe podejście z buforem przesuwnym (sliding window) wprowadza zauważalny lag (np. 500 ms) przy pisaniu, co niszczy wrażenie błyskawicznego terminala i oscyloskopu CPM. 

W module `rust-keylogger-xinput2/src/db.rs` zastosowano algorytm dopasowywania prefiksowego (`longest_matching_prefix_len`):

```rust
fn longest_matching_prefix_len(buffer_str: &str, blacklist: &[String]) -> usize {
    for len in (1..=buffer_str.len()).rev() {
        let suffix = &buffer_str[buffer_str.len() - len..];
        for secret in blacklist {
            if secret.starts_with(suffix) {
                return len;
            }
        }
    }
    0
}
```

### Zasada działania:
1. **Zwykłe pisanie (`prefix_len == 0`)**:
   - Użytkownik wpisuje np. `g`, `i`, `t`, ` `, `s`, `t`, `a`, `t`, `u`, `s`.
   - Żaden z tych znaków nie jest początkiem hasła zdefiniowanego na czarnej liście.
   - Wynik: **Zapis do bazy następuje natychmiast przy każdym wciśnięciu klawisza (0 ms delay)**.
2. **Początek hasła (`prefix_len > 0`)**:
   - Użytkownik wpisuje klawisz będący początkiem hasła (np. cyfrę `3` z hasła `3234`).
   - W pamięci RAM zatrzymywany jest wyłącznie ten pojedynczy znak.
   - Jeżeli kolejny naciśnięty klawisz nie kontynuuje hasła (np. `3` + `a` lub `3` + `Enter`): prefiks natychmiast przestaje pasować i bufor jest zrzucany do SQLite w ułamku sekundy.
3. **Dokończenie hasła (`suffix == secret`)**:
   - W momencie naciśnięcia ostatniego znaku hasła (`3` $\to$ `2` $\to$ `3` $\to$ `4`) cała sekwencja zostaje **usunięta z pamięci RAM**.
   - Do SQLite nie trafia ani jeden znak hasła.

---

## 🔒 Konfiguracja i Zarządzanie Hasłami

### 1. Lokalizacja pliku czarnej listy
Plik czarnej listy znajduje się poza drzewem repozytorium git, w domowym katalogu konfiguracyjnym użytkownika:
```bash
~/.config/rust-keylogger/blacklist.txt
```

Plik posiada restrykcyjne uprawnienia (dostępny tylko dla właściciela):
```bash
chmod 700 ~/.config/rust-keylogger
chmod 600 ~/.config/rust-keylogger/blacklist.txt
```

### 2. Format pliku `blacklist.txt`
Każda linijka to jeden ciąg znaków (hasło, PIN, klucz API). Puste linie oraz linie zaczynające się od `#` są ignorowane:
```text
# Przykładowe hasła i PIN-y do anonimizacji:
2018#gamechanged
3234
SuperTajneHaslo123!
```

### 3. Automatyczne przeładowanie (Hot Reload)
Daemon `rust-keylogger-xinput2` automatycznie przeładowuje plik `blacklist.txt` co 30 sekund bez konieczności restartowania serwisu systemd.

---

## 🧹 Czyszczenie Przeszłych Danych (Remediation Scrubber)

Jeśli hasła zostały wpisane do bazy przed uruchomieniem anonimizacji, w repozytorium dostępny jest skrypt:
```bash
scripts/scrub_secrets.py
```

### Co robi skrypt:
1. Wczytuje listę wzorców z `~/.config/rust-keylogger/blacklist.txt`.
2. Skanuje sekwencyjnie naciśnięcia klawiszy w lokalnej bazie `keylog.db` (SQLite).
3. Wykrywa dopasowania i usuwa powiązane rekordy (`DELETE FROM keystrokes WHERE id IN (...)`).
4. Wykonuje `VACUUM` w SQLite, fizycznie zwalniając miejsce i uniemożliwiając odzyskanie rekordów.
5. Wykonuje mutację `ALTER TABLE signoz_logs.logs_v2 DELETE` w ClickHouse na serwerze `orc`.

Uruchomienie:
```bash
python3 scripts/scrub_secrets.py
```

---

## 📄 Surowy Eksport Tekstu dla LLM (Raw View)

W celu wyeliminowania problemów z mechanizmami kopiowania JavaScript w przeglądarkach, dashboard udostępnia bezpośredni widok `text/plain`:

- **URL surowego tekstu**:
  `http://orc:3002/api/journal/raw?date=YYYY-MM-DD`
  *(lub `http://localhost:5173/api/journal/raw?date=YYYY-MM-DD`)*
- **Parametr formatu**:
  `GET /api/journal?date=YYYY-MM-DD&format=raw`
- **W interfejsie**:
  Przycisk `📄 Surowy Tekst (Nowa Karta)` otwiera czystą stronę tekstową, na której wystarczy wcisnąć:
  `Ctrl + A` $\to$ `Ctrl + C` $\to$ wkleić do Claude / ChatGPT / Gemini.
