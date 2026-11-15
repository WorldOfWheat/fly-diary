//! Bounded thread pool for vault I/O.
//!
//! Scans, imports, upgrades and search queries all decrypt independent files,
//! so they benefit from parallelism. They must not use the global Rayon pool
//! directly: a vault can contain 16 MiB entries, and using every core at once
//! multiplies the transient buffers. This pool caps the worker count and lets
//! every vault operation share the same budget instead of oversubscribing the
//! CPU when an import, an upgrade and a background scan overlap.

use std::sync::OnceLock;

use rayon::ThreadPool;

/// Upper bound on vault I/O workers. Four is enough to hide I/O latency on an
/// SSD without turning HDD or network shares into a seek storm.
const MAX_IO_THREADS: usize = 4;

static VAULT_POOL: OnceLock<ThreadPool> = OnceLock::new();

/// The shared pool used by storage, search and attachment reads.
pub fn vault_pool() -> &'static ThreadPool {
    VAULT_POOL.get_or_init(|| {
        let cores = std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(2);
        let threads = cores.clamp(1, MAX_IO_THREADS);
        rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|index| format!("fly-diary-io-{index}"))
            .build()
            .expect("failed to build the vault I/O pool")
    })
}
