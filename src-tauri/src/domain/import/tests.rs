use std::path::{Path, PathBuf};

use serde_json::json;

use super::*;
use crate::domain::project::Project;
use crate::domain::tables;

fn project(dir: &Path) -> Project {
    Project::create(&dir.join("p.dtwin"), "Test").unwrap()
}

fn write(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

fn options_from(preview: Preview, timezone: &str) -> ImportOptions {
    ImportOptions {
        format: preview.format,
        decimal: preview.decimal,
        header_row: preview.header_row,
        skip_rows: preview.skip_rows,
        timezone: timezone.into(),
        table_name: preview.suggested_table_name,
        columns: preview.columns,
    }
}

/// Danish Excel-style export: Windows-1252, semicolons, decimal comma, day-first dates.
const DANISH_CSV: &[u8] = b"Tidspunkt;Temperatur;Tryk;M\xe6rke\r\n\
31-03-2024 01:30;80,5;1,013;A\r\n\
31-03-2024 03:30;81,25;1,020;B\r\n\
\r\n\
31-03-2024 04:30;fejl;1,030;C\r\n";

#[test]
fn preview_detects_danish_csv() {
    let dir = tempfile::tempdir().unwrap();
    let p = project(dir.path());
    let file = write(dir.path(), "målinger.csv", DANISH_CSV);

    let pv = preview(&p.conn, &file, PreviewSettings::default()).unwrap();
    assert_eq!(
        pv.format,
        FileFormat::Csv { delimiter: ';', encoding: source::TextEncoding::Windows1252 }
    );
    assert_eq!(pv.decimal, ',');
    assert!(pv.header_row);
    assert_eq!(pv.suggested_table_name, "målinger");
    let names: Vec<&str> = pv.columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["Tidspunkt", "Temperatur", "Tryk", "Mærke"]);
    let kinds: Vec<ColumnKind> = pv.columns.iter().map(|c| c.kind).collect();
    // "fejl" makes Temperatur text in the sample; Tryk is numeric.
    assert_eq!(kinds, [ColumnKind::Datetime, ColumnKind::Text, ColumnKind::Number, ColumnKind::Text]);
    assert_eq!(pv.columns[0].datetime_format.as_deref(), Some("%d-%m-%Y %H:%M"));
    assert_eq!(pv.rows.len(), 3, "blank line skipped");
}

#[test]
fn imports_danish_csv_with_overrides() {
    let dir = tempfile::tempdir().unwrap();
    let mut p = project(dir.path());
    let file = write(dir.path(), "data.csv", DANISH_CSV);

    let pv = preview(&p.conn, &file, PreviewSettings::default()).unwrap();
    let mut opts = options_from(pv, "Europe/Copenhagen");
    opts.columns[1].kind = ColumnKind::Number; // force numeric despite "fejl"
    opts.columns[3].kind = ColumnKind::Skip;

    let mut progress = Vec::new();
    let result = run(&mut p.conn, &file, &opts, |n| progress.push(n)).unwrap();
    assert_eq!(result.table.row_count, 3);
    assert_eq!(result.table.columns.len(), 3);
    assert_eq!(progress.last(), Some(&3));

    // 1 invalid number; 2024-03-31 is the spring DST change but 01:30 and 03:30 both exist.
    assert_eq!(result.warnings.len(), 1, "{:?}", result.warnings);
    assert!(result.warnings[0].contains("Temperatur: 1 value"));
    assert!(result.warnings[0].contains("row 5"), "{}", result.warnings[0]);

    let rows = tables::rows(&p.conn, result.table.id, 0, 10).unwrap();
    assert_eq!(rows[0], vec![json!(1711845000000i64), json!(80.5), json!(1.013)]); // 00:30Z
    assert_eq!(rows[1][0], json!(1711848600000i64)); // 03:30 CEST = 01:30Z
    assert_eq!(rows[2][1], json!(null));
}

#[test]
fn rejects_duplicate_table_and_column_names() {
    let dir = tempfile::tempdir().unwrap();
    let mut p = project(dir.path());
    let file = write(dir.path(), "a.csv", b"x,y\n1,2\n");

    let pv = preview(&p.conn, &file, PreviewSettings::default()).unwrap();
    let opts = options_from(pv, "UTC");
    run(&mut p.conn, &file, &opts, |_| {}).unwrap();
    assert!(run(&mut p.conn, &file, &opts, |_| {}).is_err(), "table name taken");

    let mut dup = opts.clone();
    dup.table_name = "b".into();
    dup.columns[1].name = "X".into();
    assert!(run(&mut p.conn, &file, &dup, |_| {}).is_err(), "column names are case-insensitive");
    assert_eq!(tables::list(&p.conn).unwrap().len(), 1, "failed import rolled back");
}

#[test]
fn skip_rows_and_no_header() {
    let dir = tempfile::tempdir().unwrap();
    let p = project(dir.path());
    let file = write(dir.path(), "b.csv", b"Exported by SCADA\nunit: degC\n1.5,2\n3.5,4\n");

    let pv = preview(
        &p.conn,
        &file,
        PreviewSettings { skip_rows: Some(2), ..Default::default() },
    )
    .unwrap();
    assert!(!pv.header_row);
    assert_eq!(pv.columns[0].name, "Column 1");
    assert_eq!(pv.decimal, '.');
    assert_eq!(pv.rows, vec![vec!["1.5", "2"], vec!["3.5", "4"]]);
}

