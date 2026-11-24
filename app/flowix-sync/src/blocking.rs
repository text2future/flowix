//! Running short blocking calls from async code.
//!
//! The sync engine is deliberately synchronous on the local side: file locks,
//! atomic renames and `stat` have no async form worth the complexity here. But
//! calling them straight from a future runs them on a Tokio worker, and a
//! multi-megabyte attachment read plus SHA-256 blocks that worker for as long as
//! the disk takes — with four uploads in flight, a whole core's worth of
//! workers can be parked on I/O and unrelated tasks (the UI's own commands)
//! stall behind them.
//!
//! [`run`] hands the call to `block_in_place`, which tells the multi-threaded
//! scheduler to move the remaining tasks off this worker first. Current-thread
//! runtimes (most `#[tokio::test]` bodies) have nothing to move, so the call
//! runs in place: `block_in_place` panics there, which is why the flavour is
//! checked rather than assumed.

/// Runs `call`, yielding the worker to the scheduler when that is possible.
pub(crate) fn run<R>(call: impl FnOnce() -> R) -> R {
    match tokio::runtime::Handle::try_current().map(|handle| handle.runtime_flavor()) {
        Ok(tokio::runtime::RuntimeFlavor::MultiThread) => tokio::task::block_in_place(call),
        // No runtime, or a current-thread one: there is no other worker to
        // protect, and `block_in_place` would panic.
        _ => call(),
    }
}
