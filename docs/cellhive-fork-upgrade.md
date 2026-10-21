# CellHive workerd fork upgrade guide

This repository keeps a narrow CellHive fork on top of a pinned stock workerd
release. The fork is intended to be rebased to a new upstream release, tested,
and then promoted as a new runtime artifact. It is not a second JavaScript
engine and it does not replace CellHive's Go control or storage layers.

## Current baseline and patch

- Upstream baseline: `v1.20260916.1` (`adda263`)
- CellHive patch: one squashed commit on top of that tag
- Main touched areas: `src/workerd/server/server.c++`, `src/workerd/io/`,
  `src/workerd/api/cache.c++`, and the worker loader test fixtures.
- The patch adds dynamic Worker CPU, heap and external-memory limits, invocation-scoped
  subrequest accounting, binding/cache lifecycle metadata, invocation deadline
  enforcement plus propagation, and a reusable JSRPC entrypoint stub
  (`WorkerStub.getEntrypointRpcStub()`) that keeps one session across calls.

## Upgrade procedure

1. Fetch the new upstream tag and create a clean branch from it.
2. Apply the single CellHive fork commit with `git cherry-pick` (or generate a
   fresh diff with `git diff <old-tag>..<fork-commit>`).
3. Resolve conflicts first in `server/server.c++`, then in `io-context.*`,
   `io-channels.h`, `limit-enforcer.h`, `observer.h`, and `api/cache.c++`.
4. Check that the upstream `LimitEnforcer` and `IoContext` APIs still have the
   same lifecycle: `enterJs()` must cover one JavaScript execution segment and
   the limit state must be visible before a terminated V8 execution is handled.
5. Build and run the native limit tests:

   ```bash
   /opt/cellhive-tools/bazelisk test \
     //src/workerd/api/tests:worker-loader-limits-test@ \
     --config=opt --test_output=all
   ```

6. Run CellHive integration tests with the newly built binary:

   ```bash
   CELLHIVE_WORKERD=$PWD/bazel-bin/src/workerd/server/workerd \
   go test -tags 'sqlite_fts5 sqlite_dbstat sqlite_math_functions sqlite_column_metadata sqlite_preupdate_hook' \
     ./internal/userruntime ./internal/doruntime -count=1
   ```

7. Repeat the CellHive fork compatibility and upgrade/rollback rehearsal before
   changing the pinned artifact digest.

## Required acceptance checks

- `cpu_ms` stops a synchronous `while(true)` and returns an HTTP error.
- `cpu_ms` is a per-invocation budget: a loop that alternates short busy segments
  with `await` must still be stopped after the total budget is spent.
- A healthy Worker remains callable after the stopped invocation.
- Async waiting longer than `cpu_ms` does not consume CPU budget.
- `memory_bytes` enforces both the dynamic isolate heap and its external memory
  (ArrayBuffer and WebAssembly backing stores). Exceeding it fails the invocation
  cleanly instead of aborting the process; the loader drops the condemned isolate
  so the next `LOADER.get()` for the same name creates a fresh instance. Total
  process memory can still exceed `memory_bytes` by the heap limit, the near-heap
  headroom, and isolate baseline, so a process-level cgroup limit remains necessary.
- Subrequest accounting is scoped to the active invocation.
- Binding lifecycle and invocation/trace metadata survive binding and Cache
  calls.
- Configured `deadline_ms` remains present in binding and Cache metadata, and an
  invocation stuck awaiting I/O is aborted once the deadline passes.
- Multiple method calls on one `getEntrypointRpcStub()` stub succeed on the same
  JSRPC session (a `Fetcher` opens a new session per call).

## Local verification

`tools/cellhive-verify.sh` runs the native limit tests, rebuilds the generated
type snapshot and diffs it against `types/generated-snapshot`, and checks the
fork build marker. It uses `/opt/cellhive-tools/bazelisk` by default; override
with `CELLHIVE_BAZEL` when bazel lives elsewhere.

## Conflict and rollback rules

Do not resolve a conflict by dropping the CellHive hook silently. Compare the
new upstream request lifecycle and limit APIs, port the hook to the new API,
and keep the native tests beside the change. If any acceptance check fails,
keep the old binary pinned and roll back the artifact digest; do not promote a
partially rebased fork.

The fork changes only workerd. CellHive's `cpu_ms`/`subrequests` defaults,
control-plane validation, and runtime wiring live in the CellHive repository and
must be tested separately after updating this repository.
