// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

/// Disable core dumps for this process.
///
/// The diary key lives in memory while the vault is unlocked. A core dump
/// written after a crash would copy that memory to disk in the clear, where it
/// outlives the process and may be picked up by crash reporters. Setting
/// `RLIMIT_CORE` to zero is the cheapest way to close that hole; it costs
/// nothing at runtime and needs no privileges (a process may always lower its
/// own limit).
///
/// Failure is ignored on purpose: a system that refuses the call (or a platform
/// without `setrlimit`) should still start the app.
#[cfg(unix)]
fn disable_core_dumps() {
    // SAFETY: `setrlimit` is called with a fully initialised `rlimit` that
    // points at no borrowed memory, and the call has no other preconditions.
    unsafe {
        let limit = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        let _ = libc::setrlimit(libc::RLIMIT_CORE, &limit);
    }
}

#[cfg(not(unix))]
fn disable_core_dumps() {}

fn main() {
    disable_core_dumps();
    fly_diary_lib::run()
}
