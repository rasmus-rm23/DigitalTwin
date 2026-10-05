//! Parsing raw cells into typed values: numbers, date-times (local → UTC) and text.

use chrono::{DateTime, Duration, LocalResult, NaiveDate, NaiveDateTime, TimeZone};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

use super::source::{format_number, RawCell};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ColumnKind {
    Number,
    Text,
    Datetime,
    /// Not imported.
    Skip,
}

/// Special `datetime_format` value for ISO 8601 / RFC 3339 timestamps with an offset
/// (e.g. `2024-03-01T12:00:00Z`). These are absolute, so the import time zone is ignored.
pub const RFC3339: &str = "rfc3339";

/// Text date-time formats tried during inference, in priority order.
/// Day-first variants come before month-first ones (European data).
pub const DATETIME_FORMATS: &[&str] = &[
    "%Y-%m-%d %H:%M:%S%.f",
    "%Y-%m-%dT%H:%M:%S%.f",
    "%Y-%m-%d %H:%M",
    "%Y-%m-%dT%H:%M",
    "%d-%m-%Y %H:%M:%S%.f",
    "%d-%m-%Y %H:%M",
    "%d.%m.%Y %H:%M:%S%.f",
    "%d.%m.%Y %H:%M",
    "%d/%m/%Y %H:%M:%S%.f",
    "%d/%m/%Y %H:%M",
    "%m/%d/%Y %H:%M:%S%.f",
    "%m/%d/%Y %H:%M",
    "%Y-%m-%d",
    "%d-%m-%Y",
    "%d.%m.%Y",
    "%d/%m/%Y",
    "%m/%d/%Y",
    RFC3339,
];

/// Parses a number written with the given decimal separator. The other separator
/// and spaces are treated as thousands separators. Returns `None` for unparseable text.
pub fn parse_number(s: &str, decimal: char) -> Option<f64> {
    let s: String = s.chars().filter(|c| !c.is_whitespace() && *c != '\u{a0}').collect();
    if s.is_empty() {
        return None;
    }
    let normalised = match decimal {
        ',' => s.replace('.', "").replace(',', "."),
        _ => s.replace(',', ""),
    };
    normalised.parse::<f64>().ok().filter(|f| f.is_finite())
}

/// A parsed timestamp: either wall-clock time (needs a time zone) or already absolute.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ParsedTime {
    Local(NaiveDateTime),
    Utc(DateTime<chrono::Utc>),
}

pub fn parse_datetime(s: &str, format: &str) -> Option<ParsedTime> {
    let s = s.trim();
    if format == RFC3339 {
        return DateTime::parse_from_rfc3339(s).ok().map(|d| ParsedTime::Utc(d.to_utc()));
    }
    NaiveDateTime::parse_from_str(s, format)
        .ok()
        .or_else(|| NaiveDate::parse_from_str(s, format).ok().map(|d| d.and_time(Default::default())))
        .map(ParsedTime::Local)
}

/// Excel serial date (days since 1899-12-30) to wall-clock time.
pub fn excel_serial_to_datetime(serial: f64) -> Option<NaiveDateTime> {
    let base = NaiveDate::from_ymd_opt(1899, 12, 30)?.and_hms_opt(0, 0, 0)?;
    let ms = (serial * 86_400_000.0).round();
    if !ms.is_finite() || ms.abs() > 1e15 {
        return None;
    }
    base.checked_add_signed(Duration::milliseconds(ms as i64))
}

