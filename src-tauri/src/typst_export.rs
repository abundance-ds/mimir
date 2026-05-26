use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Deserialize)]
pub struct PdfExportRequest {
    pub markdown: String,
    pub output_path: String,
    pub template: Option<String>, // "clean", "academic", "report", "letter", "compact"
    pub font_family: Option<String>,
    pub font_size: Option<f32>,      // pt
    pub page_size: Option<String>,   // "a4", "us-letter"
    pub bib_content: Option<String>, // BibTeX content for bibliography
    pub bib_style: Option<String>,   // "apa", "chicago", "ieee"
}

// ---------------------------------------------------------------------------
// Typst binary discovery
// ---------------------------------------------------------------------------

fn find_typst() -> Option<PathBuf> {
    let suffix = if cfg!(target_os = "windows") {
        "typst-x86_64-pc-windows-msvc.exe"
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "typst-aarch64-apple-darwin"
        } else {
            "typst-x86_64-apple-darwin"
        }
    } else {
        "typst-x86_64-unknown-linux-gnu"
    };

    // 1. Next to current executable (production bundle)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(suffix);
            if candidate.exists() {
                return Some(candidate);
            }
            let candidate = dir.join("typst");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }

    // 2. src-tauri/binaries/ (development)
    for prefix in &["src-tauri/binaries", "binaries"] {
        let candidate = Path::new(prefix).join(suffix);
        if candidate.exists() {
            return Some(candidate);
        }
    }

    // 3. CARGO_MANIFEST_DIR/binaries/ (development, compile-time)
    let manifest_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(suffix);
    if manifest_path.exists() {
        return Some(manifest_path);
    }

    // 4. Fall back to system PATH
    let bin_name = if cfg!(target_os = "windows") {
        "typst.exe"
    } else {
        "typst"
    };
    #[cfg(unix)]
    {
        if let Ok(output) = Command::new("/bin/bash")
            .args(["-lc", &format!("which {}", bin_name)])
            .output()
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Some(PathBuf::from(path));
                }
            }
        }
        for path in &[
            "/usr/local/bin/typst",
            "/opt/homebrew/bin/typst",
            "/usr/bin/typst",
        ] {
            if Path::new(path).exists() {
                return Some(PathBuf::from(path));
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            let cargo_path = PathBuf::from(format!("{home}/.cargo/bin/typst"));
            if cargo_path.exists() {
                return Some(cargo_path);
            }
        }
    }
    #[cfg(windows)]
    {
        if let Ok(output) = Command::new("where").arg(bin_name).output() {
            if output.status.success() {
                if let Some(path) = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .map(|l| l.trim().to_string())
                {
                    if !path.is_empty() {
                        return Some(PathBuf::from(path));
                    }
                }
            }
        }
    }

    None
}

