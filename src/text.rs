use anyhow::{Result, anyhow, ensure};

/// Only non-ASCII characters need corrections; ASCII stretches use no storage.
struct WideChar {
    start_byte: usize,
    end_byte: usize,
    start_unit: usize,
    end_unit: usize,
}

/// CDP offsets and JS source-map columns count UTF-16 code units, not UTF-8 bytes.
pub struct TextIndex {
    wide: Vec<WideChar>,
    units: usize,
    bytes: usize,
    lines: Vec<(usize, usize)>,
}

impl TextIndex {
    pub fn new(text: &str) -> Self {
        let mut wide = Vec::new();
        let mut units = 0;
        let mut lines = Vec::new();
        let mut line_start = 0;
        let mut chars = text.char_indices().peekable();
        while let Some((byte, ch)) = chars.next() {
            let position = units;
            units += ch.len_utf16();
            if !ch.is_ascii() {
                wide.push(WideChar {
                    start_byte: byte,
                    end_byte: byte + ch.len_utf8(),
                    start_unit: position,
                    end_unit: units,
                });
            }
            if ch == '\r' {
                lines.push((line_start, position));
                if chars.peek().is_some_and(|(_, next)| *next == '\n') {
                    chars.next();
                    units += 1;
                }
                line_start = units;
            } else if matches!(ch, '\n' | '\u{2028}' | '\u{2029}') {
                lines.push((line_start, position));
                line_start = units;
            }
        }
        lines.push((line_start, units));
        Self {
            wide,
            units,
            bytes: text.len(),
            lines,
        }
    }

    pub fn utf16(&self, byte: usize) -> Result<usize> {
        ensure!(byte <= self.bytes, "invalid UTF-8 boundary {byte}");
        let index = self.wide.partition_point(|ch| ch.start_byte < byte);
        let correction = if index == 0 {
            0
        } else {
            let ch = &self.wide[index - 1];
            ensure!(byte >= ch.end_byte, "invalid UTF-8 boundary {byte}");
            ch.end_byte - ch.end_unit
        };
        Ok(byte - correction)
    }

    pub fn utf16_len(&self) -> usize {
        self.units
    }

    pub fn byte(&self, offset: usize) -> Result<usize> {
        ensure!(
            offset <= self.units,
            "invalid UTF-16 offset {offset}: outside source or inside a surrogate pair"
        );
        let index = self.wide.partition_point(|ch| ch.start_unit < offset);
        let correction = if index == 0 {
            0
        } else {
            let ch = &self.wide[index - 1];
            ensure!(
                offset >= ch.end_unit,
                "invalid UTF-16 offset {offset}: outside source or inside a surrogate pair"
            );
            ch.end_byte - ch.end_unit
        };
        Ok(offset + correction)
    }

    pub fn position(&self, line: u32, column: u32) -> Result<usize> {
        let &(start, end) = self
            .lines
            .get(line as usize)
            .ok_or_else(|| anyhow!("source-map line {line} is outside generated source"))?;
        ensure!(
            (column as usize) <= end - start,
            "source-map column {column} exceeds line {line}"
        );
        self.byte(start + column as usize)
    }

    pub fn line_end(&self, line: u32) -> Result<usize> {
        let &(_, end) = self
            .lines
            .get(line as usize)
            .ok_or_else(|| anyhow!("source-map line {line} is outside generated source"))?;
        self.byte(end)
    }
}
