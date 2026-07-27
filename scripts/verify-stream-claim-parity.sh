#!/usr/bin/env bash
# verify-stream-claim-parity.sh
#
# Verifies stream cancellation-with-settlement scenarios by running
# the relevant cargo tests and asserting they all pass.
#
# Usage: ./scripts/verify-stream-claim-parity.sh

set -euo pipefail

CONTRACTS_DIR="$(cd "$(dirname "$0")/../contracts/token-factory" && pwd)"

echo "==> Running stream cancellation-with-settlement tests..."
cd "$CONTRACTS_DIR"

cargo test stream_cancel -- --nocapture 2>&1

echo ""
echo "==> All stream cancellation settlement scenarios passed."