/// Inferred type of a column from sample cells.
pub fn infer_kind(cells: &[&RawCell], decimal: char) -> (ColumnKind, Option<String>) {
    let cells: Vec<&RawCell> = cells.iter().copied().filter(|c| !c.is_empty()).collect();
    if cells.is_empty() {
        return (ColumnKind::Text, None);
    }
    if cells.iter().all(|c| matches!(c, RawCell::DateTime(_))) {
        return (ColumnKind::Datetime, None);
    }
    let all_numeric = cells.iter().all(|c| match c {
        RawCell::Number(_) => true,
        RawCell::Text(s) => parse_number(s, decimal).is_some(),
        _ => false,
    });
    if all_numeric {
        return (ColumnKind::Number, None);
    }
    let texts: Option<Vec<&str>> = cells
        .iter()
        .map(|c| match c {
            RawCell::Text(s) => Some(s.as_str()),
            _ => None,
        })
        .collect();
    if let Some(texts) = texts {
        for fmt in DATETIME_FORMATS {
            if texts.iter().all(|t| parse_datetime(t, fmt).is_some()) {
                return (ColumnKind::Datetime, Some((*fmt).to_owned()));
            }
        }
    }
    (ColumnKind::Text, None)
}

/// Converts wall-clock times to UTC in a given zone, resolving DST edge cases.
///
/// - Autumn (repeated hour): picks the earlier instant, unless that would not move the
///   series forward, in which case the later one. This handles sequential
///   SCADA logs that pass through the repeated hour twice.
/// - Spring (skipped hour): shifts forward by one hour.
pub struct Localizer {
    tz: Tz,
    last_ms: Option<i64>,
    pub ambiguous: u64,
    pub nonexistent: u64,
}

impl Localizer {
    pub fn new(tz: Tz) -> Self {
        Self { tz, last_ms: None, ambiguous: 0, nonexistent: 0 }
    }

    /// Returns epoch milliseconds (UTC).
    pub fn to_utc_ms(&mut self, t: ParsedTime) -> i64 {
        let ms = match t {
            ParsedTime::Utc(d) => d.timestamp_millis(),
            ParsedTime::Local(n) => match self.tz.from_local_datetime(&n) {
                LocalResult::Single(d) => d.timestamp_millis(),
                LocalResult::Ambiguous(early, late) => {
                    self.ambiguous += 1;
                    let early = early.timestamp_millis();
                    match self.last_ms {
                        Some(last) if early <= last => late.timestamp_millis(),
                        _ => early,
                    }
                }
                LocalResult::None => {
                    self.nonexistent += 1;
                    let shifted = n + Duration::hours(1);
                    self.tz
                        .from_local_datetime(&shifted)
                        .earliest()
                        .map_or_else(|| shifted.and_utc().timestamp_millis(), |d| d.timestamp_millis())
                }
            },
        };
        self.last_ms = Some(ms);
        ms
    }
}

/// Outcome of converting one cell.
pub enum Converted {
    Null,
    Real(f64),
    Text(String),
    /// Epoch milliseconds, UTC.
    Time(i64),
    /// The cell could not be parsed as the column type; stored as NULL.
    Invalid,
}