/// Find the bundled fonts directory (public/fonts/).
fn find_font_dir() -> Option<String> {
    // Dev mode: public/fonts/ relative to CARGO_MANIFEST_DIR (src-tauri/)
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let dev_fonts = Path::new(&manifest_dir)
            .join("..")
            .join("public")
            .join("fonts");
        if dev_fonts.is_dir() {
            if let Ok(canonical) = dev_fonts.canonicalize() {
                return Some(canonical.to_string_lossy().to_string());
            }
        }
    }

    // Production: next to the executable
    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            for candidate in &[exe_dir.join("fonts"), exe_dir.join("../Resources/fonts")] {
                if candidate.is_dir() {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Markdown → Typst conversion
// ---------------------------------------------------------------------------

/// Pre-process raw markdown to convert Pandoc-style citations to Typst citations
/// BEFORE pulldown-cmark parses it (the parser eats the brackets).
/// `[@key]` → `\x01key`, `[@k1; @k2]` → `\x01k1 \x01k2`
/// The \x01 placeholder is restored to `@` after conversion.
fn preprocess_citations(markdown: &str) -> String {
    let mut result = String::with_capacity(markdown.len());
    let mut in_code_fence = false;

    for line in markdown.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_fence = !in_code_fence;
            result.push_str(line);
            result.push('\n');
            continue;
        }
        if in_code_fence {
            result.push_str(line);
            result.push('\n');
            continue;
        }

        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            // Skip inline code
            if chars[i] == '`' {
                result.push('`');
                i += 1;
                while i < chars.len() && chars[i] != '`' {
                    result.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() {
                    result.push('`');
                    i += 1;
                }
                continue;
            }

            if i + 1 < chars.len() && chars[i] == '[' && chars[i + 1] == '@' {
                let start = i;
                i += 1; // skip [
                let mut buf = String::new();
                while i < chars.len() && chars[i] != ']' {
                    buf.push(chars[i]);
                    i += 1;
                }
                if i < chars.len() && chars[i] == ']' {
                    i += 1; // skip ]
                    let mut keys = Vec::new();
                    for part in buf.split(';') {
                        let part = part.trim();
                        if let Some(key) = part.strip_prefix('@') {
                            let key = key.split_whitespace().next().unwrap_or(key);
                            if !key.is_empty() {
                                keys.push(key.to_string());
                            }
                        }
                    }
                    if !keys.is_empty() {
                        for (j, key) in keys.iter().enumerate() {
                            if j > 0 {
                                result.push(' ');
                            }
                            result.push('\x01');
                            result.push_str(key);
                        }
                    } else {
                        for c in &chars[start..i] {
                            result.push(*c);
                        }
                    }
                } else {
                    for c in &chars[start..chars.len()] {
                        result.push(*c);
                    }
                    break;
                }
            } else {
                result.push(chars[i]);
                i += 1;
            }
        }
        result.push('\n');
    }

    // Preserve original trailing newline state
    if result.ends_with('\n') && !markdown.ends_with('\n') {
        result.pop();
    }

    result
}

