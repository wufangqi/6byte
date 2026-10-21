//! Encoding detection, decoding and re-encoding.
//!
//! Design rules (see docs/技术选型与路线图.md, ADR-012):
//! * The frontend only ever sees UTF-8 `String`s.
//! * A file is written back with the *original* charset / BOM / EOL unless the
//!   user explicitly asks for a conversion.
//! * Lossy decodes are surfaced to the UI (`meta.lossy`) so saving can warn.

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    #[default]
    Lf,
    Crlf,
    Cr,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    /// Encoding label, e.g. "UTF-8", "GBK", "UTF-16LE", "windows-1252".
    pub charset: String,
    /// Whether the file carries a byte order mark.
    pub bom: bool,
    /// Dominant line ending of the file.
    pub eol: Eol,
    /// True when the bytes could not be decoded cleanly.
    pub lossy: bool,
    /// True when the file mixed CRLF/LF/CR line endings. Saving normalizes the
    /// whole buffer to `eol`, so the UI warns before doing that.
    #[serde(default)]
    pub mixed_eol: bool,
}

pub struct Decoded {
    pub content: String,
    pub meta: FileMeta,
}

const BOM_UTF8: [u8; 3] = [0xEF, 0xBB, 0xBF];
const BOM_UTF16LE: [u8; 2] = [0xFF, 0xFE];
const BOM_UTF16BE: [u8; 2] = [0xFE, 0xFF];

/// Decode raw bytes into a UTF-8 string plus the metadata needed to write it back.
pub fn decode(bytes: &[u8]) -> Decoded {
    if bytes.starts_with(&BOM_UTF8) {
        let (text, _, had_errors) = UTF_8.decode(&bytes[BOM_UTF8.len()..]);
        return finish(text.into_owned(), "UTF-8", true, had_errors);
    }
    if bytes.starts_with(&BOM_UTF16LE) {
        let (text, _, had_errors) = UTF_16LE.decode(&bytes[BOM_UTF16LE.len()..]);
        return finish(text.into_owned(), "UTF-16LE", true, had_errors);
    }
    if bytes.starts_with(&BOM_UTF16BE) {
        let (text, _, had_errors) = UTF_16BE.decode(&bytes[BOM_UTF16BE.len()..]);
        return finish(text.into_owned(), "UTF-16BE", true, had_errors);
    }

    // Most files are plain UTF-8: prefer the strict check before guessing.
    if let Ok(text) = std::str::from_utf8(bytes) {
        return finish(text.to_string(), "UTF-8", false, false);
    }

    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, true);
    let (text, _, had_errors) = encoding.decode(bytes);
    finish(text.into_owned(), encoding.name(), false, had_errors)
}

fn finish(content: String, charset: &str, bom: bool, lossy: bool) -> Decoded {
    let (eol, mixed_eol) = detect_eol(&content);
    Decoded {
        content,
        meta: FileMeta {
            charset: charset.to_string(),
            bom,
            eol,
            lossy,
            mixed_eol,
        },
    }
}

/// Returns the dominant line ending plus whether more than one flavour occurs.
fn detect_eol(text: &str) -> (Eol, bool) {
    let bytes = text.as_bytes();
    let (mut crlf, mut lf, mut cr) = (0usize, 0usize, 0usize);
    let mut i = 0;

    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                if bytes.get(i + 1) == Some(&b'\n') {
                    crlf += 1;
                    i += 2;
                    continue;
                }
                cr += 1;
            }
            b'\n' => lf += 1,
            _ => {}
        }
        i += 1;
    }

    let flavours = usize::from(crlf > 0) + usize::from(lf > 0) + usize::from(cr > 0);
    let mixed = flavours > 1;

    let eol = if crlf > 0 && crlf >= lf && crlf >= cr {
        Eol::Crlf
    } else if cr > 0 && cr > lf && cr > crlf {
        Eol::Cr
    } else {
        Eol::Lf
    };

    (eol, mixed)
}

