//! The terminal this process was started from, read directly: `/dev/tty` on macOS and Linux, the console (`CONIN$`,
//! `CONOUT$`) on Windows. Never stdin, so what the owner types there is never something a script pipes in, and a
//! process with no terminal (a service, an agent's tool) reads nothing.
//!
//! Before it asks, it checks the terminal is this process's own and that this process is in its foreground (so a
//! program left running in the background of the owner's terminal can't put the prompt up), and it throws away
//! whatever was typed ahead of the prompt (keys pushed into the terminal before it asked). What no check here can
//! tell: a program running as the owner that starts this inside a terminal of its own making (a pseudo-terminal), and
//! so reads the prompt and types the answer. A terminal answer is the owner's only as far as the terminal is; the
//! dialog, or agents run as another OS user (`agent_user`), is what keeps such a program out.

use zeroize::Zeroizing;

/// Shows `prompt` on the terminal, then reads one line from it with echo off: a passphrase.
pub fn read_secret(prompt: &str) -> Result<Zeroizing<String>, String> {
    #[cfg(test)]
    {
        say(prompt)?;
        test::next().ok_or_else(|| no_terminal("a test has no terminal"))
    }
    #[cfg(not(test))]
    {
        imp::read_secret(prompt).map_err(|e| no_terminal(&e.to_string()))
    }
}

/// Shows `prompt` on the terminal, then reads one line from it, echoed as it is typed: a yes or a no.
pub fn read_line(prompt: &str) -> Result<String, String> {
    #[cfg(test)]
    {
        say(prompt)?;
        test::next().map(|l| l.to_string()).ok_or_else(|| no_terminal("a test has no terminal"))
    }
    #[cfg(not(test))]
    {
        imp::read_line(prompt).map_err(|e| no_terminal(&e.to_string()))
    }
}

/// Writes `text` on the terminal.
pub fn say(text: &str) -> Result<(), String> {
    #[cfg(test)]
    {
        test::SAID.with(|s| s.borrow_mut().push(text.to_string()));
        Ok(())
    }
    #[cfg(not(test))]
    {
        imp::say(text).map_err(|e| no_terminal(&e.to_string()))
    }
}

fn no_terminal(why: &str) -> String {
    format!("this needs a terminal to type the owner passphrase on, and there is none ({why})")
}

#[cfg(test)]
pub mod test {
    use std::cell::RefCell;
    use zeroize::Zeroizing;

    thread_local! {
        static LINES: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
        pub(super) static SAID: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    }

    /// What the owner types on this thread's terminal, line by line; with none left, there is no terminal.
    pub fn type_in(lines: &[&str]) {
        LINES.with(|l| *l.borrow_mut() = lines.iter().rev().map(|s| s.to_string()).collect());
    }

    /// What was written on this thread's terminal so far.
    pub fn said() -> Vec<String> {
        SAID.with(|s| s.borrow().clone())
    }

    pub(super) fn next() -> Option<Zeroizing<String>> {
        LINES.with(|l| l.borrow_mut().pop()).map(Zeroizing::new)
    }
}

/// Whether the terminal open at `fd` is this process's controlling terminal, with this process in its foreground;
/// then whatever waits unread on it, typed before the question, is thrown away.
#[cfg(unix)]
pub(crate) fn ours(fd: std::os::fd::RawFd) -> std::io::Result<()> {
    // SAFETY: plain calls on a descriptor the caller holds open; none writes through a pointer.
    unsafe {
        let session = libc::tcgetsid(fd);
        if session < 0 {
            return Err(std::io::Error::other(format!("it isn't this process's own terminal ({})", std::io::Error::last_os_error())));
        }
        if session != libc::getsid(0) {
            return Err(std::io::Error::other("it is another session's terminal"));
        }
        if libc::tcgetpgrp(fd) != libc::getpgrp() {
            return Err(std::io::Error::other("this program isn't in the terminal's foreground: run it there, not in the background"));
        }
        libc::tcflush(fd, libc::TCIFLUSH);
    }
    Ok(())
}

#[cfg(all(unix, not(test)))]
mod imp {
    use std::io::{BufRead, Write};
    use std::os::fd::AsRawFd;
    use zeroize::Zeroizing;

    fn open() -> std::io::Result<std::fs::File> {
        std::fs::OpenOptions::new().read(true).write(true).open("/dev/tty")
    }

    /// The terminal, checked (`ours`) before it is asked anything.
    fn asking() -> std::io::Result<std::fs::File> {
        let t = open()?;
        super::ours(t.as_raw_fd())?;
        Ok(t)
    }

