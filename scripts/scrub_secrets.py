#!/usr/bin/env python3
"""
scrub_secrets.py — Narzędzie do usuwania i anonimizacji haseł z lokalnej bazy SQLite i ClickHouse.

Wczytuje wzorce z ~/.config/rust-keylogger/blacklist.txt (poza gitem)
i trwale usuwa pasujące sekwencje naciśnięć klawiszy z historii.
"""
import os
import sys
import sqlite3
import subprocess

BLACKLIST_PATH = os.getenv("KEYLOGGER_BLACKLIST_PATH", os.path.expanduser("~/.config/rust-keylogger/blacklist.txt"))
DB_PATH = os.getenv("KEYLOGGER_DB_PATH", os.path.expanduser("~/.local/share/rust-keylogger/keylog.db"))

def load_blacklist():
    if not os.path.exists(BLACKLIST_PATH):
        print(f"[!] Plik czarnej listy nie istnieje: {BLACKLIST_PATH}")
        return []
    with open(BLACKLIST_PATH, "r", encoding="utf-8") as f:
        lines = [line.strip() for line in f if line.strip() and not line.startswith("#")]
    return lines

def char_from_key_name(key_name, is_shift=False):
    shift_map = {
        '1': '!', '2': '@', '3': '#', '4': '$', '5': '%',
        '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
        'minus': '_', 'equal': '+', 'bracketleft': '{', 'bracketright': '}',
        'semicolon': ':', 'apostrophe': '"', 'grave': '~', 'backslash': '|',
        'comma': '<', 'period': '>', 'slash': '?', 'question': '?', 'underscore': '_',
        'numbersign': '#'
    }
    normal_map = {
        'space': ' ', 'Return': '\n', 'Tab': '\t', 'comma': ',', 'period': '.',
        'minus': '-', 'slash': '/', 'equal': '=', 'semicolon': ';',
        'apostrophe': "'", 'grave': '`', 'backslash': '\\',
        'bracketleft': '[', 'bracketright': ']', 'numbersign': '#'
    }
    if is_shift and key_name in shift_map:
        return shift_map[key_name]
    if key_name in normal_map:
        return normal_map[key_name]
    if len(key_name) == 1:
        return key_name.upper() if is_shift else key_name.lower()
    return ''

def scrub_sqlite(secrets):
    if not os.path.exists(DB_PATH):
        print(f"[!] Baza SQLite nie istnieje: {DB_PATH}")
        return []

    print(f"[*] Skanowanie SQLite: {DB_PATH} ...")
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute("SELECT id, timestamp, event_type, key_name FROM keystrokes ORDER BY timestamp ASC, id ASC")
    rows = cur.fetchall()
    print(f"[*] Załadowano {len(rows)} wierszy z SQLite.")

    # Rekonstrukcja strumienia z mapowaniem indeksu do wiersza ID
    char_stream = []
    row_ids = []
    is_shift = False

    for r in rows:
        row_id, ts, event_type, key_name = r
        if key_name in ('Shift_L', 'Shift_R'):
            is_shift = (event_type == 'PRESS')
            continue
        if event_type != 'PRESS':
            continue

        ch = char_from_key_name(key_name, is_shift)
        if ch:
            char_stream.append(ch)
            row_ids.append(row_id)

    full_text = "".join(char_stream)
    deleted_row_ids = set()

    for secret in secrets:
        start = 0
        count = 0
        while True:
            idx = full_text.find(secret, start)
            if idx == -1:
                break
            # Zbierz row_ids odpowiadające tej sekwencji znaków
            match_row_ids = row_ids[idx : idx + len(secret)]
            for mid in match_row_ids:
                deleted_row_ids.add(mid)
            count += 1
            start = idx + len(secret)
        if count > 0:
            print(f"[!] Znaleziono {count} wystąpień poufnego ciągu o długości {len(secret)} znaków.")

    if deleted_row_ids:
        print(f"[*] Trwa usuwanie {len(deleted_row_ids)} wierszy z bazy SQLite...")
        id_list = list(deleted_row_ids)
        # Usuwaj partiami po 500
        batch_size = 500
        for i in range(0, len(id_list), batch_size):
            chunk = id_list[i:i+batch_size]
            placeholders = ",".join("?" for _ in chunk)
            cur.execute(f"DELETE FROM keystrokes WHERE id IN ({placeholders})", chunk)
        conn.commit()
        cur.execute("VACUUM")
        conn.close()
        print(f"[+] Pomyślnie usunięto {len(deleted_row_ids)} wierszy z SQLite i wykonano VACUUM.")
    else:
        conn.close()
        print("[+] Brak wystąpień poufnych ciągów w SQLite.")

    return list(deleted_row_ids)

def scrub_clickhouse(deleted_ids):
    if not deleted_ids:
        print("[*] Brak ID do usunięcia z ClickHouse.")
        return

    print(f"[*] Trwa czyszczenie {len(deleted_ids)} zdarzeń w ClickHouse na orc...")
    # Usuwamy z tabeli signoz_logs.logs_v2 na orc
    id_strs = ",".join(str(i) for i in deleted_ids)
    query = f"ALTER TABLE signoz_logs.logs_v2 DELETE WHERE attributes_string['log_type'] = 'keystroke' AND toInt64(attributes_number['row_id']) IN ({id_strs})"
    cmd = [
        "ssh", "orc",
        f"sudo incus exec signoz -- docker exec signoz-telemetrystore-clickhouse-0-0 clickhouse-client --query \"{query}\""
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode == 0:
        print("[+] Zapytanie czyszczące w ClickHouse wykonane pomyślnie.")
    else:
        print(f"[!] Błąd czyszczenia ClickHouse: {res.stderr}")

def main():
    secrets = load_blacklist()
    if not secrets:
        print("[!] Brak wzorców do czyszczenia w blacklist.txt.")
        return

    print(f"[*] Załadowano {len(secrets)} wzorców czarnej listy.")
    deleted_ids = scrub_sqlite(secrets)
    if deleted_ids:
        scrub_clickhouse(deleted_ids)
    print("[+] Zakończono czyszczenie danych.")

if __name__ == "__main__":
    main()
