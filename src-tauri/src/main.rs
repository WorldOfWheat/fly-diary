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

/// Block same-user processes from reading this process's memory.
///
/// `RLIMIT_CORE = 0` stops a crash from writing the key to disk; this closes
/// the other common hole on Linux: another process running as the same user
/// attaching with `ptrace` or opening `/proc/<pid>/mem`. The side effect is
/// that debuggers and profilers can no longer attach, which is acceptable for
/// a diary app (and can be changed locally while developing).
#[cfg(any(target_os = "linux", target_os = "android"))]
fn block_same_user_memory_access() {
    // SAFETY: `prctl` is variadic; `PR_SET_DUMPABLE` reads one integer argument
    // and ignores the rest. Passing zero is always valid.
    unsafe {
        let _ = libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0);
    }
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
fn block_same_user_memory_access() {}

fn main() {
    disable_core_dumps();
    block_same_user_memory_access();
    fly_diary_lib::run()
}
