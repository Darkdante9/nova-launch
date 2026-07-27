//! Tests for the Pro-tier clawback feature.
//!
//! Covers:
//! - Successful clawback reduces holder balance and total_supply by exactly `amount`
//! - Clawback on a token with `clawback_enabled = false` panics with ClawbackDisabled (11)
//! - Unauthorized caller (non-admin) panics with Unauthorized (2)
//! - Clawback amount exceeding holder balance panics with InsufficientBalance (7)
//! - Clawback from a frozen account still succeeds
//! - Property: total_supply decreases by exactly the clawback amount

#![cfg(test)]

use crate::{storage, types::TokenInfo, TokenFactory, TokenFactoryClient};
use soroban_sdk::{
    testutils::{Address as _, Events},
    Address, Env, String,
};

const INITIAL_SUPPLY: i128 = 1_000_000_0000000;

/// Returns `(env, contract_id, admin, treasury, holder, token_index)`.
fn setup(clawback_enabled: bool) -> (Env, Address, Address, Address, Address, u32) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let holder = Address::generate(&env);

    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    let token_address = Address::generate(&env);
    let token_info = TokenInfo {
        address: token_address,
        creator: admin.clone(),
        name: String::from_str(&env, "Pro Token"),
        symbol: String::from_str(&env, "PRO"),
        decimals: 7,
        total_supply: INITIAL_SUPPLY,
        initial_supply: INITIAL_SUPPLY,
        max_supply: None,
        metadata_uri: None,
        metadata_version: 0,
        created_at: env.ledger().timestamp(),
        total_burned: 0,
        burn_count: 0,
        is_paused: false,
        clawback_enabled,
        freeze_enabled: false,
    };

    let token_index: u32 = 0;
    env.as_contract(&contract_id, || {
        storage::set_token_info(&env, token_index, &token_info);
        storage::set_balance(&env, token_index, &holder, INITIAL_SUPPLY);
    });

    (env, contract_id, admin, treasury, holder, token_index)
}

// ── Happy path ───────────────────────────────────────────────────────────────

#[test]
fn clawback_success_reduces_balance_and_supply() {
    let (env, contract_id, admin, _treasury, holder, token_index) = setup(true);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let amount = 500_0000000_i128;
    client.clawback(&admin, &token_index, &holder, &amount);

    let info = client.get_token_info(&token_index);
    let remaining = env.as_contract(&contract_id, || {
        storage::get_balance(&env, token_index, &holder)
    });

    assert_eq!(info.total_supply, INITIAL_SUPPLY - amount);
    assert_eq!(info.total_burned, amount);
    assert_eq!(info.burn_count, 1);
    assert_eq!(remaining, INITIAL_SUPPLY - amount);
}

// ── Clawback disabled guard ──────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #11)")]
fn clawback_panics_when_disabled() {
    let (env, contract_id, admin, _treasury, holder, token_index) = setup(false);
    let client = TokenFactoryClient::new(&env, &contract_id);
    client.clawback(&admin, &token_index, &holder, &1_000_000);
}

// ── Authorization ────────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #2)")]
fn clawback_panics_for_unauthorized_caller() {
    let (env, contract_id, _admin, _treasury, holder, token_index) = setup(true);
    let client = TokenFactoryClient::new(&env, &contract_id);
    let impostor = Address::generate(&env);
    client.clawback(&impostor, &token_index, &holder, &1_000_000);
}

// ── Insufficient balance ─────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #7)")]
fn clawback_panics_when_amount_exceeds_balance() {
    let (env, contract_id, admin, _treasury, holder, token_index) = setup(true);
    let client = TokenFactoryClient::new(&env, &contract_id);
    client.clawback(&admin, &token_index, &holder, &(INITIAL_SUPPLY + 1));
}

// ── Frozen account ───────────────────────────────────────────────────────────

#[test]
fn clawback_succeeds_on_frozen_account() {
    let (env, contract_id, admin, _treasury, holder, token_index) = setup(true);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let info = client.get_token_info(&token_index);
    env.as_contract(&contract_id, || {
        storage::set_address_frozen(&env, &info.address, &holder, true);
    });

    let amount = 1_0000000_i128;
    client.clawback(&admin, &token_index, &holder, &amount);

    let updated = client.get_token_info(&token_index);
    assert_eq!(updated.total_supply, INITIAL_SUPPLY - amount);
}

// ── Token not found ──────────────────────────────────────────────────────────

#[test]
#[should_panic(expected = "Error(Contract, #4)")]
fn clawback_panics_for_nonexistent_token() {
    let (env, contract_id, admin, _treasury, holder, _token_index) = setup(true);
    let client = TokenFactoryClient::new(&env, &contract_id);
    client.clawback(&admin, &999, &holder, &1_000_000);
}

// ── Property: supply decreases by exactly amount ─────────────────────────────

#[test]
fn clawback_supply_decreases_by_exact_amount() {
    for amount in [1_i128, 1_000_000, 100_0000000, 999_0000000, INITIAL_SUPPLY] {
        let (env, contract_id, admin, _treasury, holder, token_index) = setup(true);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let before = client.get_token_info(&token_index).total_supply;
        client.clawback(&admin, &token_index, &holder, &amount);
        let after = client.get_token_info(&token_index).total_supply;

        assert_eq!(
            before - after,
            amount,
            "supply must decrease by exactly the clawback amount ({amount})"
        );
    }
}

// ── Event emission ────────────────────────────────────────────────────────────

#[test]
fn clawback_emits_clwbk_v1_event() {
    let (env, contract_id, admin, _treasury, holder, token_index) = setup(true);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let before = env.events().all().events().len();
    client.clawback(&admin, &token_index, &holder, &1_0000000_i128);
    let after = env.events().all().events().len();

    assert!(after > before, "at least one event must be emitted on successful clawback");
}
