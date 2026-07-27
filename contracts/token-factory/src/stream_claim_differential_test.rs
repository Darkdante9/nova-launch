//! Differential tests for stream claim parity
//!
//! Ensures claimable_amount read path and claim_stream execution path
//! always compute identical deltas across all schedule variants.

#[cfg(test)]
mod stream_claim_differential_tests {
    use crate::streaming::{create_stream, get_claimable_amount, claim_stream};
    use crate::types::StreamParams;
    use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env};

    fn setup() -> (Env, Address, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let creator = Address::generate(&env);
        let recipient = Address::generate(&env);
        let token = Address::generate(&env);

        (env, creator, recipient, token)
    }

    // ═══════════════════════════════════════════════════════
    //  Pre-Cliff Tests
    // ═══════════════════════════════════════════════════════

    #[test]
    fn test_parity_before_cliff() {
        let (env, creator, recipient, _token) = setup();

        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1000_0000000,
            start_time: 1000,
            end_time: 2000,
            cliff_time: 1500,
        };

        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        // Set time before cliff
        env.ledger().with_mut(|li| li.timestamp = 1200);

        // Read path
        let claimable = get_claimable_amount(&env, stream_id).unwrap();
        assert_eq!(claimable, 0, "Should be 0 before cliff");

        // Write path should fail with CliffNotReached
        let result = claim_stream(&env, &recipient, stream_id);
        assert!(result.is_err(), "Claim should fail before cliff");
    }

    #[test]
    fn test_parity_at_cliff_zero_vested() {
        let (env, creator, recipient, _token) = setup();

        // Cliff equals start time - nothing vested yet
        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1000_0000000,
            start_time: 1500,
            end_time: 2000,
            cliff_time: 1500,
        };

        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        env.ledger().with_mut(|li| li.timestamp = 1500);

        let claimable = get_claimable_amount(&env, stream_id).unwrap();
        assert_eq!(claimable, 0, "Nothing vested at start");

        let result = claim_stream(&env, &recipient, stream_id);
        assert!(result.is_err(), "Should fail with NothingToClaim");
    }

    // ═══════════════════════════════════════════════════════
    //  Mid-Vesting Tests
    // ═══════════════════════════════════════════════════════

    #[test]
    fn test_parity_mid_vesting_after_cliff() {
        let (env, creator, recipient, _token) = setup();

        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1000_0000000,
            start_time: 1000,
            end_time: 2000,
            cliff_time: 1200,
        };

        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        // Mid-vesting: 50% through (1500 out of 1000-2000)
        env.ledger().with_mut(|li| li.timestamp = 1500);

        let claimable_read = get_claimable_amount(&env, stream_id).unwrap();
        let expected = 500_0000000; // 50% of 1000
        assert_eq!(claimable_read, expected, "Read path should return 50%");

        let claimed_write = claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed_write, claimable_read, "Write path must match read path");
    }

    #[test]
    fn test_parity_mid_vesting_25_percent() {
        let (env, creator, recipient, _token) = setup();

        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1000_0000000,
            start_time: 1000,
            end_time: 2000,
            cliff_time: 1000,
        };

        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        // 25% through vesting
        env.ledger().with_mut(|li| li.timestamp = 1250);

        let claimable_read = get_claimable_amount(&env, stream_id).unwrap();
        let expected = 250_0000000;
        assert_eq!(claimable_read, expected);

        let claimed_write = claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed_write, claimable_read);
    }

    #[test]
    fn test_parity_mid_vesting_75_percent() {
        let (env, creator, recipient, _token) = setup();

        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1000_0000000,
            start_time: 1000,
            end_time: 2000,
            cliff_time: 1000,
        };

        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        // 75% through vesting
        env.ledger().with_mut(|li| li.timestamp = 1750);

        let claimable_read = get_claimable_amount(&env, stream_id).unwrap();
        let expected = 750_0000000;
        assert_eq!(claimable_read, expected);

        let claimed_write = claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed_write, claimable_read);
    }

    // ═══════════════════════════════════════════════════════
    //  Post-End Tests
    // ═══════════════════════════════════════════════════════

    #[test]
    fn test_parity_at_end_time() {
        let (env, creator, recipient, _token) = setup();

        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1000_0000000,
            start_time: 1000,
            end_time: 2000,
            cliff_time: 1000,
        };

        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        env.ledger().with_mut(|li| li.timestamp = 2000);

        let claimable_read = get_claimable_amount(&env, stream_id).unwrap();
        assert_eq!(claimable_read, 1000_0000000, "All tokens claimable at end");

        let claimed_write = claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed_write, claimable_read);
    }

    #[test]
    fn test_parity_after_end_time() {
        let (env, creator, recipient, _token) = setup();

        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1000_0000000,
            start_time: 1000,
            end_time: 2000,
            cliff_time: 1000,
        };

        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        env.ledger().with_mut(|li| li.timestamp = 3000);

        let claimable_read = get_claimable_amount(&env, stream_id).unwrap();
        assert_eq!(claimable_read, 1000_0000000);

        let claimed_write = claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed_write, claimable_read);
    }

    // ═══════════════════════════════════════════════════════
    //  Multiple Claims Tests
    // ═══════════════════════════════════════════════════════

    #[test]
    fn test_parity_after_partial_claim() {
        let (env, creator, recipient, _token) = setup();

        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1000_0000000,
            start_time: 1000,
            end_time: 2000,
            cliff_time: 1000,
        };

        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        // First claim at 50%
        env.ledger().with_mut(|li| li.timestamp = 1500);
        let first_claim = claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(first_claim, 500_0000000);

        // Second claim at 75%
        env.ledger().with_mut(|li| li.timestamp = 1750);
        let claimable_read = get_claimable_amount(&env, stream_id).unwrap();
        let expected = 250_0000000; // 75% - 50% already claimed
        assert_eq!(claimable_read, expected);

        let claimed_write = claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed_write, claimable_read);
    }

    #[test]
    fn test_parity_nothing_to_claim_after_full_claim() {
        let (env, creator, recipient, _token) = setup();

        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1000_0000000,
            start_time: 1000,
            end_time: 2000,
            cliff_time: 1000,
        };

        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        // Claim everything at end
        env.ledger().with_mut(|li| li.timestamp = 2000);
        claim_stream(&env, &recipient, stream_id).unwrap();

        // Try to read/claim again
        let claimable_read = get_claimable_amount(&env, stream_id).unwrap();
        assert_eq!(claimable_read, 0);

        let result = claim_stream(&env, &recipient, stream_id);
        assert!(result.is_err(), "Should fail with NothingToClaim");
    }

    // ═══════════════════════════════════════════════════════
    //  Edge Cases & Rounding Tests
    // ═══════════════════════════════════════════════════════

    #[test]
    fn test_parity_odd_duration_rounding() {
        let (env, creator, recipient, _token) = setup();

        // Duration that doesn't divide evenly
        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1000_0000000,
            start_time: 1000,
            end_time: 1003, // 3 second duration
            cliff_time: 1000,
        };

        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        // 1 second in (1/3 through)
        env.ledger().with_mut(|li| li.timestamp = 1001);

        let claimable_read = get_claimable_amount(&env, stream_id).unwrap();
        let claimed_write = claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed_write, claimable_read, "Rounding must match");
    }

    #[test]
    fn test_parity_large_amounts() {
        let (env, creator, recipient, _token) = setup();

        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: i128::MAX / 2, // Very large amount
            start_time: 1000,
            end_time: 2000,
            cliff_time: 1000,
        };

        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        env.ledger().with_mut(|li| li.timestamp = 1500);

        let claimable_read = get_claimable_amount(&env, stream_id).unwrap();
        let claimed_write = claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed_write, claimable_read);
    }

    #[test]
    fn test_parity_minimum_amount() {
        let (env, creator, recipient, _token) = setup();

        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1, // Minimum amount
            start_time: 1000,
            end_time: 2000,
            cliff_time: 1000,
        };

        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        env.ledger().with_mut(|li| li.timestamp = 1500);

        let claimable_read = get_claimable_amount(&env, stream_id).unwrap();
        let claimed_write = claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed_write, claimable_read);
    }

    // ═══════════════════════════════════════════════════════
    //  Regression Fixtures
    // ═══════════════════════════════════════════════════════

    #[test]
    fn test_regression_cliff_after_start() {
        // Regression: cliff after start caused confusion
        let (env, creator, recipient, _token) = setup();

        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1000_0000000,
            start_time: 1000,
            end_time: 2000,
            cliff_time: 1300, // Cliff 300s after start
        };

        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        // At cliff time, 30% should be vested
        env.ledger().with_mut(|li| li.timestamp = 1300);

        let claimable_read = get_claimable_amount(&env, stream_id).unwrap();
        let expected = 300_0000000;
        assert_eq!(claimable_read, expected);

        let claimed_write = claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed_write, claimable_read);
    }

    #[test]
    fn test_regression_zero_duration() {
        // Regression: zero duration edge case
        let (env, creator, recipient, _token) = setup();

        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1000_0000000,
            start_time: 1000,
            end_time: 1000, // Same as start
            cliff_time: 1000,
        };

        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        env.ledger().with_mut(|li| li.timestamp = 1000);

        let claimable_read = get_claimable_amount(&env, stream_id).unwrap();
        assert_eq!(claimable_read, 1000_0000000, "All immediately vested");

        let claimed_write = claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed_write, claimable_read);
    }

    #[test]
    fn test_regression_timestamp_boundary() {
        // Regression: boundary conditions at exact timestamps
        let (env, creator, recipient, _token) = setup();

        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1000_0000000,
            start_time: 1000,
            end_time: 2000,
            cliff_time: 1000,
        };

        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        // Test at exact start time
        env.ledger().with_mut(|li| li.timestamp = 1000);
        let claimable = get_claimable_amount(&env, stream_id).unwrap();
        assert_eq!(claimable, 0, "Nothing at start");

        // Test at exact end time
        env.ledger().with_mut(|li| li.timestamp = 2000);
        let claimable = get_claimable_amount(&env, stream_id).unwrap();
        let claimed = claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(claimed, claimable);
        assert_eq!(claimed, 1000_0000000, "All at end");
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Full claim-event payload differential tests
//
// Mirror: backend/src/__tests__/streamEventParser.test.ts
// Shared fixture data: backend/src/__tests__/fixtures/streamClaimDifferential.json
//
// These tests use the same numeric values as the JSON fixture so that both
// the Rust contract side and the TypeScript backend projection can be kept
// in sync.  The fixture is loaded via include_str! and parsed with serde_json
// to ensure the Rust constants always match the file — any drift causes a
// compile-time / parse-time failure.
//
// Known field-name differences between contract and backend:
//   Contract `claimed_amount`  ↔  Backend has no running cumulative field
//   Contract has no `claimedAt`  ↔  Backend stores it from the event timestamp
//   Contract `total_amount - claimed_amount` = remaining
//     ↔  Backend does not persist remaining; derive on demand.
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod stream_claim_full_payload_differential {
    use crate::streaming::{cancel_stream, claim_stream, create_stream, get_claimable_amount, get_stream};
    use crate::types::StreamParams;
    use serde::Deserialize;
    use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env};

    // Load the shared fixture at compile time; parse lazily in tests.
    const FIXTURE_JSON: &str = include_str!("../../../backend/src/__tests__/fixtures/streamClaimDifferential.json");

    #[derive(Deserialize)]
    struct ClaimFixture {
        #[serde(rename = "scenarioId")]
        scenario_id: u64,
        scenario: String,
        #[serde(rename = "streamId")]
        stream_id: u64,
        #[serde(rename = "totalAmount")]
        total_amount: String,
        #[serde(rename = "startTime")]
        start_time: u64,
        #[serde(rename = "endTime")]
        end_time: u64,
        #[serde(rename = "cliffTime")]
        cliff_time: u64,
        #[serde(rename = "claimAtLedgerTimestamp")]
        claim_at_ledger_timestamp: u64,
        #[serde(rename = "expectedClaimedAmount")]
        expected_claimed_amount: String,
        #[serde(rename = "expectedRemainingAmount")]
        expected_remaining_amount: String,
        #[serde(rename = "expectedStatus")]
        expected_status: String,
    }

    fn load_fixtures() -> Vec<ClaimFixture> {
        serde_json::from_str(FIXTURE_JSON).expect("fixture JSON must be valid")
    }

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let creator = Address::generate(&env);
        let recipient = Address::generate(&env);
        (env, creator, recipient)
    }

    // ── Scenarios 1-8: regular partial / full claims ─────────────────────

    #[test]
    fn fixture_scenario_1_partial_claim_50pct_claimed_amount_and_remaining() {
        let fixtures = load_fixtures();
        let f = fixtures.iter().find(|x| x.scenario_id == 1).unwrap();

        let (env, creator, recipient) = setup();
        let total: i128 = f.total_amount.parse().unwrap();
        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: total,
            start_time: f.start_time,
            end_time: f.end_time,
            cliff_time: f.cliff_time,
        };
        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        env.ledger().with_mut(|li| li.timestamp = f.claim_at_ledger_timestamp);

        let claimed = claim_stream(&env, &recipient, stream_id).unwrap();

        let expected_claimed: i128 = f.expected_claimed_amount.parse().unwrap();
        let expected_remaining: i128 = f.expected_remaining_amount.parse().unwrap();

        assert_eq!(claimed, expected_claimed, "scenario {}: claimed amount", f.scenario_id);

        let info = get_stream(&env, stream_id).unwrap();
        assert_eq!(info.claimed_amount, expected_claimed);
        let remaining = info.total_amount - info.claimed_amount;
        assert_eq!(remaining, expected_remaining, "scenario {}: remaining amount", f.scenario_id);
        assert!(!info.cancelled, "stream must not be cancelled");
    }

    #[test]
    fn fixture_scenario_2_full_claim_at_end_zero_remaining() {
        let fixtures = load_fixtures();
        let f = fixtures.iter().find(|x| x.scenario_id == 2).unwrap();

        let (env, creator, recipient) = setup();
        let total: i128 = f.total_amount.parse().unwrap();
        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: total,
            start_time: f.start_time,
            end_time: f.end_time,
            cliff_time: f.cliff_time,
        };
        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        env.ledger().with_mut(|li| li.timestamp = f.claim_at_ledger_timestamp);

        let claimed = claim_stream(&env, &recipient, stream_id).unwrap();

        let expected_claimed: i128 = f.expected_claimed_amount.parse().unwrap();
        let expected_remaining: i128 = f.expected_remaining_amount.parse().unwrap();

        assert_eq!(claimed, expected_claimed);
        let info = get_stream(&env, stream_id).unwrap();
        assert_eq!(info.claimed_amount, expected_claimed);
        assert_eq!(info.total_amount - info.claimed_amount, expected_remaining);
    }

    #[test]
    fn fixture_scenarios_3_through_8_claimed_amount_remaining_and_no_cancellation() {
        let fixtures = load_fixtures();
        let regular: Vec<_> = fixtures.iter()
            .filter(|f| f.scenario_id >= 3 && f.scenario_id <= 8)
            .collect();

        for f in regular {
            let (env, creator, recipient) = setup();
            let total: i128 = f.total_amount.parse().unwrap();
            let params = StreamParams {
                recipient: recipient.clone(),
                token_index: 0,
                total_amount: total,
                start_time: f.start_time,
                end_time: f.end_time,
                cliff_time: f.cliff_time,
            };
            let stream_id = create_stream(&env, &creator, &params, None).unwrap();

            env.ledger().with_mut(|li| li.timestamp = f.claim_at_ledger_timestamp);

            let claimed = claim_stream(&env, &recipient, stream_id).unwrap();

            let expected_claimed: i128 = f.expected_claimed_amount.parse().unwrap();
            let expected_remaining: i128 = f.expected_remaining_amount.parse().unwrap();

            assert_eq!(
                claimed, expected_claimed,
                "scenario {} ({}): claimed_amount mismatch",
                f.scenario_id, f.scenario
            );

            let info = get_stream(&env, stream_id).unwrap();
            let remaining = info.total_amount - info.claimed_amount;
            assert_eq!(
                remaining, expected_remaining,
                "scenario {} ({}): remaining_amount mismatch",
                f.scenario_id, f.scenario
            );
            assert!(!info.cancelled,
                "scenario {} ({}): stream must not be flagged cancelled",
                f.scenario_id, f.scenario
            );
        }
    }

    // ── Scenario 9: cancelled stream — claim must be rejected ────────────

    #[test]
    fn fixture_scenario_9_cancelled_stream_claim_rejected_status_cancelled() {
        let fixtures = load_fixtures();
        let f = fixtures.iter().find(|x| x.scenario_id == 9).unwrap();
        assert_eq!(f.expected_status, "CANCELLED");

        let (env, creator, recipient) = setup();
        let total: i128 = f.total_amount.parse().unwrap();
        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: total,
            start_time: f.start_time,
            end_time: f.end_time,
            cliff_time: f.cliff_time,
        };
        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        // Cancel before any claim attempt.
        env.ledger().with_mut(|li| li.timestamp = f.claim_at_ledger_timestamp - 1);
        cancel_stream(&env, &creator, stream_id).unwrap();

        env.ledger().with_mut(|li| li.timestamp = f.claim_at_ledger_timestamp);
        let result = claim_stream(&env, &recipient, stream_id);
        assert!(result.is_err(), "claim on cancelled stream must fail");

        let info = get_stream(&env, stream_id).unwrap();
        assert!(info.cancelled, "stream must be flagged as cancelled");
        // No tokens claimed — remaining equals total.
        assert_eq!(info.claimed_amount, 0);
        assert_eq!(info.total_amount - info.claimed_amount, total);
    }

    // ── Scenario 10: incremental second claim ────────────────────────────

    #[test]
    fn fixture_scenario_10_second_partial_claim_incremental_remaining_decrements() {
        let fixtures = load_fixtures();
        let f = fixtures.iter().find(|x| x.scenario_id == 10).unwrap();

        let (env, creator, recipient) = setup();
        let total: i128 = f.total_amount.parse().unwrap();
        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: total,
            start_time: f.start_time,
            end_time: f.end_time,
            cliff_time: f.cliff_time,
        };
        let stream_id = create_stream(&env, &creator, &params, None).unwrap();

        // First claim at 50 % (hardcoded from fixture scenarioId 10).
        env.ledger().with_mut(|li| li.timestamp = 1500);
        let first_claimed = claim_stream(&env, &recipient, stream_id).unwrap();
        assert_eq!(first_claimed, 500_000_000i128);

        // Second claim from the fixture.
        env.ledger().with_mut(|li| li.timestamp = f.claim_at_ledger_timestamp);
        let second_claimed = claim_stream(&env, &recipient, stream_id).unwrap();

        let expected_second: i128 = f.expected_claimed_amount.parse().unwrap();
        let expected_remaining: i128 = f.expected_remaining_amount.parse().unwrap();

        assert_eq!(second_claimed, expected_second,
            "scenario 10: second claim amount must match fixture");

        let info = get_stream(&env, stream_id).unwrap();
        let remaining = info.total_amount - info.claimed_amount;
        assert_eq!(remaining, expected_remaining,
            "scenario 10: remaining after second claim must match fixture");
        // cumulative claimed = first + second
        assert_eq!(info.claimed_amount, first_claimed + second_claimed);
    }
}
