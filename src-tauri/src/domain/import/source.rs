//! Reading CSV and spreadsheet files into rows of raw cells, plus detection of
//! encoding and delimiter.

use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
use chrono::NaiveDateTime;
use encoding_rs_io::DecodeReaderBytesBuilder;
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// A cell before conversion to its column type. CSV yields only `Text`/`Empty`;
/// spreadsheets carry native numbers and dates.
#[derive(Debug, Clone, PartialEq)]
pub enum RawCell {
    Empty,
    Text(String),
    Number(f64),
    DateTime(NaiveDateTime),
}

impl RawCell {
    pub fn is_empty(&self) -> bool {
        match self {
            RawCell::Empty => true,
            RawCell::Text(s) => s.trim().is_empty(),
            _ => false,
        }
    }

    /// Text shown in the import preview.
    pub fn display(&self) -> String {
        match self {
            RawCell::Empty => String::new(),
            RawCell::Text(s) => s.clone(),
            RawCell::Number(f) => format_number(*f),
            RawCell::DateTime(dt) => dt.format("%Y-%m-%d %H:%M:%S").to_string(),
        }
    }
}

pub fn format_number(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e15 {
        format!("{}", f as i64)
    } else {
        f.to_string()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextEncoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "windows-1252")]
    Windows1252,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileFormat {
    #[serde(rename_all = "camelCase")]
    Csv { delimiter: char, encoding: TextEncoding },
    #[serde(rename_all = "camelCase")]
    Spreadsheet { sheet: String },
}

const SPREADSHEET_EXTENSIONS: &[&str] = &["xlsx", "xlsm", "xlsb", "xls", "ods"];

