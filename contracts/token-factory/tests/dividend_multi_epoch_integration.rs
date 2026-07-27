//! Multi-epoch dividend distribution integration tests (Issue #1316)
//!
//! Tests the four required settlement scenarios:
//! 1. Normal two-epoch sequence — epoch counters advance, claims are deterministic.
//! 2. Late-claiming across epoch boundary — no loss, no double-claim.
//! 3. Zero-supply epoch — contract rejects gracefully, no fund lock.
//! 4. Single-holder epoch — 100% of dividends route to that holder.

use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env, String};
use token_factory::{TokenFactory, TokenFactoryClient};

const CLAIM_WINDOW: u32 = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

fn setup(env: &Env) -> (TokenFactoryClient, Address, u32) {
    env.mock_all_auths();
    let cid = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(env, &cid);

    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    client.initialize(&admin, &treasury, &0i128, &0i128);

    client.create_token(
        &admin,
        &String::from_str(env, "EpochToken"),
        &String::from_str(env, "EPT"),
        &7u32,
        &0i128,
        &None,
        &0i128,
    );

    (client, admin, 0u32)
}

fn advance(env: &Env, ledgers: u32) {
    env.ledger().with_mut(|l| l.sequence_number += ledgers);
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 — Normal Two-Epoch Sequence
// ─────────────────────────────────────────────────────────────────────────────

/// Verifies that two back-to-back distribution epochs:
/// - Assign monotonically increasing IDs (0, 1)
/// - Compute pro-rata claims correctly for each epoch independently
/// - Total claimed per epoch never exceeds the pool
#[test]
fn normal_two_epoch_sequence() {
    let env = Env::default();
    let (client, admin, token_index) = setup(&env);

    let h1 = Address::generate(&env);
    let h2 = Address::generate(&env);
    // 60 / 40 split
    client.mint(&admin, &token_index, &h1, &600_0000000i128);
    client.mint(&admin, &token_index, &h2, &400_0000000i128);

    let pool1: i128 = 1_000_000;
    let pool2: i128 = 2_000_000;

    // --- Epoch 0 ---
    let dist0 = client.initiate_distribution(
        &admin, &token_index, &Address::generate(&env), &pool1, &CLAIM_WINDOW,
    );
    assert_eq!(dist0, 0, "first distribution ID must be 0");

    let a1_e0 = client.claim_dividend(&h1, &dist0);
    let a2_e0 = client.claim_dividend(&h2, &dist0);
    assert_eq!(a1_e0, pool1 * 600 / 1000, "epoch 0: h1 expected 60%");
    assert_eq!(a2_e0, pool1 * 400 / 1000, "epoch 0: h2 expected 40%");
    assert!(a1_e0 + a2_e0 <= pool1, "epoch 0: total claimed must not exceed pool");

    advance(&env, CLAIM_WINDOW + 1);

    // --- Epoch 1 ---
    let dist1 = client.initiate_distribution(
        &admin, &token_index, &Address::generate(&env), &pool2, &CLAIM_WINDOW,
    );
    assert_eq!(dist1, 1, "second distribution ID must be 1");

    let a1_e1 = client.claim_dividend(&h1, &dist1);
    let a2_e1 = client.claim_dividend(&h2, &dist1);
    assert_eq!(a1_e1, pool2 * 600 / 1000, "epoch 1: h1 expected 60%");
    assert_eq!(a2_e1, pool2 * 400 / 1000, "epoch 1: h2 expected 40%");
    assert!(a1_e1 + a2_e1 <= pool2, "epoch 1: total claimed must not exceed pool");

    // Epoch 0 claims must not be repeatable
    let res = client.try_claim_dividend(&h1, &dist0);
    assert!(res.is_err(), "double-claim across epochs must be rejected");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2 — Late-Claiming Across Epoch Boundary
// ─────────────────────────────────────────────────────────────────────────────

/// A holder who misses Epoch N's window:
/// - Cannot retroactively claim Epoch N (window closed error)
/// - Can still claim Epoch N+1 while that window is open
/// - Double-claiming in Epoch N+1 is rejected
#[test]
fn late_claiming_across_epoch_boundary() {
    let env = Env::default();
    let (client, admin, token_index) = setup(&env);

    let early_claimer = Address::generate(&env);
    let late_claimer = Address::generate(&env);
    // Equal balances for simplicity
    client.mint(&admin, &token_index, &early_claimer, &500_0000000i128);
    client.mint(&admin, &token_index, &late_claimer,  &500_0000000i128);

    let pool: i128 = 1_000_000;

    // --- Epoch 0 ---
    let dist0 = client.initiate_distribution(
        &admin, &token_index, &Address::generate(&env), &pool, &CLAIM_WINDOW,
    );

    // early_claimer grabs their share during epoch 0
    let early_claimed = client.claim_dividend(&early_claimer, &dist0);
    assert_eq!(early_claimed, pool / 2);

    // late_claimer does nothing — epoch 0 window expires
    advance(&env, CLAIM_WINDOW + 1);

    // --- Epoch 1 ---
    let dist1 = client.initiate_distribution(
        &admin, &token_index, &Address::generate(&env), &pool, &CLAIM_WINDOW,
    );

    // late_claimer tries to claim epoch 0 retroactively — must fail
    let stale = client.try_claim_dividend(&late_claimer, &dist0);
    assert!(stale.is_err(), "epoch 0 claim after window must fail");
    assert_eq!(
        stale.unwrap_err().unwrap(),
        token_factory::types::Error::DistributionWindowClosed.into(),
        "expected DistributionWindowClosed",
    );

    // late_claimer can still claim epoch 1 (different distribution)
    let late_claimed_e1 = client.claim_dividend(&late_claimer, &dist1);
    assert!(late_claimed_e1 > 0, "late claimer must receive epoch 1 share");
    assert_eq!(late_claimed_e1, pool / 2, "epoch 1: late claimer gets 50%");

    // No double-claim in epoch 1
    let double = client.try_claim_dividend(&late_claimer, &dist1);
    assert!(double.is_err(), "double-claim in epoch 1 must be rejected");
    assert_eq!(
        double.unwrap_err().unwrap(),
        token_factory::types::Error::DistributionAlreadyClaimed.into(),
        "expected DistributionAlreadyClaimed",
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — Zero-Supply Epoch Skipping
// ─────────────────────────────────────────────────────────────────────────────

/// When a token has zero circulating supply the contract must:
/// - Return DistributionZeroSupply without panicking
/// - Leave no side-effects (counter not incremented, no fund lock)
/// - Allow a subsequent valid epoch on a token with supply > 0
#[test]
fn zero_supply_epoch_skipping() {
    let env = Env::default();
    let (client, admin, _existing_token_index) = setup(&env);

    // Register a fresh token with zero supply
    client.create_token(
        &admin,
        &String::from_str(&env, "ZeroSupplyToken"),
        &String::from_str(&env, "ZST"),
        &7u32,
        &0i128,
        &None,
        &0i128,
    );
    let zero_token: u32 = 1;

    // Attempt to initiate a distribution on the zero-supply token
    let res = client.try_initiate_distribution(
        &admin, &zero_token, &Address::generate(&env), &1_000_000i128, &CLAIM_WINDOW,
    );
    assert!(res.is_err(), "zero-supply distribution must be rejected");
    assert_eq!(
        res.unwrap_err().unwrap(),
        token_factory::types::Error::DistributionZeroSupply.into(),
        "expected DistributionZeroSupply",
    );

    // Distribution counter must not have advanced — the next valid distribution
    // on the original token (token_index=0) with supply should receive ID 0.
    let original_token: u32 = 0;
    let holder = Address::generate(&env);
    client.mint(&admin, &original_token, &holder, &1000_0000000i128);

    let valid_dist_id = client.initiate_distribution(
        &admin, &original_token, &Address::generate(&env), &500_000i128, &CLAIM_WINDOW,
    );
    assert_eq!(valid_dist_id, 0, "counter must not have been bumped by zero-supply rejection");

    // Funds are claimable normally — no fund lock from the rejected epoch
    let amount = client.claim_dividend(&holder, &valid_dist_id);
    assert_eq!(amount, 500_000i128, "single holder must receive full pool");
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 — Single-Holder Epoch
// ─────────────────────────────────────────────────────────────────────────────

/// When a single address holds 100% of the circulating supply:
/// - That holder's claim equals the full pool (modulo integer rounding, ≥ pool-1)
/// - No other address can claim any share
/// - Admin can reclaim any dust remainder after the window closes
#[test]
fn single_holder_epoch() {
    let env = Env::default();
    let (client, admin, token_index) = setup(&env);

    let sole_holder = Address::generate(&env);
    let bystander = Address::generate(&env);

    // sole_holder owns all tokens; bystander has none
    client.mint(&admin, &token_index, &sole_holder, &1_000_0000000i128);

    let pool: i128 = 1_000_000_000;

    let dist_id = client.initiate_distribution(
        &admin, &token_index, &Address::generate(&env), &pool, &CLAIM_WINDOW,
    );

    // sole_holder gets 100%
    let claimed = client.claim_dividend(&sole_holder, &dist_id);
    // Integer division: balance/supply = 1_000_0000000 / 1_000_0000000 = 1 → full pool
    assert_eq!(claimed, pool, "sole holder must receive 100% of the pool");

    // bystander had zero balance — NothingToClaim
    let bystander_res = client.try_claim_dividend(&bystander, &dist_id);
    assert!(bystander_res.is_err(), "bystander with zero balance must be rejected");
    assert_eq!(
        bystander_res.unwrap_err().unwrap(),
        token_factory::types::Error::NothingToClaim.into(),
        "expected NothingToClaim for bystander",
    );

    // After window closes, admin reclaims dust (should be 0 since full pool was claimed)
    advance(&env, CLAIM_WINDOW + 1);
    let reclaimed = client.reclaim_unclaimed(&admin, &dist_id);
    assert_eq!(reclaimed, pool - claimed, "reclaimed remainder must equal pool minus claimed");
}
