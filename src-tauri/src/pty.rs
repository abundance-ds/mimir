use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::Emitter;

/// Find a safe split point in a byte buffer to avoid cutting multi-byte UTF-8 sequences.
/// Returns the index up to which the buffer is valid UTF-8 (remainder is leftover).
fn utf8_safe_split(buf: &[u8]) -> usize {
    let len = buf.len();
    if len == 0 {
        return 0;
    }

    // Scan backwards up to 3 bytes from end to detect incomplete UTF-8 sequence
    let check_from = if len >= 3 { len - 3 } else { 0 };

    for i in (check_from..len).rev() {
        let b = buf[i];
        if b < 0x80 {
            // ASCII byte — everything up to and including this is safe
            return len;
        }
        if b >= 0xC0 {
            // This is a start byte. Determine expected sequence length.
            let seq_len = if b >= 0xF0 {
                4
            } else if b >= 0xE0 {
                3
            } else {
                2
            };
            let available = len - i;
            if available < seq_len {
                // Incomplete sequence — split before this start byte
                return i;
            } else {
                // Complete sequence — entire buffer is safe
                return len;
            }
        }
        // else continuation byte (0x80..0xBF), keep scanning backwards
    }

    // All bytes in the tail are continuation bytes without a start byte — split at check_from
    check_from
}

pub struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: Mutex<u32>,
}

#[tauri::command]
pub fn pty_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let pty_system = native_pty_system();

    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Failed to open PTY: {}", e))?;

    let mut cmd = CommandBuilder::new(&command);
    cmd.args(args);

    if let Some(ref dir) = cwd {
        cmd.cwd(dir);
    }

    cmd.env("TERM", "xterm-256color");
    for (key, value) in &env {
        cmd.env(key, value);
    }

    let _child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn command: {}", e))?;

    // Drop slave immediately — we communicate via master
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to clone reader: {}", e))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to take writer: {}", e))?;

    // Assign ID
    let id = {
        let mut next = state.next_id.lock().unwrap();
        let id = *next;
        *next = id + 1;
        id
    };

    // Store session
    {
        let mut sessions = state.sessions.lock().unwrap();
        sessions.insert(
            id,
            PtySession {
                writer,
                master: pair.master,
            },
        );
    }

    // Spawn reader thread
    let app_handle = app.clone();
    let pty_id = id;
    std::thread::spawn(move || {
        pty_reader_loop(reader, app_handle, pty_id);
    });

    Ok(id)
}

fn pty_reader_loop(mut reader: Box<dyn Read + Send>, app: tauri::AppHandle, id: u32) {
    let mut buf = [0u8; 4096];
    let mut leftover: Vec<u8> = Vec::new();

    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break, // EOF
            Ok(n) => n,
            Err(_) => break,
        };

        // Prepend leftover to current read
        let mut combined = Vec::with_capacity(leftover.len() + n);
        combined.extend_from_slice(&leftover);
        combined.extend_from_slice(&buf[..n]);
        leftover.clear();

        // Find safe UTF-8 boundary
        let split_at = utf8_safe_split(&combined);

        // Store remainder as leftover
        if split_at < combined.len() {
            leftover.extend_from_slice(&combined[split_at..]);
        }

        // Emit safe portion
        if split_at > 0 {
            let text = String::from_utf8_lossy(&combined[..split_at]).to_string();
            let event_name = format!("pty-output-{}", id);
            let _ = app.emit(&event_name, text);
        }
    }

    // Flush any remaining leftover bytes
    if !leftover.is_empty() {
        let text = String::from_utf8_lossy(&leftover).to_string();
        let event_name = format!("pty-output-{}", id);
        let _ = app.emit(&event_name, text);
    }

    // Emit exit event
    let exit_event = format!("pty-exit-{}", id);
    let _ = app.emit(&exit_event, ());
}

#[tauri::command]
pub fn pty_write(state: tauri::State<'_, PtyState>, id: u32, data: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("PTY session {} not found", id))?;

    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("Write failed: {}", e))?;

    session
        .writer
        .flush()
        .map_err(|e| format!("Flush failed: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    // Zero-dimension guard for v-show hidden terminals
    if cols == 0 || rows == 0 {
        return Ok(());
    }

    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("PTY session {} not found", id))?;

    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("Resize failed: {}", e))?;

    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: u32) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    // Remove session — Drop closes the PTY. Idempotent: Ok even if not found.
    sessions.remove(&id);
    Ok(())
}