#[test]
fn imports_xlsx_with_native_dates() {
    use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};

    let dir = tempfile::tempdir().unwrap();
    let mut p = project(dir.path());
    let file = dir.path().join("lab.xlsx");

    let mut wb = Workbook::new();
    let ws = wb.add_worksheet().set_name("QC").unwrap();
    let date_fmt = Format::new().set_num_format("yyyy-mm-dd hh:mm");
    ws.write_string(0, 0, "Sampled").unwrap();
    ws.write_string(0, 1, "Density").unwrap();
    ws.write_string(0, 2, "Batch").unwrap();
    for (r, (h, d, b)) in [(8, 0.81, "B1"), (12, 0.82, "B2")].iter().enumerate() {
        let r = r as u32 + 1;
        let dt = ExcelDateTime::from_ymd(2024, 7, 1).unwrap().and_hms(*h, 0, 0).unwrap();
        ws.write_datetime_with_format(r, 0, &dt, &date_fmt).unwrap();
        ws.write_number(r, 1, *d).unwrap();
        ws.write_string(r, 2, *b).unwrap();
    }
    wb.add_worksheet().set_name("Notes").unwrap();
    wb.save(&file).unwrap();

    let pv = preview(&p.conn, &file, PreviewSettings::default()).unwrap();
    assert_eq!(pv.sheets, ["QC", "Notes"]);
    assert_eq!(pv.format, FileFormat::Spreadsheet { sheet: "QC".into() });
    let kinds: Vec<ColumnKind> = pv.columns.iter().map(|c| c.kind).collect();
    assert_eq!(kinds, [ColumnKind::Datetime, ColumnKind::Number, ColumnKind::Text]);
    assert_eq!(pv.rows[0][0], "2024-07-01 08:00:00");

    let opts = options_from(pv, "Europe/Copenhagen");
    let result = run(&mut p.conn, &file, &opts, |_| {}).unwrap();
    let rows = tables::rows(&p.conn, result.table.id, 0, 10).unwrap();
    // 08:00 CEST = 06:00Z
    assert_eq!(rows[0], vec![json!(1719813600000i64), json!(0.81), json!("B1")]);

    tables::delete(&mut p.conn, result.table.id).unwrap();
    assert!(tables::list(&p.conn).unwrap().is_empty());
}

/// Run with `cargo test --release -- --ignored large_import` to check throughput.
#[test]
#[ignore]
fn large_import() {
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let mut p = project(dir.path());
    let file = dir.path().join("big.csv");
    let mut w = std::io::BufWriter::new(std::fs::File::create(&file).unwrap());
    writeln!(w, "Time;T1;T2;P1;F1;Tag").unwrap();
    for i in 0..1_000_000u64 {
        let (d, s) = (i / 86_400, i % 86_400);
        writeln!(
            w,
            "{:02}-01-2024 {:02}:{:02}:{:02};{},5;{},25;1,0{};{};tag{}",
            d % 28 + 1, s / 3600, s / 60 % 60, s % 60, i % 100, i % 50, i % 10, i, i % 7
        )
        .unwrap();
    }
    drop(w);

    let t0 = std::time::Instant::now();
    let pv = preview(&p.conn, &file, PreviewSettings::default()).unwrap();
    let opts = options_from(pv, "Europe/Copenhagen");
    let result = run(&mut p.conn, &file, &opts, |_| {}).unwrap();
    eprintln!("imported {} rows in {:?}", result.table.row_count, t0.elapsed());
    assert_eq!(result.table.row_count, 1_000_000);
}

/// A minute-by-minute local-time log across the end of DST: 02:00-02:59 appears twice.
#[test]
fn scada_log_is_monotonic_across_dst() {
    let dir = tempfile::tempdir().unwrap();
    let mut p = project(dir.path());

    // Windows-1252 header (0xB3 = ³), CRLF line endings, decimal comma.
    let mut csv = b"Tidspunkt;Produktdensitet (kg/m\xb3)\r\n".to_vec();
    let minutes = (0..180).chain(120..360); // 00:00-02:59, then 02:00-05:59 again
    for (i, m) in minutes.enumerate() {
        csv.extend(format!("27-10-2024 {:02}:{:02};812,{}\r\n", m / 60, m % 60, i % 10).as_bytes());
    }
    let file = write(dir.path(), "scada.csv", &csv);

    let pv = preview(&p.conn, &file, PreviewSettings::default()).unwrap();
    assert_eq!(pv.columns[1].name, "Produktdensitet (kg/m³)");
    let opts = options_from(pv, "Europe/Copenhagen");
    let result = run(&mut p.conn, &file, &opts, |_| {}).unwrap();
    assert_eq!(result.table.row_count, 420);
    assert!(result.warnings.iter().any(|w| w.contains("120 timestamp(s) fell in the repeated hour")));

    let rows = tables::rows(&p.conn, result.table.id, 0, 1000).unwrap();
    let times: Vec<i64> = rows.iter().map(|r| r[0].as_i64().unwrap()).collect();
    assert!(times.windows(2).all(|w| w[1] - w[0] == 60_000), "one minute apart, no gaps or repeats");
}
