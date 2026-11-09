//! Locked memory for the long-lived diary key.
//!
//! `Zeroizing` wipes the key when the session ends, but while the vault is
//! unlocked the bytes can still be written to swap or included in a memory
//! dump. This module keeps the session key on a dedicated, page-aligned
//! mapping that is:
//!
//! - locked into RAM (best effort), so it is not swapped out;
//! - excluded from dumps on Linux (`MADV_DONTDUMP`);
//! - wiped on fork on Linux (`MADV_WIPEONFORK`);
//! - zeroized, unlocked and unmapped on drop.
//!
//! Locking can fail (a low `RLIMIT_MEMLOCK`, a sandbox, a platform that does
//! not allow it). That must never prevent unlocking the diary, so every step is
//! best effort and falls back to ordinary memory.

/// Length of the diary key.
const KEY_LEN: usize = 32;

/// A 32-byte secret stored in page-aligned memory where the platform allows it.
pub struct LockedKey {
    inner: imp::Inner,
}

impl LockedKey {
    /// Copy `key` into protected memory. Falls back to pinned-free heap memory
    /// if the platform cannot provide a mapping.
    pub fn new(key: &[u8; KEY_LEN]) -> Self {
        Self {
            inner: imp::Inner::new(key),
        }
    }

    /// Borrow the key. The reference is only valid while `self` is alive.
    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        self.inner.as_bytes()
    }
}

#[cfg(unix)]
mod imp {
    use super::KEY_LEN;
    use zeroize::Zeroize;

    #[cfg(any(target_os = "linux", target_os = "android"))]
    const MAP_ANON_FLAG: libc::c_int = libc::MAP_ANONYMOUS;
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    const MAP_ANON_FLAG: libc::c_int = libc::MAP_ANON;

    pub struct Inner {
        ptr: *mut u8,
        len: usize,
        locked: bool,
        fallback: Option<Box<[u8; KEY_LEN]>>,
    }

    // SAFETY: the mapping is owned by this value, never mutated through a
    // shared reference, and is safe to move between threads. The key is only
    // accessed while the session mutex is held.
    unsafe impl Send for Inner {}

    impl Inner {
        pub fn new(key: &[u8; KEY_LEN]) -> Self {
            if let Some((ptr, len, locked)) = map_page() {
                // SAFETY: `map_page` returned a writable mapping of at least
                // `KEY_LEN` bytes, and `key` is a valid 32-byte reference.
                unsafe {
                    std::ptr::copy_nonoverlapping(key.as_ptr(), ptr, KEY_LEN);
                }
                return Self {
                    ptr,
                    len,
                    locked,
                    fallback: None,
                };
            }

            Self {
                ptr: std::ptr::null_mut(),
                len: 0,
                locked: false,
                fallback: Some(Box::new(*key)),
            }
        }

        pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
            match &self.fallback {
                Some(fallback) => fallback,
                // SAFETY: `ptr` is non-null and points at a mapping of at least
                // `KEY_LEN` bytes for the lifetime of `self`.
                None => unsafe { &*(self.ptr as *const [u8; KEY_LEN]) },
            }
        }
    }

    impl Drop for Inner {
        fn drop(&mut self) {
            if !self.ptr.is_null() {
                // SAFETY: `ptr` and `len` describe the mapping created in
                // `new`, and no other reference to it outlives `self`.
                unsafe {
                    let bytes = std::slice::from_raw_parts_mut(self.ptr, KEY_LEN);
                    bytes.zeroize();
                    if self.locked {
                        libc::munlock(self.ptr.cast(), self.len);
                    }
                    libc::munmap(self.ptr.cast(), self.len);
                }
            }
            if let Some(fallback) = self.fallback.as_mut() {
                fallback.zeroize();
            }
        }
    }

    /// Allocate one page, lock it if possible, and ask the kernel to keep it
    /// out of dumps/forks where those options exist.
    fn map_page() -> Option<(*mut u8, usize, bool)> {
        // SAFETY: `sysconf` has no preconditions and does not touch memory.
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        let len = if page > 0 { page as usize } else { 4096 };

        // SAFETY: `mmap` is called with a null hint, a length of one page, and
        // anonymous private flags. The result is checked against `MAP_FAILED`.
        let ptr = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_PRIVATE | MAP_ANON_FLAG,
                -1,
                0,
            )
        };
        if ptr == libc::MAP_FAILED {
            return None;
        }

        // SAFETY: `ptr`/`len` describe a valid writable mapping.
        let locked = unsafe { libc::mlock(ptr, len) } == 0;

        #[cfg(target_os = "linux")]
        {
            // SAFETY: same mapping; failure is harmless and only means the
            // kernel does not support (or does not need) the advice.
            unsafe {
                libc::madvise(ptr, len, libc::MADV_DONTDUMP);
                libc::madvise(ptr, len, libc::MADV_WIPEONFORK);
            }
        }

        Some((ptr.cast::<u8>(), len, locked))
    }
}

