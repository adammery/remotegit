//! One long-lived `ssh <host> sh` process per server. Each command is written
//! to the remote shell's stdin and its output is framed by unique markers, so
//! polling `git status` costs a round trip instead of a new SSH handshake.
//!
//! Only std is used here so the module can be tested without Tauri.

use std::io::{Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(25);
/// stderr's marker is printed right after stdout's, so it never takes long.
const STDERR_GRACE: Duration = Duration::from_secs(5);
/// Scripts up to this size are passed inline as a `sh -c` argument.
const INLINE_LIMIT: usize = 64 * 1024;

pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}

pub struct Session {
    child: Child,
    stdin: ChildStdin,
    out: Stream,
    err: Stream,
    nonce: String,
    seq: u64,
    dead: bool,
}

/// Builds the `ssh` invocation. The system client is used on purpose: it
/// picks up the user's keys, agent, `~/.ssh/config` and known_hosts.
pub fn ssh_command(
    host: &str,
    user: Option<&str>,
    port: Option<u16>,
    identity_file: Option<&str>,
    forward_agent: bool,
) -> Result<Command, String> {
    let host = host.trim();
    if host.is_empty() || host.starts_with('-') || host.contains(char::is_whitespace) {
        return Err(format!("Invalid host: {host:?}"));
    }
    let user = user.map(str::trim).filter(|u| !u.is_empty());
    if let Some(u) = user {
        if u.starts_with('-') || u.contains(char::is_whitespace) || u.contains('@') {
            return Err(format!("Invalid user: {u:?}"));
        }
    }

    let mut cmd = Command::new("ssh");
    cmd.args([
        "-T",
        "-o", "BatchMode=yes",
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ConnectTimeout=15",
        "-o", "ServerAliveInterval=20",
        "-o", "ServerAliveCountMax=3",
    ]);
    if let Some(p) = port {
        cmd.arg("-p").arg(p.to_string());
    }
    if let Some(key) = identity_file.map(str::trim).filter(|k| !k.is_empty()) {
        cmd.arg("-i").arg(expand_home(key));
    }
    if forward_agent {
        cmd.arg("-A");
    }
    match user {
        Some(u) => cmd.arg(format!("{u}@{host}")),
        None => cmd.arg(host),
    };
    cmd.arg("sh");
    Ok(cmd)
}

fn expand_home(path: &str) -> String {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"));
    match (path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")), home) {
        (Some(rest), Ok(home)) => format!("{home}/{rest}"),
        _ => path.to_string(),
    }
}

/// POSIX single-quote escaping.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