/// Encode `content` back to bytes using the metadata recorded at open time.
pub fn encode(content: &str, meta: &FileMeta) -> Result<Vec<u8>, String> {
    let normalized = normalize_eol(content, meta.eol);
    let encoding = Encoding::for_label(meta.charset.as_bytes())
        .ok_or_else(|| format!("不支持的编码：{}", meta.charset))?;

    // `encoding_rs` only uses UTF-16 encodings as decoders, so encode those by hand.
    if encoding == UTF_16LE || encoding == UTF_16BE {
        let little_endian = encoding == UTF_16LE;
        let mut out = Vec::with_capacity(normalized.len() * 2 + 2);
        if meta.bom {
            out.extend_from_slice(if little_endian {
                &BOM_UTF16LE
            } else {
                &BOM_UTF16BE
            });
        }
        for unit in normalized.encode_utf16() {
            out.extend_from_slice(&if little_endian {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
        return Ok(out);
    }

    let mut out: Vec<u8> = Vec::with_capacity(normalized.len() + 3);
    if meta.bom && encoding == UTF_8 {
        out.extend_from_slice(&BOM_UTF8);
    }

    let (bytes, _, had_errors) = encoding.encode(&normalized);
    if had_errors {
        return Err(format!(
            "内容包含 {} 无法表示的字符，请先转换为 UTF-8",
            encoding.name()
        ));
    }

    out.extend_from_slice(&bytes);
    Ok(out)
}

fn normalize_eol(content: &str, eol: Eol) -> String {
    let unix = if content.contains('\r') {
        content.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        content.to_string()
    };

    match eol {
        Eol::Lf => unix,
        Eol::Crlf => unix.replace('\n', "\r\n"),
        Eol::Cr => unix.replace('\n', "\r"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_utf8_without_bom() {
        let file = decode("你好，世界\n".as_bytes());
        assert_eq!(file.meta.charset, "UTF-8");
        assert!(!file.meta.bom);
        assert_eq!(file.meta.eol, Eol::Lf);
        assert!(!file.meta.lossy);
    }

    #[test]
    fn detects_utf8_bom_and_strips_it() {
        let mut bytes = BOM_UTF8.to_vec();
        bytes.extend_from_slice(b"hello\nworld\n");
        let file = decode(&bytes);
        assert_eq!(file.meta.charset, "UTF-8");
        assert!(file.meta.bom);
        assert_eq!(file.content, "hello\nworld\n");
    }

    #[test]
    fn decodes_gbk() {
        // "中文" in GBK
        let bytes = [0xD6, 0xD0, 0xCE, 0xC4];
        let file = decode(&bytes);
        assert_eq!(file.content, "中文");
        assert_ne!(file.meta.charset, "UTF-8");
    }

    #[test]
    fn round_trips_gbk() {
        let bytes = [0xD6, 0xD0, 0xCE, 0xC4];
        let file = decode(&bytes);
        let back = encode(&file.content, &file.meta).unwrap();
        assert_eq!(back, bytes);
    }

    #[test]
    fn detects_crlf() {
        let file = decode(b"a\r\nb\r\nc\r\n");
        assert_eq!(file.meta.eol, Eol::Crlf);
    }

    #[test]
    fn preserves_crlf_on_save() {
        let meta = FileMeta {
            charset: "UTF-8".into(),
            bom: false,
            eol: Eol::Crlf,
            lossy: false,
            mixed_eol: false,
        };
        let bytes = encode("a\nb\n", &meta).unwrap();
        assert_eq!(bytes, b"a\r\nb\r\n");
    }

    #[test]
    fn detects_mixed_eol() {
        let file = decode(b"a\r\nb\nc\r\n");
        assert_eq!(file.meta.eol, Eol::Crlf, "CRLF is dominant");
        assert!(file.meta.mixed_eol);
    }

    #[test]
    fn single_flavour_is_not_mixed() {
        assert!(!decode(b"a\nb\n").meta.mixed_eol);
        assert!(!decode(b"a\r\nb\r\n").meta.mixed_eol);
        assert!(!decode(b"a\rb\r").meta.mixed_eol);
        assert!(!decode(b"single line").meta.mixed_eol);
    }

    #[test]
    fn mixed_eol_is_normalized_to_dominant_on_save() {
        let file = decode(b"a\r\nb\nc\r\n");
        let bytes = encode(&file.content, &file.meta).unwrap();
        assert_eq!(bytes, b"a\r\nb\r\nc\r\n");
        // Re-decoding the saved bytes must report a clean, single flavour.
        let reopened = decode(&bytes);
        assert!(!reopened.meta.mixed_eol);
        assert_eq!(reopened.meta.eol, Eol::Crlf);
    }

    #[test]
    fn cr_only_file_survives_round_trip() {
        let file = decode(b"a\rb\rc");
        assert_eq!(file.meta.eol, Eol::Cr);
        assert!(!file.meta.mixed_eol);
        assert_eq!(encode(&file.content, &file.meta).unwrap(), b"a\rb\rc");
    }

    #[test]
    fn utf16le_round_trip_keeps_bom() {
        let mut bytes = BOM_UTF16LE.to_vec();
        for unit in "hi".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let file = decode(&bytes);
        assert_eq!(file.content, "hi");
        assert_eq!(file.meta.charset, "UTF-16LE");
        assert_eq!(encode(&file.content, &file.meta).unwrap(), bytes);
    }

    #[test]
    fn unencodable_characters_are_rejected() {
        let meta = FileMeta {
            charset: "GBK".into(),
            bom: false,
            eol: Eol::Lf,
            lossy: false,
            mixed_eol: false,
        };
        assert!(encode("emoji 😀", &meta).is_err());
    }
}

/// Fixed on-disk fixtures (bytes checked into `src-tauri/fixtures/`), so encoding
/// behaviour is regression-tested against real files rather than strings built in
/// the test body.
#[cfg(test)]
mod fixture_tests {
    use super::*;

    #[test]
    fn utf8_lf_is_clean() {
        let file = decode(include_bytes!("../fixtures/utf8-lf.txt"));
        assert_eq!(file.meta.charset, "UTF-8");
        assert_eq!(file.meta.eol, Eol::Lf);
        assert!(!file.meta.bom && !file.meta.lossy && !file.meta.mixed_eol);
        assert_eq!(file.content, "中文\n测试\n");
    }

    #[test]
    fn utf8_bom_crlf_keeps_bom_metadata() {
        let file = decode(include_bytes!("../fixtures/utf8-bom-crlf.txt"));
        assert_eq!(file.meta.charset, "UTF-8");
        assert!(file.meta.bom);
        assert_eq!(file.meta.eol, Eol::Crlf);
        assert_eq!(file.content, "hello\r\nworld\r\n");
    }

    #[test]
    fn gbk_crlf_round_trips_byte_exactly() {
        let raw = include_bytes!("../fixtures/gbk-crlf.txt");
        let file = decode(raw);
        assert_eq!(file.meta.charset, "GBK");
        assert_eq!(file.meta.eol, Eol::Crlf);
        assert!(!file.meta.lossy);
        assert_eq!(file.content, "中文测试\r\n测试\r\n");
        assert_eq!(encode(&file.content, &file.meta).unwrap(), raw.to_vec());
    }

    #[test]
    fn utf16le_bom_is_decoded() {
        let file = decode(include_bytes!("../fixtures/utf16le-bom.txt"));
        assert_eq!(file.meta.charset, "UTF-16LE");
        assert!(file.meta.bom);
        assert_eq!(file.content, "hi\r\n");
    }

    #[test]
    fn cr_only_file_keeps_cr() {
        let file = decode(include_bytes!("../fixtures/cr-only.txt"));
        assert_eq!(file.meta.eol, Eol::Cr);
        assert!(!file.meta.mixed_eol);
        assert_eq!(
            encode(&file.content, &file.meta).unwrap(),
            b"a\rb\rc".to_vec()
        );
    }

    #[test]
    fn mixed_eol_fixture_is_flagged() {
        let file = decode(include_bytes!("../fixtures/mixed-eol.txt"));
        assert!(file.meta.mixed_eol);
        assert_eq!(file.meta.eol, Eol::Crlf, "CRLF is the dominant flavour");
    }

    #[test]
    fn gb18030_four_byte_sequence_decodes_without_loss() {
        let file = decode(include_bytes!("../fixtures/gb18030-4byte.txt"));
        assert!(!file.meta.lossy);
        assert_eq!(file.content, "\u{20000}\n");
    }
}
