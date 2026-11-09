#!/usr/bin/env python3
"""
keystroke-otlp-forwarder.py — Wysyła zdarzenia klawiatury z SQLite przez OTLP do instancji ingest (Brain OS).

Pipeline:
  keylog.db (WAL polling) -> OTLP Logs -> OTel Collector -> ClickHouse
                          -> OTLP Metrics (co 10s: keystrokes/min, error_rate, top keys)

Analogiczny do hwmon-logger.py — używa tylko stdlib (urllib, json, sqlite3).
"""
from typing import Optional
import json
import os
import sqlite3
import socket
import sys
import time
import urllib.request
from collections import Counter

# ---------- Konfiguracja ----------
OTLP_LOGS_ENDPOINT    = os.getenv("OTLP_LOGS_URL",    "http://127.0.0.1:4318/v1/logs")
OTLP_METRICS_ENDPOINT = os.getenv("OTLP_METRICS_URL", "http://127.0.0.1:4318/v1/metrics")
DB_PATH               = os.getenv("KEYLOGGER_DB_PATH",
                                   os.path.expanduser("~/.local/share/rust-keylogger/keylog.db"))
HOSTNAME              = os.getenv("HOST_NAME", socket.gethostname().split(".")[0])
POLL_INTERVAL         = float(os.getenv("POLL_INTERVAL", "0.05"))   # 50ms polling dla natychmiastowego live view
# Pozycja ostatniego zdarzenia przyjętego przez serwer: po przerwie (serwer, sieć,
# restart) wysyłka wznawia się od niej, więc nic z lokalnej bazy nie przepada.
CURSOR_PATH           = os.getenv("KEYLOGGER_CURSOR_PATH", "")
RETRY_INTERVAL        = float(os.getenv("RETRY_INTERVAL", "10.0"))   # sekund po nieudanej wysyłce
METRICS_INTERVAL      = float(os.getenv("METRICS_INTERVAL", "10.0"))  # sekund między metrykami

# Klucze traktowane jako "błąd" (pomyłka/cofnięcie)
ERROR_KEYS = {"BackSpace", "Delete"}

# Klucze drukowalne (pomijamy modyfikatory przy metrykach CPM)
MODIFIER_KEYS = {
    "Shift_L", "Shift_R", "Control_L", "Control_R",
    "Alt_L", "Alt_R", "Super_L", "Super_R",
    "Caps_Lock", "Num_Lock", "Scroll_Lock", "Tab",
}

BLACKLIST_PATH = os.getenv("KEYLOGGER_BLACKLIST_PATH", os.path.expanduser("~/.config/rust-keylogger/blacklist.txt"))

def load_blacklist() -> list[str]:
    if os.path.exists(BLACKLIST_PATH):
        try:
            with open(BLACKLIST_PATH, "r", encoding="utf-8") as f:
                return [l.strip() for l in f if l.strip() and not l.startswith("#")]
        except Exception:
            pass
    return []

# ---------- OTLP helpers ----------

def _resource():
    return {
        "attributes": [
            {"key": "host.name",    "value": {"stringValue": HOSTNAME}},
            {"key": "service.name", "value": {"stringValue": "keystroke-forwarder"}},
        ]
    }


def _now_ns() -> int:
    return int(time.time() * 1e9)


def _send(endpoint: str, payload: dict) -> tuple[int, str]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


# ---------- Log sender ----------

def send_keystroke_log(row_id: int, ts_ms: int, event_type: str, key_name: str, keycode: int) -> bool:
    """Wysyła jedno zdarzenie klawiatury jako log OTLP. True = serwer je przyjął."""
    ts_ns = ts_ms * 1_000_000  # ms → ns
    body = f"{event_type} {key_name}"
    severity_num = 9   # INFO
    severity_text = "INFO"

    payload = {
        "resourceLogs": [{
            "resource": _resource(),
            "scopeLogs": [{
                "scope": {"name": "keystroke-forwarder", "version": "1.0"},
                "logRecords": [{
                    "timeUnixNano": str(ts_ns),
                    "observedTimeUnixNano": str(_now_ns()),
                    "severityNumber": severity_num,
                    "severityText": severity_text,
                    "body": {"stringValue": body},
                    "attributes": [
                        {"key": "log_type",   "value": {"stringValue": "keystroke"}},
                        {"key": "event_type", "value": {"stringValue": event_type}},
                        {"key": "key_name",   "value": {"stringValue": key_name}},
                        {"key": "keycode",    "value": {"intValue": keycode}},
                        {"key": "row_id",     "value": {"intValue": row_id}},
                    ],
                    "traceId": "",
                    "spanId": "",
                }]
            }]
        }]
    }
    status, _ = _send(OTLP_LOGS_ENDPOINT, payload)
    return 200 <= status < 300


# ---------- Cursor ----------

def _cursor_path() -> str:
    return CURSOR_PATH or DB_PATH + ".forwarder-cursor"


def load_cursor() -> Optional[int]:
    try:
        with open(_cursor_path()) as f:
            return int(f.read().strip())
    except (FileNotFoundError, ValueError):
        return None


def save_cursor(row_id: int):
    tmp = _cursor_path() + ".tmp"
    with open(tmp, "w") as f:
        f.write(str(row_id))
    os.replace(tmp, _cursor_path())


# ---------- Metrics sender ----------