#[cfg(windows)]
mod imp {
    use super::KEY_LEN;
    use std::ffi::c_void;
    use zeroize::Zeroize;

    const PAGE_SIZE: usize = 4096;
    const MEM_COMMIT: u32 = 0x0000_1000;
    const MEM_RESERVE: u32 = 0x0000_2000;
    const MEM_RELEASE: u32 = 0x0000_8000;
    const PAGE_READWRITE: u32 = 0x04;

    #[link(name = "kernel32")]
    extern "system" {
        fn VirtualAlloc(
            address: *mut c_void,
            size: usize,
            allocation_type: u32,
            protect: u32,
        ) -> *mut c_void;
        fn VirtualLock(address: *mut c_void, size: usize) -> i32;
        fn VirtualUnlock(address: *mut c_void, size: usize) -> i32;
        fn VirtualFree(address: *mut c_void, size: usize, free_type: u32) -> i32;
    }

    pub struct Inner {
        ptr: *mut u8,
        locked: bool,
        fallback: Option<Box<[u8; KEY_LEN]>>,
    }

    // SAFETY: the allocation is owned by this value and is never mutated
    // through a shared reference.
    unsafe impl Send for Inner {}

    impl Inner {
        pub fn new(key: &[u8; KEY_LEN]) -> Self {
            // SAFETY: null address asks the OS to choose; the size is one page
            // and the result is checked for null.
            let ptr = unsafe {
                VirtualAlloc(
                    std::ptr::null_mut(),
                    PAGE_SIZE,
                    MEM_COMMIT | MEM_RESERVE,
                    PAGE_READWRITE,
                )
            }
            .cast::<u8>();

            if ptr.is_null() {
                return Self {
                    ptr: std::ptr::null_mut(),
                    locked: false,
                    fallback: Some(Box::new(*key)),
                };
            }

            // SAFETY: the allocation is writable and at least one page long.
            let locked = unsafe { VirtualLock(ptr.cast(), PAGE_SIZE) } != 0;
            // SAFETY: same live allocation as above.
            unsafe {
                std::ptr::copy_nonoverlapping(key.as_ptr(), ptr, KEY_LEN);
            }

            Self {
                ptr,
                locked,
                fallback: None,
            }
        }

        pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
            match &self.fallback {
                Some(fallback) => fallback,
                // SAFETY: `ptr` points at a live allocation of one page.
                None => unsafe { &*(self.ptr as *const [u8; KEY_LEN]) },
            }
        }
    }

    impl Drop for Inner {
        fn drop(&mut self) {
            if !self.ptr.is_null() {
                // SAFETY: `ptr` is the live allocation from `new`.
                unsafe {
                    let bytes = std::slice::from_raw_parts_mut(self.ptr, KEY_LEN);
                    bytes.zeroize();
                    if self.locked {
                        VirtualUnlock(self.ptr.cast(), PAGE_SIZE);
                    }
                    VirtualFree(self.ptr.cast(), 0, MEM_RELEASE);
                }
            }
            if let Some(fallback) = self.fallback.as_mut() {
                fallback.zeroize();
            }
        }
    }
}

#[cfg(not(any(unix, windows)))]
mod imp {
    use super::KEY_LEN;
    use zeroize::Zeroize;

    pub struct Inner(Box<[u8; KEY_LEN]>);

    impl Inner {
        pub fn new(key: &[u8; KEY_LEN]) -> Self {
            Self(Box::new(*key))
        }

        pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
            &self.0
        }
    }

    impl Drop for Inner {
        fn drop(&mut self) {
            self.0.zeroize();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::LockedKey;

    #[test]
    fn stores_and_returns_the_key() {
        let key = [0x5a; 32];
        let locked = LockedKey::new(&key);
        assert_eq!(locked.as_bytes(), &key);
    }

    #[test]
    fn keys_are_independent() {
        let first = LockedKey::new(&[1; 32]);
        let second = LockedKey::new(&[2; 32]);
        assert_eq!(first.as_bytes(), &[1; 32]);
        assert_eq!(second.as_bytes(), &[2; 32]);
    }
}
