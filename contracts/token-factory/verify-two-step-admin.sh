#!/bin/bash
# Verification script for two-step admin transfer implementation

echo "=== Two-Step Admin Transfer Implementation Verification ==="
echo ""

echo "1. Checking storage functions..."
grep -q "get_pending_admin" src/storage.rs && echo "✅ get_pending_admin exists" || echo "❌ get_pending_admin missing"
grep -q "set_pending_admin" src/storage.rs && echo "✅ set_pending_admin exists" || echo "❌ set_pending_admin missing"
grep -q "clear_pending_admin" src/storage.rs && echo "✅ clear_pending_admin exists" || echo "❌ clear_pending_admin missing"
grep -q "has_pending_admin" src/storage.rs && echo "✅ has_pending_admin exists" || echo "❌ has_pending_admin missing"

echo ""
echo "2. Checking data model..."
grep -q "PendingAdmin" src/types.rs && echo "✅ PendingAdmin in DataKey" || echo "❌ PendingAdmin missing"

echo ""
echo "3. Checking contract entry points..."
grep -q "pub fn propose_admin" src/lib.rs && echo "✅ propose_admin entry point exists" || echo "❌ propose_admin missing"
grep -q "pub fn accept_admin" src/lib.rs && echo "✅ accept_admin entry point exists" || echo "❌ accept_admin missing"
grep -q "pub fn cancel_admin" src/lib.rs && echo "✅ cancel_admin entry point exists" || echo "❌ cancel_admin missing"

echo ""
echo "4. Checking events..."
grep -q "emit_admin_proposed" src/events.rs && echo "✅ emit_admin_proposed (legacy) exists" || echo "❌ emit_admin_proposed missing"
grep -q "emit_admin_transfer_proposed" src/events.rs && echo "✅ AdminTransferProposed event exists" || echo "❌ AdminTransferProposed missing"
grep -q "emit_admin_transfer_accepted" src/events.rs && echo "✅ AdminTransferAccepted event exists" || echo "❌ AdminTransferAccepted missing"
grep -q "emit_admin_cancelled" src/events.rs && echo "✅ emit_admin_cancelled event exists" || echo "❌ emit_admin_cancelled missing"

echo ""
echo "5. Checking tests..."
grep -q "test_duplicate_accept" src/two_step_admin_test.rs && echo "✅ Duplicate acceptance test exists" || echo "❌ Missing"
grep -q "test_stale_proposal" src/two_step_admin_test.rs && echo "✅ Stale proposal test exists" || echo "❌ Missing"
grep -q "test_only_one_pending_admin" src/two_step_admin_test.rs && echo "✅ Single proposal test exists" || echo "❌ Missing"
grep -q "test_unauthorized_cannot_accept" src/two_step_admin_test.rs && echo "✅ Authorization test exists" || echo "❌ Missing"
grep -q "test_two_step_transfer_happy_path" src/two_step_admin_test.rs && echo "✅ Happy path test exists" || echo "❌ Missing"
grep -q "test_accept_admin_unauthorized" src/two_step_admin_test.rs && echo "✅ Wrong address reject test exists" || echo "❌ Missing"
grep -q "test_propose_overwrites_stale_proposal" src/two_step_admin_test.rs && echo "✅ New proposal cancels previous test exists" || echo "❌ Missing"

echo ""
echo "6. Running tests (requires cargo/Rust toolchain)..."
if command -v cargo &> /dev/null; then
    echo "Running: cargo test two_step_admin"
    cargo test two_step_admin 2>&1 | tail -20
else
    echo "⚠️  cargo not found in PATH — skipping runtime tests"
    echo "   To run: cd contracts/token-factory && cargo test two_step_admin"
fi

echo ""
echo "=== Verification Complete ==="
