//! Telling one process from another that later gets its number. A pid names whatever has that number now: a process
//! that isn't this one's child (a daemon it found, a browser it reattached to) is signalled only while its number and
//! the moment it started both still match what was recorded of it, so a number the system has given to someone else
//! never receives a signal meant for the process that had it.

/// When the process `pid` started, as the system keeps it. None for a process that isn't there, or where the system
/// can't say.
pub fn started(pid: u32) -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: proc_pidinfo writes at most `size` bytes into the zeroed struct it is given.
        let n = unsafe { libc::proc_pidinfo(i32::try_from(pid).ok()?, libc::PROC_PIDTBSDINFO, 0, &mut info as *mut _ as *mut libc::c_void, size) };
        (n == size).then(|| info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec)
    }
    #[cfg(target_os = "linux")]
    {
        // Field 22 of /proc/<pid>/stat, counted after the command's closing parenthesis (a command may hold spaces).
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        stat.rsplit_once(')')?.1.split_whitespace().nth(19)?.parse().ok()
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
        use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        // SAFETY: a handle opened for querying only, closed before returning; the times are plain data.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle == 0 {
                return None;
            }
            let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
            let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
            CloseHandle(handle);
            (ok != 0).then(|| (u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = pid;
        None
    }
}

/// When the process `pid` started, as a moment in time (where [`started`] gives the system's own count). None where the
/// system can't say.
pub fn started_at(pid: u32) -> Option<std::time::SystemTime> {
    #[cfg(target_os = "macos")]
    {
        started(pid).map(|us| std::time::UNIX_EPOCH + std::time::Duration::from_micros(us))
    }
    #[cfg(target_os = "linux")]
    {
        // Clock ticks since boot, and the boot's own moment from /proc/stat.
        let ticks = started(pid)?;
        let per_second = u64::try_from(unsafe { libc::sysconf(libc::_SC_CLK_TCK) }).ok().filter(|t| *t > 0)?;
        let boot: u64 = std::fs::read_to_string("/proc/stat").ok()?.lines().find_map(|l| l.strip_prefix("btime ")?.trim().parse().ok())?;
        Some(std::time::UNIX_EPOCH + std::time::Duration::from_secs(boot) + std::time::Duration::from_millis(ticks * 1000 / per_second))
    }
    #[cfg(windows)]
    {
        // 100 ns since 1601.
        let ticks = started(pid)?;
        let secs = (ticks / 10_000_000).checked_sub(11_644_473_600)?;
        Some(std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
    {
        let _ = pid;
        None
    }
}

/// Whether the system itself says the process `pid` holds a TCP socket listening on this machine's loopback address at
/// `port`: what a process answering on that port can't say for itself. On macOS the system's own `lsof` reads it from
/// the kernel; on Linux the listening socket's inode in `/proc/net/tcp*` is matched against the process's open files.
/// Where the system can't say, the answer is no.
pub fn listens_on_loopback(pid: u32, port: u16) -> bool {
    #[cfg(target_os = "macos")]
    {
        let said = std::process::Command::new("/usr/sbin/lsof")
            .args(["-nP", "-t", "-a", "-p", &pid.to_string(), &format!("-iTCP@127.0.0.1:{port}"), "-sTCP:LISTEN"])
            .env_clear()
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output();
        said.is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).lines().any(|l| l.trim() == pid.to_string()))
    }
    #[cfg(target_os = "linux")]
    {
        // Listening (state 0A) on 127.0.0.1 or ::1 (or 127.0.0.1 written as an IPv6 address) at `port`.
        let loopback = |addr: &str| matches!(addr, "0100007F" | "00000000000000000000000001000000" | "0000000000000000FFFF00000100007F");
        let mut inodes = Vec::new();
        for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
            let Ok(text) = std::fs::read_to_string(table) else { continue };
            for line in text.lines().skip(1) {
                let cols: Vec<&str> = line.split_whitespace().collect();
                let (Some(local), Some(state), Some(inode)) = (cols.get(1), cols.get(3), cols.get(9)) else { continue };
                let Some((addr, hex_port)) = local.split_once(':') else { continue };
                if *state == "0A" && loopback(addr) && u16::from_str_radix(hex_port, 16) == Ok(port) {
                    inodes.push(format!("socket:[{inode}]"));
                }
            }
        }
        let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { return false };
        fds.flatten().any(|fd| std::fs::read_link(fd.path()).is_ok_and(|t| inodes.iter().any(|i| t.as_os_str() == i.as_str())))
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (pid, port);
        false
    }
}

/// Whether a process numbered `pid` is running now: the one reader of it, for the reattach, the profile sweep and the
/// reaper of launched browsers alike. On Windows a process is running while its exit code is STILL_ACTIVE (a handle
/// can still be opened for one that has exited while its handles are held), and one the system won't open for this
/// user is there. Two copies used to answer for Windows: one said every process was alive (#847 fixed it), the other
/// said every one was dead, so the reaper removed the records of launchers still running.
pub fn alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        i32::try_from(pid).is_ok_and(|pid| pid > 0 && unsafe { libc::kill(pid, 0) } == 0)
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        if pid == 0 {
            return false;
        }
        // SAFETY: a handle opened for querying only and closed before returning; the exit code is plain data.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle == 0 {
                return GetLastError() == ERROR_ACCESS_DENIED;
            }
            let mut code = 0u32;
            let read = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            read != 0 && code == STILL_ACTIVE as u32
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        false
    }
}

/// Whether the live process `pid` is still the one that started at `when`: a record that says nothing proves nothing.
pub fn is_still(pid: u32, when: Option<u64>) -> bool {
    when.is_some() && started(pid) == when
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Who listens on a port is the system's word: this process, holding a loopback listener, is the one; another live
    /// process is not; and a process has started by now.
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn the_system_says_which_process_listens_on_a_port() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(listens_on_loopback(std::process::id(), port));
        let mut other = std::process::Command::new("sleep").arg("5").spawn().unwrap();
        assert!(!listens_on_loopback(other.id(), port), "a live process that holds no such socket");
        let _ = other.kill();
        let _ = other.wait();
        drop(listener);
        assert!(!listens_on_loopback(std::process::id(), port), "a socket closed is no listener");
        assert!(started_at(std::process::id()).is_some_and(|t| t <= std::time::SystemTime::now()));
    }

    /// A process is told from a later one by when it started: this process is itself, and a process that has gone is
    /// nobody, whatever comes to have its number.
    #[test]
    fn a_process_is_known_by_its_number_and_its_start() {
        let me = std::process::id();
        let mine = started(me);
        assert!(mine.is_some(), "the system says when this process started");
        assert!(is_still(me, mine));
        assert!(!is_still(me, mine.map(|t| t + 1)), "another start is another process");
        assert!(!is_still(me, None), "no record proves nothing");
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let pid = child.id();
        let theirs = started(pid);
        child.wait().unwrap();
        assert!(!is_still(pid, theirs), "a process that has gone is nobody");
    }

    /// A running process is alive, and one that has exited and been waited on is not, on every system.
    #[test]
    fn a_process_is_alive_until_it_has_gone() {
        assert!(alive(std::process::id()), "this process");
        #[cfg(windows)]
        let mut child = std::process::Command::new("ping").args(["-n", "30", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        #[cfg(not(windows))]
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        assert!(alive(pid), "a child still running");
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!alive(pid), "a child killed and waited on");
        assert!(!alive(0), "no process is number 0");
    }
}