pub fn is_spreadsheet(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| SPREADSHEET_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

pub fn sheet_names(path: &Path) -> AppResult<Vec<String>> {
    Ok(open_workbook_auto(path)?.sheet_names())
}

/// Reads the start of a text file and guesses its encoding.
/// Valid UTF-8 (or a UTF-8 BOM) means UTF-8; anything else is treated as Windows-1252,
/// the usual encoding of Excel CSV exports on Danish/Western Windows.
pub fn detect_encoding(path: &Path) -> AppResult<TextEncoding> {
    let mut buf = Vec::with_capacity(64 * 1024);
    File::open(path)?.take(64 * 1024).read_to_end(&mut buf)?;
    Ok(match std::str::from_utf8(&buf) {
        Ok(_) => TextEncoding::Utf8,
        // A multi-byte char cut off at the end of the buffer is still UTF-8.
        Err(e) if e.error_len().is_none() => TextEncoding::Utf8,
        Err(_) => TextEncoding::Windows1252,
    })
}

/// Reads the first `n` lines of a text file as decoded strings.
pub fn head_lines(path: &Path, encoding: TextEncoding, n: usize) -> AppResult<Vec<String>> {
    let mut text = String::new();
    decoded_reader(path, encoding)?.take(256 * 1024).read_to_string(&mut text)?;
    Ok(text.lines().take(n).map(str::to_owned).collect())
}

/// Picks the candidate delimiter that splits the lines most consistently.
pub fn detect_delimiter(lines: &[String]) -> char {
    const CANDIDATES: [char; 4] = [';', '\t', ',', '|'];
    let lines: Vec<&String> = lines.iter().filter(|l| !l.trim().is_empty()).collect();
    // Score: same count on every line first, then the most columns.
    let mut best: Option<((bool, usize), char)> = None;
    for c in CANDIDATES {
        let counts: Vec<usize> = lines.iter().map(|l| count_outside_quotes(l, c)).collect();
        let min = counts.iter().copied().min().unwrap_or(0);
        let max = counts.iter().copied().max().unwrap_or(0);
        if max == 0 {
            continue;
        }
        let score = (min == max, min);
        if best.is_none_or(|(s, _)| score > s) {
            best = Some((score, c));
        }
    }
    best.map_or(',', |(_, c)| c)
}

fn count_outside_quotes(line: &str, c: char) -> usize {
    let mut in_quotes = false;
    line.chars()
        .filter(|&ch| {
            if ch == '"' {
                in_quotes = !in_quotes;
            }
            ch == c && !in_quotes
        })
        .count()
}

fn decoded_reader(path: &Path, encoding: TextEncoding) -> AppResult<impl Read> {
    let enc = match encoding {
        TextEncoding::Utf8 => None, // pass through, strip BOM if present
        TextEncoding::Windows1252 => Some(encoding_rs::WINDOWS_1252),
    };
    Ok(DecodeReaderBytesBuilder::new()
        .encoding(enc)
        .build(BufReader::new(File::open(path)?)))
}

/// Streams rows of raw cells with their 1-based line (CSV) or row (spreadsheet) number.
/// Blank CSV lines are not reported. Stops early when `f` returns `Ok(false)`.
pub fn read_rows(
    path: &Path,
    format: &FileFormat,
    mut f: impl FnMut(u64, Vec<RawCell>) -> AppResult<bool>,
) -> AppResult<()> {
    match format {
        FileFormat::Csv { delimiter, encoding } => {
            let mut rdr = BufReader::new(decoded_reader(path, *encoding)?);
            let mut buf = Vec::new();
            let mut record = String::new();
            let mut line_no = 0u64;
            let mut record_start = 0u64;
            loop {
                buf.clear();
                if rdr.read_until(b'\n', &mut buf)? == 0 {
                    break;
                }
                line_no += 1;
                let line = String::from_utf8_lossy(&buf);
                let line = line.trim_end_matches(['\n', '\r']);
                if record.is_empty() {
                    record_start = line_no;
                } else {
                    record.push('\n');
                }
                record.push_str(line);
                // An odd number of quotes means a quoted field continues on the next line.
                if record.matches('"').count() % 2 == 1 {
                    continue;
                }
                if !record.trim().is_empty() {
                    let row = split_record(&record, *delimiter).into_iter().map(text_cell).collect();
                    if !f(record_start, row)? {
                        return Ok(());
                    }
                }
                record.clear();
            }
            if !record.trim().is_empty() {
                // Unterminated quote at end of file: take what is there.
                let row = split_record(&record, *delimiter).into_iter().map(text_cell).collect();
                f(record_start, row)?;
            }
        }
        FileFormat::Spreadsheet { sheet } => {
            let mut wb = open_workbook_auto(path)?;
            let range = wb.worksheet_range(sheet)?;
            // The range starts at the first used cell; offset so numbers match the sheet.
            let (row0, col0) = range.start().unwrap_or((0, 0));
            for (i, cells) in range.rows().enumerate() {
                let mut row = vec![RawCell::Empty; col0 as usize];
                row.extend(cells.iter().map(convert_spreadsheet_cell));
                if !f(u64::from(row0) + i as u64 + 1, row)? {
                    break;
                }
            }
        }
    }
    Ok(())
}

fn text_cell(s: String) -> RawCell {
    if s.trim().is_empty() {
        RawCell::Empty
    } else {
        RawCell::Text(s)
    }
}

/// Splits one CSV record (possibly spanning lines) into fields. Fields may be quoted
/// with `"`; a doubled `""` inside quotes is a literal quote.
fn split_record(record: &str, delimiter: char) -> Vec<String> {
    let mut fields = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut chars = record.chars().peekable();
    while let Some(c) = chars.next() {
        if in_quotes {
            if c == '"' {
                if chars.peek() == Some(&'"') {
                    field.push('"');
                    chars.next();
                } else {
                    in_quotes = false;
                }
            } else {
                field.push(c);
            }
        } else if c == '"' && field.trim().is_empty() {
            field.clear();
            in_quotes = true;
        } else if c == delimiter {
            fields.push(std::mem::take(&mut field));
        } else {
            field.push(c);
        }
    }
    fields.push(field);
    fields
}

fn convert_spreadsheet_cell(d: &Data) -> RawCell {
    match d {
        Data::Int(i) => RawCell::Number(*i as f64),
        Data::Float(f) => RawCell::Number(*f),
        Data::String(s) if s.trim().is_empty() => RawCell::Empty,
        Data::String(s) | Data::DateTimeIso(s) | Data::DurationIso(s) => RawCell::Text(s.clone()),
        Data::Bool(b) => RawCell::Number(if *b { 1.0 } else { 0.0 }),
        Data::DateTime(dt) => match dt.as_datetime() {
            Some(n) => RawCell::DateTime(n),
            None => RawCell::Number(dt.as_f64()),
        },
        Data::Error(_) | Data::Empty => RawCell::Empty,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(s: &str) -> Vec<String> {
        s.lines().map(str::to_owned).collect()
    }

    #[test]
    fn detects_semicolon() {
        assert_eq!(detect_delimiter(&lines("a;b;c\n1,5;2,5;3\n4;5;6")), ';');
    }

    #[test]
    fn detects_comma() {
        assert_eq!(detect_delimiter(&lines("a,b,c\n1.5,2.5,3\n4,5,6")), ',');
    }

    #[test]
    fn detects_tab_and_ignores_quoted() {
        assert_eq!(detect_delimiter(&lines("a\tb\n\"x,y,z\"\t2")), '\t');
    }

    #[test]
    fn splits_quoted_fields() {
        assert_eq!(split_record(r#"a;"b;c";"say ""hi""";"#, ';'), ["a", "b;c", "say \"hi\"", ""]);
    }

    #[test]
    fn reports_true_line_numbers() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.csv");
        std::fs::write(&p, "a;b\r\n\"x\r\ny\";2\r\n\r\n5;6\r\n").unwrap();
        let fmt = FileFormat::Csv { delimiter: ';', encoding: TextEncoding::Utf8 };
        let mut seen = Vec::new();
        read_rows(&p, &fmt, |line, row| {
            seen.push((line, row.len()));
            Ok(true)
        })
        .unwrap();
        assert_eq!(seen, [(1, 2), (2, 2), (5, 2)]);
    }

    #[test]
    fn detects_windows1252() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("f.csv");
        std::fs::write(&p, b"Temperatur;M\xe6ngde\n1;2\n").unwrap();
        assert_eq!(detect_encoding(&p).unwrap(), TextEncoding::Windows1252);
        let head = head_lines(&p, TextEncoding::Windows1252, 1).unwrap();
        assert_eq!(head[0], "Temperatur;Mængde");
    }
}
