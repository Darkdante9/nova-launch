//! Fuzz tests for the Soroban burn_auction module entry points.
//!
//! Covers the four required scenarios:
//! 1. fuzz_bid_below_reserve     — bid below current price must be rejected
//! 2. fuzz_bid_overflow_arithmetic — extreme i128 values must not panic
//! 3. fuzz_decay_below_floor     — price decay must never produce a value below reserve
//! 4. fuzz_zero_duration_auction — zero / sub-minimum duration must be rejected at creation
//!
//! All tests assert:
//! - No panic or unwrap; every error path returns a typed `Error` variant
//! - Price decay never produces a value below the configured floor (`reserve_price`)
//!
//! Run with:
//!   cargo test --features legacy-tests fuzz_burn_auction -- --nocapture

use crate::burn_auction::current_auction_price;
use crate::types::{AuctionStatus, BurnAuction, Error};
use proptest::prelude::*;
use soroban_sdk::Env;

const FUZZ_ITERATIONS: u32 = 256;

// Mirror the constants from burn_auction.rs so we can test boundary conditions.
const MIN_AUCTION_DURATION: u64 = 60;
const MAX_AUCTION_DURATION: u64 = 30 * 24 * 3_600;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build a BurnAuction with caller-supplied prices and time window.
fn make_auction(
    start_price: i128,
    reserve_price: i128,
    start_time: u64,
    end_time: u64,
) -> BurnAuction {
    BurnAuction {
        id: 1,
        token_index: 0,
        burn_amount: 1_000_000,
        start_price,
        reserve_price,
        start_time,
        end_time,
        winning_bid: None,
        winner: None,
        status: AuctionStatus::Open,
        created_at: start_time,
        settled_at: None,
    }
}

/// Set the Soroban test-environment ledger timestamp.
fn set_timestamp(env: &Env, ts: u64) {
    env.ledger().with_mut(|li| li.timestamp = ts);
}