fn escape_typst_string(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Escape characters with special meaning in Typst markup mode.
/// Applied to plain text from pulldown-cmark -- NOT code blocks, NOT string literals.
/// The \x01 placeholder (for citations) is left untouched.
fn escape_typst_markup(text: &str) -> String {
    let mut result = String::with_capacity(text.len() + text.len() / 8);
    for ch in text.chars() {
        match ch {
            '\\' => result.push_str("\\\\"),
            '#' => result.push_str("\\#"),
            '$' => result.push_str("\\$"),
            '@' => result.push_str("\\@"),
            '~' => result.push_str("\\~"),
            '*' => result.push_str("\\*"),
            '_' => result.push_str("\\_"),
            '`' => result.push_str("\\`"),
            '[' => result.push_str("\\["),
            ']' => result.push_str("\\]"),
            '{' => result.push_str("\\{"),
            '}' => result.push_str("\\}"),
            '<' => result.push_str("\\<"),
            '>' => result.push_str("\\>"),
            _ => result.push(ch),
        }
    }
    result
}

/// Convert markdown to Typst markup using pulldown-cmark.
fn markdown_to_typst(markdown: &str) -> String {
    let preprocessed = preprocess_citations(markdown);

    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_FOOTNOTES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_MATH);

    let parser = Parser::new_ext(&preprocessed, opts);
    let mut output = String::new();
    let mut list_stack: Vec<Option<u64>> = Vec::new();
    #[allow(unused_assignments)]
    let mut table_cols: usize = 0;
    let mut _table_header = false;
    let mut _table_cell_count: usize = 0;
    let mut in_code_block = false;
    let mut code_lang = String::new();
    let mut code_buf = String::new();

    for event in parser {
        match event {
            Event::Start(tag) => match tag {
                Tag::Heading { level, .. } => {
                    let marker = match level {
                        HeadingLevel::H1 => "= ",
                        HeadingLevel::H2 => "== ",
                        HeadingLevel::H3 => "=== ",
                        HeadingLevel::H4 => "==== ",
                        HeadingLevel::H5 => "===== ",
                        HeadingLevel::H6 => "====== ",
                    };
                    output.push_str(marker);
                }
                Tag::Paragraph => {
                    if !output.is_empty() && !output.ends_with('\n') {
                        output.push('\n');
                    }
                }
                Tag::BlockQuote(_) => {
                    output.push_str("#quote[\n");
                }
                Tag::CodeBlock(kind) => {
                    in_code_block = true;
                    code_buf.clear();
                    code_lang = match kind {
                        CodeBlockKind::Fenced(lang) => {
                            let s = lang.to_string();
                            if s.starts_with('{') {
                                s.trim_start_matches('{')
                                    .trim_end_matches('}')
                                    .split(',')
                                    .next()
                                    .unwrap_or("")
                                    .trim()
                                    .to_string()
                            } else {
                                s
                            }
                        }
                        CodeBlockKind::Indented => String::new(),
                    };
                }
                Tag::List(start) => {
                    list_stack.push(start);
                }
                Tag::Item => {
                    let indent = "  ".repeat(list_stack.len().saturating_sub(1));
                    match list_stack.last() {
                        Some(Some(n)) => {
                            output.push_str(&format!("{}{}. ", indent, n));
                            if let Some(Some(ref mut n)) = list_stack.last_mut() {
                                *n += 1;
                            }
                        }
                        _ => {
                            output.push_str(&format!("{}- ", indent));
                        }
                    }
                }
                Tag::Emphasis => {
                    output.push('_');
                }
                Tag::Strong => {
                    output.push('*');
                }
                Tag::Strikethrough => {
                    output.push_str("#strike[");
                }
                Tag::Link {
                    dest_url, title: _, ..
                } => {
                    output.push_str(&format!("#link(\"{}\")[", escape_typst_string(&dest_url)));
                }
                Tag::Image {
                    dest_url, title: _, ..
                } => {
                    output.push_str(&format!("#image(\"{}\")", escape_typst_string(&dest_url)));
                }
                Tag::Table(alignments) => {
                    table_cols = alignments.len();
                    let cols = alignments
                        .iter()
                        .map(|a| match a {
                            pulldown_cmark::Alignment::Left => "left",
                            pulldown_cmark::Alignment::Center => "center",
                            pulldown_cmark::Alignment::Right => "right",
                            pulldown_cmark::Alignment::None => "auto",
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    output.push_str(&format!(
                        "#table(\n  columns: ({}),\n",
                        "1fr, ".repeat(table_cols).trim_end_matches(", ")
                    ));
                    output.push_str(&format!("  align: ({}),\n", cols));
                }
                Tag::TableHead => {
                    _table_header = true;
                    _table_cell_count = 0;
                }
                Tag::TableRow => {
                    _table_cell_count = 0;
                }
                Tag::TableCell => {
                    output.push_str("  [");
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Heading(_) => {
                    output.push('\n');
                }
                TagEnd::Paragraph => {
                    output.push_str("\n\n");
                }
                TagEnd::BlockQuote(_) => {
                    output.push_str("]\n\n");
                }
                TagEnd::CodeBlock => {
                    in_code_block = false;
                    if code_lang.is_empty() {
                        output.push_str(&format!("```\n{}\n```\n\n", code_buf.trim_end()));
                    } else {
                        output.push_str(&format!(
                            "```{}\n{}\n```\n\n",
                            code_lang,
                            code_buf.trim_end()
                        ));
                    }
                }
                TagEnd::List(_) => {
                    list_stack.pop();
                    if list_stack.is_empty() {
                        output.push('\n');
                    }
                }
                TagEnd::Item => {
                    if !output.ends_with('\n') {
                        output.push('\n');
                    }
                }
                TagEnd::Emphasis => {
                    output.push('_');
                }
                TagEnd::Strong => {
                    output.push('*');
                }
                TagEnd::Strikethrough => {
                    output.push(']');
                }
                TagEnd::Link => {
                    output.push(']');
                }
                TagEnd::Image => {}
                TagEnd::Table => {
                    output.push_str(")\n\n");
                }
                TagEnd::TableHead => {
                    _table_header = false;
                }
                TagEnd::TableRow => {}
                TagEnd::TableCell => {
                    _table_cell_count += 1;
                    output.push_str("],\n");
                }
                _ => {}
            },
            Event::Text(text) => {
                if in_code_block {
                    code_buf.push_str(&text);
                } else {
                    output.push_str(&escape_typst_markup(&text));
                }
            }
            Event::Code(code) => {
                output.push('`');
                output.push_str(&code);
                output.push('`');
            }
            Event::InlineMath(math) => {
                output.push('$');
                output.push_str(&math);
                output.push('$');
            }
            Event::DisplayMath(math) => {
                output.push_str("$ ");
                output.push_str(&math);
                output.push_str(" $\n");
            }
            Event::Html(html) => {
                output.push_str(&format!("/* HTML: {} */\n", html.trim()));
            }
            Event::SoftBreak => {
                output.push('\n');
            }
            Event::HardBreak => {
                output.push_str(" \\\n");
            }
            Event::Rule => {
                output.push_str("#line(length: 100%)\n\n");
            }
            Event::FootnoteReference(name) => {
                output.push_str(&format!("#footnote[{}]", name));
            }
            Event::TaskListMarker(checked) => {
                if checked {
                    output.push_str("[x] ");
                } else {
                    output.push_str("[ ] ");
                }
            }
            _ => {}
        }
    }

    // Restore citation placeholders
    output.replace('\x01', "@")
}

// ---------------------------------------------------------------------------
// Template wrapping
// ---------------------------------------------------------------------------

fn wrap_in_template(
    content: &str,
    bib_filename: Option<&str>,
    request: &PdfExportRequest,
) -> String {
    let template = request.template.as_deref().unwrap_or("clean");
    let font = escape_typst_string(request.font_family.as_deref().unwrap_or("STIX Two Text"));
    let font_size = request.font_size.unwrap_or(11.0);
    let page_size = request.page_size.as_deref().unwrap_or("a4");

    let page_setting = match page_size {
        "us-letter" => "\"us-letter\"",
        "a5" => "\"a5\"",
        _ => "\"a4\"",
    };
    let margin_setting = "(x: 2.5cm, y: 2.5cm)";

    let mut doc = String::new();

    match template {
        "academic" => {
            doc.push_str(&format!(
                r#"#set page(paper: {page_setting}, margin: {margin_setting})
#set text(font: "{font}", size: {font_size}pt)
#set par(justify: true, leading: 0.55em, first-line-indent: 1em)
#set heading(numbering: "1.1  ")
#show heading.where(level: 1): it => {{ v(1em); text(size: 1.3em, weight: "bold", it); v(0.5em) }}
#show heading.where(level: 2): it => {{ v(0.8em); text(size: 1.1em, weight: "bold", it); v(0.4em) }}

"#
            ));
        }
        "report" => {
            doc.push_str(&format!(
                r#"#set page(paper: {page_setting}, margin: {margin_setting}, numbering: "1")
#set text(font: "{font}", size: {font_size}pt)
#set par(justify: true, leading: 0.65em)
#set heading(numbering: "1.1  ")
#show heading.where(level: 1): it => {{ pagebreak(weak: true); v(2em); text(size: 1.5em, weight: "bold", it); v(1em) }}

"#
            ));
        }
        "letter" => {
            doc.push_str(&format!(
                r#"#set page(paper: {page_setting}, margin: (x: 2.5cm, top: 2.5cm, bottom: 2cm))
#set text(font: "{font}", size: {font_size}pt)
#set par(justify: false, leading: 0.65em)
#set heading(numbering: none)

"#
            ));
        }
        "compact" => {
            doc.push_str(&format!(
                r#"#set page(paper: {page_setting}, margin: (x: 1.5cm, y: 1.5cm), columns: 2)
#set text(font: "{font}", size: 9pt)
#set par(justify: true, leading: 0.5em)
#set heading(numbering: none)
#show heading.where(level: 1): it => {{ text(size: 1.2em, weight: "bold", it); v(0.3em) }}

"#
            ));
        }
        _ => {
            // "clean" -- the default
            doc.push_str(&format!(
                r#"#set page(paper: {page_setting}, margin: {margin_setting})
#set text(font: "{font}", size: {font_size}pt)
#set par(justify: true, leading: 0.65em)
#set heading(numbering: none)

"#
            ));
        }
    }

    doc.push_str("#set par(spacing: 1.8em)\n\n");

    if bib_filename.is_some() {
        let style = match request.bib_style.as_deref().unwrap_or("apa") {
            "chicago" => "chicago-author-date",
            "ieee" => "ieee",
            other => other,
        };
        doc.push_str(&format!(
            "#set bibliography(style: \"{}\")\n\n",
            escape_typst_string(style)
        ));
    }

    doc.push_str(content);

    if let Some(bib) = bib_filename {
        doc.push_str(&format!("\n\n#bibliography(\"{}\")\n", bib));
    }

    doc
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn export_pdf(request: PdfExportRequest) -> Result<String, String> {
    let typst_bin = find_typst().ok_or_else(|| {
        if cfg!(target_os = "macos") {
            "Typst binary not found. Place in src-tauri/binaries/ or install: brew install typst".to_string()
        } else if cfg!(target_os = "windows") {
            "Typst binary not found. Place in src-tauri/binaries/ or install: winget install Typst.Typst".to_string()
        } else {
            "Typst binary not found. Place in src-tauri/binaries/ or install from: https://github.com/typst/typst/releases".to_string()
        }
    })?;

    // Convert markdown to Typst
    let typst_content = markdown_to_typst(&request.markdown);

    // Check if document has citations
    let has_citations = request.markdown.contains("[@");

    // Write bib file if needed
    let output_path = std::path::PathBuf::from(&request.output_path);
    let work_dir = output_path.parent().unwrap_or(Path::new(".")).to_path_buf();

    let bib_filename = if has_citations {
        if let Some(ref bib_content) = request.bib_content {
            let has_entries = bib_content.lines().any(|l| l.trim_start().starts_with('@'));
            if has_entries {
                let bib_path = work_dir.join("_export_refs.bib");
                std::fs::write(&bib_path, bib_content)
                    .map_err(|e| format!("Failed to write .bib file: {}", e))?;
                Some("_export_refs.bib".to_string())
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };

    // Wrap in template
    let full_doc = wrap_in_template(&typst_content, bib_filename.as_deref(), &request);

    // Write .typ file
    let typ_path = output_path.with_extension("typ");
    std::fs::write(&typ_path, &full_doc)
        .map_err(|e| format!("Failed to write .typ file: {}", e))?;

    // Run typst compile
    let mut cmd = Command::new(&typst_bin);
    cmd.arg("compile");
    if let Some(font_dir) = find_font_dir() {
        cmd.args(["--font-path", &font_dir]);
    }
    cmd.args([
        &*typ_path.to_string_lossy(),
        &*output_path.to_string_lossy(),
    ]);
    cmd.current_dir(&work_dir);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run typst: {}", e))?;

    // Clean up temp files
    let _ = std::fs::remove_file(&typ_path);
    if bib_filename.is_some() {
        let _ = std::fs::remove_file(work_dir.join("_export_refs.bib"));
    }

    if output.status.success() {
        Ok(request.output_path)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("Typst compilation failed: {}", stderr))
    }
}