pub fn convert_cell(
    cell: &RawCell,
    kind: ColumnKind,
    decimal: char,
    datetime_format: Option<&str>,
    localizer: &mut Localizer,
) -> Converted {
    if cell.is_empty() {
        return Converted::Null;
    }
    match kind {
        ColumnKind::Skip => Converted::Null,
        ColumnKind::Text => Converted::Text(match cell {
            RawCell::Text(s) => s.clone(),
            other => other.display(),
        }),
        ColumnKind::Number => match cell {
            RawCell::Number(f) => Converted::Real(*f),
            RawCell::Text(s) => parse_number(s, decimal).map_or(Converted::Invalid, Converted::Real),
            _ => Converted::Invalid,
        },
        ColumnKind::Datetime => {
            let parsed = match (cell, datetime_format) {
                (RawCell::DateTime(n), _) => Some(ParsedTime::Local(*n)),
                (RawCell::Text(s), Some(fmt)) => parse_datetime(s, fmt),
                (RawCell::Text(s), None) => {
                    DATETIME_FORMATS.iter().find_map(|f| parse_datetime(s, f))
                }
                (RawCell::Number(f), None) => excel_serial_to_datetime(*f).map(ParsedTime::Local),
                (RawCell::Number(f), Some(fmt)) => parse_datetime(&format_number(*f), fmt),
                (RawCell::Empty, _) => None,
            };
            parsed.map_or(Converted::Invalid, |t| Converted::Time(localizer.to_utc_ms(t)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(s: &str) -> RawCell {
        RawCell::Text(s.into())
    }

    #[test]
    fn numbers_with_either_decimal() {
        assert_eq!(parse_number("1,5", ','), Some(1.5));
        assert_eq!(parse_number("1.234,5", ','), Some(1234.5));
        assert_eq!(parse_number("1 234,5", ','), Some(1234.5));
        assert_eq!(parse_number("1,234.5", '.'), Some(1234.5));
        assert_eq!(parse_number("-2.5E-3", '.'), Some(-0.0025));
        assert_eq!(parse_number("abc", '.'), None);
        assert_eq!(parse_number("", '.'), None);
    }

    #[test]
    fn infers_number_text_and_datetime() {
        let (a, b, c) = (text("1,5"), text("2"), text("x"));
        assert_eq!(infer_kind(&[&a, &b], ',').0, ColumnKind::Number);
        assert_eq!(infer_kind(&[&a, &c], ',').0, ColumnKind::Text);

        let (d1, d2) = (text("31-01-2024 13:05"), text("01-02-2024 00:00"));
        assert_eq!(
            infer_kind(&[&d1, &d2], ','),
            (ColumnKind::Datetime, Some("%d-%m-%Y %H:%M".into()))
        );
        let iso = text("2024-01-31 13:05:00.250");
        assert_eq!(
            infer_kind(&[&iso], '.'),
            (ColumnKind::Datetime, Some("%Y-%m-%d %H:%M:%S%.f".into()))
        );
    }

    #[test]
    fn month_first_only_when_day_first_fails() {
        let us = text("12/31/2024");
        assert_eq!(infer_kind(&[&us], '.').1.as_deref(), Some("%m/%d/%Y"));
    }

    fn local(s: &str) -> ParsedTime {
        ParsedTime::Local(NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap())
    }

    fn utc(s: &str) -> i64 {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap().and_utc().timestamp_millis()
    }

    #[test]
    fn copenhagen_dst_fall_back_sequence() {
        // 2024-10-27: clocks go 03:00 CEST -> 02:00 CET, so 02:00-02:59 occurs twice.
        let mut loc = Localizer::new(chrono_tz::Europe::Copenhagen);
        let series = ["2024-10-27 01:30", "2024-10-27 02:30", "2024-10-27 02:30", "2024-10-27 03:30"];
        let out: Vec<i64> = series.iter().map(|s| loc.to_utc_ms(local(s))).collect();
        assert_eq!(
            out,
            vec![
                utc("2024-10-26 23:30"),
                utc("2024-10-27 00:30"), // first pass, CEST
                utc("2024-10-27 01:30"), // second pass, CET
                utc("2024-10-27 02:30"),
            ]
        );
        assert_eq!(loc.ambiguous, 2);
    }

    #[test]
    fn copenhagen_dst_spring_gap() {
        // 2024-03-31: 02:00 CET jumps to 03:00 CEST; 02:30 does not exist.
        let mut loc = Localizer::new(chrono_tz::Europe::Copenhagen);
        assert_eq!(loc.to_utc_ms(local("2024-03-31 02:30")), utc("2024-03-31 01:30"));
        assert_eq!(loc.nonexistent, 1);
    }

    #[test]
    fn rfc3339_ignores_timezone() {
        let mut loc = Localizer::new(chrono_tz::Europe::Copenhagen);
        let t = parse_datetime("2024-06-01T12:00:00Z", RFC3339).unwrap();
        assert_eq!(loc.to_utc_ms(t), utc("2024-06-01 12:00"));
    }

    #[test]
    fn excel_serial() {
        let dt = excel_serial_to_datetime(45292.5).unwrap(); // 2024-01-01 12:00
        assert_eq!(dt.to_string(), "2024-01-01 12:00:00");
    }
}