    pub fn say(text: &str) -> std::io::Result<()> {
        let mut t = open()?;
        t.write_all(text.as_bytes())?;
        t.flush()
    }

    pub fn read_line(prompt: &str) -> std::io::Result<String> {
        let mut t = asking()?;
        t.write_all(prompt.as_bytes())?;
        t.flush()?;
        let mut line = String::new();
        std::io::BufReader::new(&t).read_line(&mut line)?;
        Ok(line.trim_end_matches(['\n', '\r']).to_string())
    }

    pub fn read_secret(prompt: &str) -> std::io::Result<Zeroizing<String>> {
        let mut t = asking()?;
        let fd = t.as_raw_fd();
        // SAFETY: `fd` is the open terminal; termios is plain data, filled by tcgetattr before it is read.
        let mut was: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(fd, &mut was) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut quiet = was;
        quiet.c_lflag &= !libc::ECHO;
        quiet.c_lflag |= libc::ICANON;
        t.write_all(prompt.as_bytes())?;
        t.flush()?;
        // SAFETY: as above; the old settings are put back whatever the read does.
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &quiet) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut line = Zeroizing::new(String::new());
        let read = std::io::BufReader::new(&t).read_line(&mut line);
        unsafe { libc::tcsetattr(fd, libc::TCSANOW, &was) };
        let _ = t.write_all(b"\n");
        read?;
        let end = line.trim_end_matches(['\n', '\r']).len();
        line.truncate(end);
        Ok(line)
    }
}

#[cfg(all(windows, not(test)))]
mod imp {
    use std::io::{BufRead, Write};
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Console::{FlushConsoleInputBuffer, GetConsoleMode, SetConsoleMode, ENABLE_ECHO_INPUT};
    use zeroize::Zeroizing;

    pub fn say(text: &str) -> std::io::Result<()> {
        let mut out = std::fs::OpenOptions::new().write(true).open("CONOUT$")?;
        out.write_all(text.as_bytes())?;
        out.flush()
    }

    /// The console's input, with whatever was typed ahead of the question thrown away.
    fn asking() -> std::io::Result<std::fs::File> {
        let input = std::fs::OpenOptions::new().read(true).write(true).open("CONIN$")?;
        // SAFETY: the handle is the open console input.
        if unsafe { FlushConsoleInputBuffer(input.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(input)
    }

    pub fn read_line(prompt: &str) -> std::io::Result<String> {
        let input = asking()?;
        say(prompt)?;
        let mut line = String::new();
        std::io::BufReader::new(&input).read_line(&mut line)?;
        Ok(line.trim_end_matches(['\n', '\r']).to_string())
    }

    pub fn read_secret(prompt: &str) -> std::io::Result<Zeroizing<String>> {
        let input = asking()?;
        let handle = input.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
        let mut was = 0u32;
        // SAFETY: `handle` is the open console input; the old mode is put back whatever the read does.
        if unsafe { GetConsoleMode(handle, &mut was) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        say(prompt)?;
        if unsafe { SetConsoleMode(handle, was & !ENABLE_ECHO_INPUT) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut line = Zeroizing::new(String::new());
        let read = std::io::BufReader::new(&input).read_line(&mut line);
        unsafe { SetConsoleMode(handle, was) };
        let _ = say("\r\n");
        read?;
        let end = line.trim_end_matches(['\n', '\r']).len();
        line.truncate(end);
        Ok(line)
    }
}

#[cfg(all(test, unix))]
mod checks {
    /// External security review round 3, 2026-11-04 (the terminal prompt can be faked). The prompt is asked only on
    /// this process's own terminal, with this process in its foreground: one it merely holds open (a pseudo-terminal
    /// another program made and handed it) is refused.
    #[test]
    fn a_terminal_that_isnt_this_processs_own_is_refused() {
        // SAFETY: a fresh pseudo-terminal pair, opened and closed here; ptsname is read before anything else opens one.
        unsafe {
            let master = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY);
            assert!(master >= 0);
            assert_eq!(libc::grantpt(master), 0);
            assert_eq!(libc::unlockpt(master), 0);
            let name = std::ffi::CStr::from_ptr(libc::ptsname(master)).to_owned();
            let other = libc::open(name.as_ptr(), libc::O_RDWR | libc::O_NOCTTY);
            assert!(other >= 0);
            assert!(super::ours(other).is_err(), "a terminal this process doesn't own answers nothing");
            libc::close(other);
            libc::close(master);
        }
    }
}