def send_keystroke_metrics(window_rows: list[tuple]):
    """
    Wysyła metryki z okna 10 sekund:
    - keyboard.keystrokes_per_min  (gauge)
    - keyboard.error_rate          (gauge, procent BackSpace/Delete)
    - keyboard.top_key.<key>       (gauge, count top-10 klawiszy)
    """
    if not window_rows:
        return

    # Tylko PRESS events, bez modifier-only
    presses = [r for r in window_rows if r[2] == "PRESS"]  # (id, ts_ms, event_type, key_name, keycode)
    total = len(presses)
    if total == 0:
        return

    # Czas okna w minutach (min 1/6 min = 10s)
    if len(presses) >= 2:
        t_span_ms = presses[-1][1] - presses[0][1]
        t_span_min = max(t_span_ms / 60_000, 10 / 60)
    else:
        t_span_min = 10 / 60

    cpm = total / t_span_min
    errors = sum(1 for r in presses if r[3] in ERROR_KEYS)
    error_rate = (errors / total * 100) if total > 0 else 0.0

    key_counts = Counter(r[3] for r in presses if r[3] not in MODIFIER_KEYS)
    top_keys = key_counts.most_common(10)

    ts_ns = str(_now_ns())

    def _gauge(name: str, value: float, attrs: list) -> dict:
        return {
            "name": name,
            "gauge": {
                "dataPoints": [{
                    "attributes": attrs,
                    "timeUnixNano": ts_ns,
                    "asDouble": round(value, 4),
                }]
            }
        }

    metrics = [
        _gauge("keyboard.keystrokes_per_min", cpm, [
            {"key": "host", "value": {"stringValue": HOSTNAME}}
        ]),
        _gauge("keyboard.error_rate_percent", error_rate, [
            {"key": "host", "value": {"stringValue": HOSTNAME}}
        ]),
    ]
    for key_name, count in top_keys:
        metrics.append(_gauge("keyboard.key_count", float(count), [
            {"key": "host",     "value": {"stringValue": HOSTNAME}},
            {"key": "key_name", "value": {"stringValue": key_name}},
        ]))

    payload = {
        "resourceMetrics": [{
            "resource": _resource(),
            "scopeMetrics": [{
                "scope": {"name": "keystroke-forwarder"},
                "metrics": metrics,
            }]
        }]
    }
    status, _ = _send(OTLP_METRICS_ENDPOINT, payload)
    if status not in (200, 204):
        print(f"[metrics] OTLP status {status}", file=sys.stderr)
    else:
        print(f"[metrics] CPM={cpm:.1f} error_rate={error_rate:.1f}% total_presses={total}", flush=True)


# ---------- Main polling loop ----------

def open_db() -> sqlite3.Connection:
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"Baza danych nie istnieje: {DB_PATH}")
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def main():
    print(f"[keystroke-otlp-forwarder] Start. DB={DB_PATH} host={HOSTNAME}", flush=True)
    print(f"[keystroke-otlp-forwarder] Logs  → {OTLP_LOGS_ENDPOINT}", flush=True)
    print(f"[keystroke-otlp-forwarder] Metrics → {OTLP_METRICS_ENDPOINT}", flush=True)

    # Czekamy aż DB pojawi się (serwis może startować równocześnie)
    waited = 0
    while not os.path.exists(DB_PATH):
        if waited == 0:
            print(f"[keystroke-otlp-forwarder] Czekam na bazę: {DB_PATH}", flush=True)
        time.sleep(2)
        waited += 2
        if waited > 120:
            print("BŁĄD: Baza nie pojawiła się po 2 minutach. Wychodzę.", file=sys.stderr)
            sys.exit(1)

    conn = open_db()

    # Wznawiamy od ostatniego przyjętego zdarzenia; bez zapisanej pozycji (pierwsza
    # instalacja) zaczynamy od bieżącego końca bazy i nie wysyłamy historii.
    last_id = load_cursor()
    if last_id is None:
        row = conn.execute("SELECT MAX(id) FROM keystrokes").fetchone()
        last_id = row[0] if row and row[0] else 0
        save_cursor(last_id)
    print(f"[keystroke-otlp-forwarder] Startujemy od id={last_id} (pozycja: {_cursor_path()})", flush=True)

    last_metrics_time = time.monotonic()
    # Bufor dla metryk (10-sekundowe okno)
    metrics_window: list[tuple] = []

    while True:
        try:
            # --- Pobierz nowe rekordy ---
            rows = conn.execute(
                "SELECT id, timestamp, event_type, key_name, keycode "
                "FROM keystrokes WHERE id > ? ORDER BY id ASC LIMIT 500",
                (last_id,)
            ).fetchall()

            sent = 0
            for row in rows:
                row_id, ts_ms, event_type, key_name, keycode = row
                try:
                    ok = send_keystroke_log(row_id, ts_ms, event_type, key_name, keycode)
                except Exception as e:
                    ok = False
                    print(f"[log] Błąd wysyłania: {e}", file=sys.stderr)
                if not ok:
                    # nie przesuwamy pozycji: to zdarzenie i następne pójdą przy kolejnej próbie
                    break
                if event_type == "PRESS":
                    metrics_window.append(row)
                last_id = row_id
                sent += 1

            if sent:
                save_cursor(last_id)
                print(f"[poll] Przesłano {sent} zdarzeń (id do {last_id})", flush=True)
            if sent < len(rows):
                time.sleep(RETRY_INTERVAL)
                continue

            # --- Wyślij metryki co METRICS_INTERVAL ---
            now = time.monotonic()
            if now - last_metrics_time >= METRICS_INTERVAL:
                send_keystroke_metrics(metrics_window)
                metrics_window = []
                last_metrics_time = now

        except sqlite3.OperationalError as e:
            print(f"[db] SQLite error: {e} — próba ponownego połączenia...", file=sys.stderr)
            try:
                conn.close()
            except Exception:
                pass
            time.sleep(5)
            conn = open_db()
        except Exception as e:
            print(f"[main] Nieoczekiwany błąd: {e}", file=sys.stderr)

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