impl Session {
    /// Spawns `cmd` (normally from [`ssh_command`]) and waits until the
    /// remote shell answers, so auth errors surface here and not later.
    pub fn spawn(mut cmd: Command) -> Result<Session, String> {
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "The `ssh` command was not found. Install the OpenSSH client.".to_string()
            } else {
                format!("Failed to start ssh: {e}")
            }
        })?;
        let stdin = child.stdin.take().expect("piped stdin");
        let out = Stream::spawn(child.stdout.take().expect("piped stdout"));
        let err = Stream::spawn(child.stderr.take().expect("piped stderr"));
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let mut session = Session {
            child,
            stdin,
            out,
            err,
            nonce: format!("{:x}{:x}", nanos, std::process::id()),
            seq: 0,
            dead: false,
        };
        // Shell startup files may print noise before our first marker; it is
        // swallowed by this handshake.
        session.exec("true", HANDSHAKE_TIMEOUT)?;
        Ok(session)
    }

    pub fn is_alive(&mut self) -> bool {
        !self.dead && matches!(self.child.try_wait(), Ok(None))
    }

    /// Runs `script` in a fresh `sh -c` on the remote side. Its stdin is
    /// /dev/null so it cannot consume the command stream.
    pub fn exec(&mut self, script: &str, timeout: Duration) -> Result<ExecOutput, String> {
        if self.dead {
            return Err("Connection closed".into());
        }
        self.seq += 1;
        let id = format!("rg{}x{}", self.nonce, self.seq);
        let markers = format!("printf '\\036%s %d\\036\\n' {id} \"$?\"; printf '\\036%s\\036\\n' {id} >&2\n");
        let line = if script.len() <= INLINE_LIMIT {
            format!("sh -c {} </dev/null; {markers}", shell_quote(script))
        } else {
            // One exec argument can't exceed ~128 KiB on Linux, so big scripts
            // (patches, huge path lists) go to a temp file through the
            // shell's builtin printf, then run from there.
            let var = format!("{id}f");
            let mut s = format!("{var}=$(mktemp)\n");
            for chunk in chunks(script, INLINE_LIMIT) {
                s += &format!("printf '%s' {} >> \"${var}\"\n", shell_quote(chunk));
            }
            s += &format!("sh \"${var}\" </dev/null; set -- $?; rm -f \"${var}\"; (exit $1); {markers}");
            s
        };
        let result = self.run(&line, &id, timeout);
        if result.is_err() {
            // Session state is unknown after a failure; never reuse it.
            self.dead = true;
            let _ = self.child.kill();
        }
        result
    }

    fn run(&mut self, line: &str, id: &str, timeout: Duration) -> Result<ExecOutput, String> {
        let deadline = Instant::now() + timeout;
        if self.stdin.write_all(line.as_bytes()).and_then(|_| self.stdin.flush()).is_err() {
            return Err(self.closed_message());
        }

        let stdout = match self.out.read_until(format!("\x1e{id} ").as_bytes(), deadline) {
            Ok(bytes) => bytes,
            Err(ReadErr::Timeout) => return Err(format!("Timed out after {}s", timeout.as_secs())),
            Err(ReadErr::Eof) => return Err(self.closed_message()),
        };
        let code = match self.out.read_until(b"\x1e\n", deadline) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).trim().parse().unwrap_or(-1),
            Err(_) => return Err(self.closed_message()),
        };
        let stderr = self
            .err
            .read_until(format!("\x1e{id}\x1e\n").as_bytes(), Instant::now() + STDERR_GRACE)
            .map_err(|_| self.closed_message())?;

        Ok(ExecOutput {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            code,
        })
    }

    /// Best explanation for a dead connection: whatever ssh printed last.
    fn closed_message(&mut self) -> String {
        let deadline = Instant::now() + Duration::from_millis(1500);
        while !self.err.eof && Instant::now() < deadline {
            self.err.fill(deadline);
        }
        let text = String::from_utf8_lossy(&self.err.buf).trim().to_string();
        self.err.buf.clear();
        if text.is_empty() {
            "SSH connection closed".into()
        } else {
            text
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

enum ReadErr {
    Timeout,
    Eof,
}

/// A pipe drained by a background thread, so reads can time out.
struct Stream {
    rx: Receiver<Vec<u8>>,
    buf: Vec<u8>,
    eof: bool,
}

impl Stream {
    fn spawn<R: Read + Send + 'static>(mut reader: R) -> Stream {
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut chunk = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if tx.send(chunk[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        Stream { rx, buf: Vec::new(), eof: false }
    }

    /// Waits for one more chunk (or EOF) until `deadline`.
    fn fill(&mut self, deadline: Instant) -> bool {
        let wait = deadline.saturating_duration_since(Instant::now());
        match self.rx.recv_timeout(wait) {
            Ok(chunk) => {
                self.buf.extend_from_slice(&chunk);
                true
            }
            Err(RecvTimeoutError::Disconnected) => {
                self.eof = true;
                false
            }
            Err(RecvTimeoutError::Timeout) => false,
        }
    }

    /// Returns everything before `marker` and consumes the marker itself.
    fn read_until(&mut self, marker: &[u8], deadline: Instant) -> Result<Vec<u8>, ReadErr> {
        let mut from = 0;
        loop {
            if let Some(pos) = find(&self.buf[from..], marker) {
                let end = from + pos;
                let rest = self.buf.split_off(end + marker.len());
                let mut head = std::mem::replace(&mut self.buf, rest);
                head.truncate(end);
                return Ok(head);
            }
            // The marker may straddle the chunk boundary.
            from = self.buf.len().saturating_sub(marker.len() - 1);
            if self.eof {
                return Err(ReadErr::Eof);
            }
            if !self.fill(deadline) && !self.eof {
                return Err(ReadErr::Timeout);
            }
        }
    }
}

/// Splits on char boundaries into pieces of at most `max` bytes.
fn chunks(s: &str, max: usize) -> Vec<&str> {
    let mut out = Vec::new();
    let mut rest = s;
    while !rest.is_empty() {
        let mut end = rest.len().min(max);
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        let (head, tail) = rest.split_at(end);
        out.push(head);
        rest = tail;
    }
    out
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local() -> Session {
        Session::spawn(Command::new("sh")).expect("local sh session")
    }

    const T: Duration = Duration::from_secs(10);

    #[test]
    fn stdout_stderr_and_exit_code() {
        let mut s = local();
        let r = s.exec("echo hello; echo oops >&2; exit 3", T).unwrap();
        assert_eq!(r.stdout, "hello\n");
        assert_eq!(r.stderr, "oops\n");
        assert_eq!(r.code, 3);
    }

    #[test]
    fn output_without_trailing_newline_and_quotes() {
        let mut s = local();
        let r = s.exec(r#"printf '%s' "it's \"quoted\" $HOME""#, T).unwrap();
        assert!(r.stdout.starts_with("it's \"quoted\" /"), "{:?}", r.stdout);
        assert!(!r.stdout.ends_with('\n'));
        assert_eq!(r.code, 0);
    }

    #[test]
    fn many_sequential_commands_reuse_session() {
        let mut s = local();
        for i in 0..200 {
            let r = s.exec(&format!("echo {i}"), T).unwrap();
            assert_eq!(r.stdout, format!("{i}\n"));
        }
    }

    #[test]
    fn large_output() {
        let mut s = local();
        let r = s.exec("head -c 3000000 /dev/zero | tr '\\0' a", T).unwrap();
        assert_eq!(r.stdout.len(), 3_000_000);
        assert!(r.stdout.bytes().all(|b| b == b'a'));
    }

    #[test]
    fn scripts_larger_than_the_argument_limit() {
        let mut s = local();
        // 300 KB with multi-byte chars and quotes around chunk boundaries.
        let payload = "ž'a\"$".repeat(50_000);
        let script = format!("printf '%s' {} | wc -c; exit 4", shell_quote(&payload));
        let r = s.exec(&script, T).unwrap();
        assert_eq!(r.stdout.trim(), payload.len().to_string());
        assert_eq!(r.code, 4);
        assert_eq!(s.exec("echo after", T).unwrap().stdout, "after\n");
    }

    #[test]
    fn command_reading_stdin_does_not_eat_stream() {
        let mut s = local();
        let r = s.exec("cat; echo done", T).unwrap();
        assert_eq!(r.stdout, "done\n");
        assert_eq!(s.exec("echo next", T).unwrap().stdout, "next\n");
    }

    #[test]
    fn syntax_error_is_contained() {
        let mut s = local();
        let r = s.exec("echo 'unterminated", T).unwrap();
        assert_ne!(r.code, 0);
        assert_eq!(s.exec("echo fine", T).unwrap().stdout, "fine\n");
    }

    #[test]
    fn multiline_script_and_cd_is_local_to_command() {
        let mut s = local();
        let r = s.exec("cd /\nif true; then\n  pwd\nfi", T).unwrap();
        assert_eq!(r.stdout, "/\n");
        let r = s.exec("pwd", T).unwrap();
        assert_ne!(r.stdout, "/\n");
    }

    #[test]
    fn timeout_kills_session() {
        let mut s = local();
        let err = s.exec("sleep 5", Duration::from_millis(300)).err().unwrap();
        assert!(err.contains("Timed out"), "{err}");
        assert!(!s.is_alive());
        assert!(s.exec("echo x", T).is_err());
    }

    #[test]
    fn remote_exit_reports_stderr() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo 'Permission denied (publickey).' >&2; exit 255"]);
        let err = Session::spawn(cmd).err().unwrap();
        assert_eq!(err, "Permission denied (publickey).");
    }

    #[test]
    fn startup_noise_is_swallowed() {
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "echo 'Welcome banner'; exec sh"]);
        let mut s = Session::spawn(cmd).unwrap();
        assert_eq!(s.exec("echo clean", T).unwrap().stdout, "clean\n");
    }

    #[test]
    fn ssh_command_args() {
        let c = ssh_command("example.com", Some("dev"), Some(2222), None, true).unwrap();
        let args: Vec<_> = c.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
        assert!(args.windows(2).any(|w| w == ["-p", "2222"]));
        assert!(args.contains(&"-A".to_string()));
        assert_eq!(&args[args.len() - 2..], ["dev@example.com", "sh"]);
        assert!(ssh_command("-oProxyCommand=x", None, None, None, false).is_err());
        assert!(ssh_command("host", Some("a b"), None, None, false).is_err());
    }
}
