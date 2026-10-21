#!/usr/bin/env bash
# Verifies the CellHive fork against the native limit tests and the generated type snapshot.
#
# Usage:
#   tools/cellhive-verify.sh
#   CELLHIVE_BAZEL=/usr/bin/bazel tools/cellhive-verify.sh
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

bazel_bin="${CELLHIVE_BAZEL:-/opt/cellhive-tools/bazelisk}"

echo "==> running CellHive native limit tests"
"$bazel_bin" test \
  //src/workerd/io:io-context-abort-test@ \
  //src/workerd/api/tests:worker-loader-limits-test@ \
  --config=opt \
  --test_output=errors

echo "==> verifying generated type snapshot"
"$bazel_bin" build //types --config=opt
diff -r types/generated-snapshot bazel-bin/types/definitions

echo "==> checking fork build marker"
./bazel-bin/src/workerd/server/workerd cellhive-build-info

echo "cellhive fork verification passed"