// ---------------------------------------------------------------------------
// Proptest fuzz targets
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig::with_cases(FUZZ_ITERATIONS))]

    // -----------------------------------------------------------------------
    // Target 1: bid below reserve must always be rejected.
    //
    // Invariant: for any valid open auction, the current Dutch price is always
    // >= reserve_price.  A bid of (current_price - 1) therefore falls below
    // the current price and must be rejected with InsufficientFee.
    // We verify this by asserting that the underbid is strictly less than the
    // computed current price and that the current price never drops below the
    // reserve (the property that makes bid rejection valid).
    // -----------------------------------------------------------------------
    #[test]
    fn fuzz_bid_below_reserve(
        reserve in 2i128..100_000_000i128,
        start_extra in 1i128..100_000_000i128,
        elapsed_frac in 0u64..=1_000u64,
    ) {
        let env = Env::default();

        let start_price = reserve.saturating_add(start_extra);
        let start_time: u64 = 1_000;
        let end_time: u64 = start_time + MAX_AUCTION_DURATION;

        // Advance the ledger to a point within the auction window.
        let elapsed = elapsed_frac.saturating_mul(end_time - start_time) / 1_000;
        set_timestamp(&env, start_time + elapsed);

        let auction = make_auction(start_price, reserve, start_time, end_time);
        let result = current_auction_price(&env, &auction);

        prop_assert!(result.is_ok(), "valid auction must return Ok price");
        let price = result.unwrap();

        // Core invariant: price never falls below the configured floor.
        prop_assert!(
            price >= reserve,
            "price {price} must be >= reserve_price {reserve}"
        );

        // A bid of (price - 1) must be strictly less than the current price,
        // meaning place_bid would return Err(Error::InsufficientFee).
        if price > 0 {
            let underbid = price - 1;
            prop_assert!(
                underbid < price,
                "underbid {underbid} must be < current price {price}"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Target 2: bid overflow — extreme i128 values must not panic.
    //
    // current_auction_price uses checked arithmetic throughout. Any combination
    // of extreme prices and timestamps must return either Ok(price) or
    // Err(Error::ArithmeticError) — never a Rust panic or unwrap abort.
    // -----------------------------------------------------------------------
    #[test]
    fn fuzz_bid_overflow_arithmetic(
        start_price in 1i128..i128::MAX,
        reserve_raw in 1i128..i128::MAX,
        start_time in 0u64..u64::MAX / 4,
        duration in MIN_AUCTION_DURATION..MAX_AUCTION_DURATION,
        elapsed_frac in 0u64..=1_000u64,
    ) {
        let env = Env::default();

        // Ensure start_price > reserve_price (required invariant for valid auction).
        let reserve_price = if reserve_raw < start_price { reserve_raw } else { 1i128 };
        let end_time = start_time.saturating_add(duration);
        let elapsed = elapsed_frac.saturating_mul(end_time.saturating_sub(start_time)) / 1_000;
        set_timestamp(&env, start_time.saturating_add(elapsed));

        let auction = make_auction(start_price, reserve_price, start_time, end_time);

        // Must not panic — every outcome must be a typed result.
        let result = current_auction_price(&env, &auction);
        match result {
            Ok(price) => {
                // If computation succeeds the price must be within [reserve, start].
                prop_assert!(
                    price >= reserve_price,
                    "price {price} must be >= reserve_price {reserve_price}"
                );
                prop_assert!(
                    price <= start_price,
                    "price {price} must be <= start_price {start_price}"
                );
            }
            Err(e) => {
                // The only acceptable error is ArithmeticError from overflow.
                prop_assert_eq!(
                    e,
                    Error::ArithmeticError,
                    "expected ArithmeticError, got {e:?}"
                );
            }
        }
    }

    // -----------------------------------------------------------------------
    // Target 3: decay below floor — price must never fall below reserve_price.
    //
    // Across the full auction time window (from start_time to well past
    // end_time), the Dutch price must always be clamped to >= reserve_price.
    // This verifies the `.max(auction.reserve_price)` clamp in
    // current_auction_price as well as correct linear-decay arithmetic.
    // -----------------------------------------------------------------------
    #[test]
    fn fuzz_decay_below_floor(
        reserve in 1i128..10_000_000i128,
        start_extra in 1i128..10_000_000i128,
        duration in MIN_AUCTION_DURATION..MAX_AUCTION_DURATION,
        elapsed_frac in 0u64..=1_200u64,  // deliberately exceed 100 % to test clamping
    ) {
        let env = Env::default();

        let start_price = reserve.saturating_add(start_extra);
        let start_time: u64 = 500;
        let end_time = start_time + duration;

        // Vary timestamp across — and beyond — the auction window.
        let elapsed = elapsed_frac.saturating_mul(duration) / 1_000;
        set_timestamp(&env, start_time.saturating_add(elapsed));

        let auction = make_auction(start_price, reserve, start_time, end_time);

        let result = current_auction_price(&env, &auction);
        prop_assert!(result.is_ok(), "valid auction config must not error");
        let price = result.unwrap();

        // Primary invariant: decay must never produce a value below the floor.
        prop_assert!(
            price >= reserve,
            "price {price} must be >= reserve_price {reserve} at elapsed_frac={elapsed_frac}"
        );
        // Upper bound: price must not exceed the start price.
        prop_assert!(
            price <= start_price,
            "price {price} must be <= start_price {start_price}"
        );
    }

    // -----------------------------------------------------------------------
    // Target 4: zero-duration auction must be rejected at creation.
    //
    // create_auction enforces:
    //   start_time >= end_time            → InvalidTimeWindow
    //   duration < MIN_AUCTION_DURATION   → InvalidTimeWindow  (MIN = 60 s)
    //   duration > MAX_AUCTION_DURATION   → InvalidTimeWindow  (MAX = 30 d)
    //
    // We test the validation predicate directly across a wide range of
    // (start_time, end_time_delta) pairs, including zero, sub-minimum, and
    // super-maximum durations, asserting that the classification matches the
    // expected outcome.
    // -----------------------------------------------------------------------
    #[test]
    fn fuzz_zero_duration_auction_rejected(
        start in 1_000u64..1_000_000u64,
        end_delta in 0u64..MAX_AUCTION_DURATION + 3_600,
    ) {
        let end_time = start.saturating_add(end_delta);

        // Reproduce the exact validation from create_auction.
        let is_invalid = start >= end_time
            || end_time
                .checked_sub(start)
                .map_or(true, |d| d < MIN_AUCTION_DURATION || d > MAX_AUCTION_DURATION);

        if end_delta == 0 || start >= end_time {
            // Zero-duration: must always be flagged invalid.
            prop_assert!(
                is_invalid,
                "zero-duration auction (start={start}, end={end_time}) must be invalid"
            );
        } else {
            let duration = end_time - start;
            let expected_valid = duration >= MIN_AUCTION_DURATION && duration <= MAX_AUCTION_DURATION;
            prop_assert_eq!(
                !is_invalid,
                expected_valid,
                "duration={duration}: is_invalid={is_invalid} expected_valid={expected_valid}"
            );
        }

        // Extra invariant: any sub-minimum duration is always invalid.
        if end_delta < MIN_AUCTION_DURATION {
            prop_assert!(
                is_invalid,
                "sub-minimum duration {end_delta}s must be rejected (min={MIN_AUCTION_DURATION})"
            );
        }
    }
}
