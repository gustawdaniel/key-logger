-- Tabela podsumowań godzinowych dla błyskawicznego ładowania Heatmaps i Statystyk (<5ms)
CREATE TABLE IF NOT EXISTS signoz_logs.keystroke_hourly_summary (
    date Date,
    hour UInt8,
    event_type LowCardinality(String),
    is_error UInt8,
    is_printable UInt8,
    key_name LowCardinality(String),
    count UInt64
) ENGINE = SummingMergeTree(count)
PARTITION BY toYYYYMM(date)
ORDER BY (date, hour, event_type, is_error, is_printable, key_name);

-- Widok zmaterializowany automatycznie agregujący każdy przychodzący keystroke
CREATE MATERIALIZED VIEW IF NOT EXISTS signoz_logs.keystroke_hourly_summary_mv
TO signoz_logs.keystroke_hourly_summary AS
SELECT
    toDate(timestamp / 1000000000) AS date,
    toHour(toDateTime(timestamp / 1000000000, 'Europe/Warsaw')) AS hour,
    attributes_string['event_type'] AS event_type,
    if(attributes_string['key_name'] IN ('BackSpace', 'Delete'), 1, 0) AS is_error,
    if(attributes_string['key_name'] NOT IN ('Shift_L','Shift_R','Control_L','Control_R','Alt_L','Alt_R','Super_L','Super_R'), 1, 0) AS is_printable,
    attributes_string['key_name'] AS key_name,
    count() AS count
FROM signoz_logs.logs_v2
WHERE attributes_string['log_type'] = 'keystroke'
GROUP BY date, hour, event_type, is_error, is_printable, key_name;

-- Wstępne wypełnienie danymi z ostatnich 30 dni (ograniczone do 2 wątków, by nie obciążać CPU)
INSERT INTO signoz_logs.keystroke_hourly_summary
SELECT
    toDate(timestamp / 1000000000) AS date,
    toHour(toDateTime(timestamp / 1000000000, 'Europe/Warsaw')) AS hour,
    attributes_string['event_type'] AS event_type,
    if(attributes_string['key_name'] IN ('BackSpace', 'Delete'), 1, 0) AS is_error,
    if(attributes_string['key_name'] NOT IN ('Shift_L','Shift_R','Control_L','Control_R','Alt_L','Alt_R','Super_L','Super_R'), 1, 0) AS is_printable,
    attributes_string['key_name'] AS key_name,
    count() AS count
FROM signoz_logs.logs_v2
WHERE attributes_string['log_type'] = 'keystroke'
  AND toDate(timestamp / 1000000000) >= today() - 30
GROUP BY date, hour, event_type, is_error, is_printable, key_name
SETTINGS max_threads = 2;
