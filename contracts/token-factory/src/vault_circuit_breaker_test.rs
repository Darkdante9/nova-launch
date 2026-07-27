//! Per-epoch vault withdrawal circuit breaker tests (issue #1362).

#![cfg(test)]

use super::*;
use crate::storage;
use crate::types::{Error, Vault, VaultStatus};
use crate::vault;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    Address, BytesN, Env, Symbol, TryFromVal,
};

fn seed_vault(env: &Env, vault_id: u64, owner: &Address, amount: i128) {
    let v = Vault {
        id: vault_id,
        token: Address::generate(env),
        owner: owner.clone(),
        creator: Address::generate(env),
        total_amount: amount,
        claimed_amount: 0,
        unlock_time: 0,
        milestone_hash: BytesN::from_array(env, &[0u8; 32]),
        status: VaultStatus::Active,
        created_at: 0,
        verifier: None,
        milestone_verified: false,
    };
    storage::set_vault(env, &v).unwrap();
}

fn setup() -> (Env, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    storage::set_admin(&env, &admin);
    (env, admin)
}

// ── Normal operation under limit ──────────────────────────────────────────────

#[test]
fn test_claim_below_limit_succeeds() {
    let (env, admin) = setup();
    let owner = Address::generate(&env);
    seed_vault(&env, 1, &owner, 500);

    vault::set_vault_withdraw_limit(&env, &admin, 1_000).unwrap();

    let claimed = vault::claim_vault(&env, 1, &owner).unwrap();
    assert_eq!(claimed, 500);
    assert!(!storage::get_vault_circuit_breaker_paused(&env));
}

#[test]
fn test_claim_with_no_limit_set_succeeds() {
    let (env, _admin) = setup();
    let owner = Address::generate(&env);
    seed_vault(&env, 1, &owner, 1_000_000);

    let claimed = vault::claim_vault(&env, 1, &owner).unwrap();
    assert_eq!(claimed, 1_000_000);
    assert!(!storage::get_vault_circuit_breaker_paused(&env));
}

// ── Circuit breaker triggers at limit ────────────────────────────────────────

#[test]
fn test_circuit_breaker_triggers_at_limit() {
    let (env, admin) = setup();
    let owner = Address::generate(&env);
    seed_vault(&env, 1, &owner, 1_000);

    vault::set_vault_withdraw_limit(&env, &admin, 1_000).unwrap();

    vault::claim_vault(&env, 1, &owner).unwrap();

    // Circuit breaker should now be paused
    assert!(storage::get_vault_circuit_breaker_paused(&env));
}

#[test]
fn test_circuit_breaker_emits_event() {
    let (env, admin) = setup();
    let owner = Address::generate(&env);
    seed_vault(&env, 1, &owner, 1_000);

    vault::set_vault_withdraw_limit(&env, &admin, 1_000).unwrap();
    vault::claim_vault(&env, 1, &owner).unwrap();

    let events = env.events().all();
    let has_cb_event = events.iter().any(|(_, topics, _)| {
        topics
            .get(0)
            .and_then(|v| Symbol::try_from_val(&env, &v).ok())
            .map(|s| s == Symbol::new(&env, "vlt_cb"))
            .unwrap_or(false)
    });
    assert!(has_cb_event, "VaultCircuitBreakerTriggered event not emitted");
}

#[test]
fn test_withdrawal_blocked_after_circuit_breaker() {
    let (env, admin) = setup();

    // First vault triggers circuit breaker
    let owner1 = Address::generate(&env);
    seed_vault(&env, 1, &owner1, 1_000);
    vault::set_vault_withdraw_limit(&env, &admin, 1_000).unwrap();
    vault::claim_vault(&env, 1, &owner1).unwrap();
    assert!(storage::get_vault_circuit_breaker_paused(&env));

    // Second vault is blocked
    let owner2 = Address::generate(&env);
    seed_vault(&env, 2, &owner2, 100);
    let result = vault::claim_vault(&env, 2, &owner2);
    assert_eq!(result, Err(Error::VaultCircuitBreakerActive));
}

// ── Multiple claims accumulate volume ────────────────────────────────────────

#[test]
fn test_cumulative_volume_tracked_across_claims() {
    let (env, admin) = setup();
    vault::set_vault_withdraw_limit(&env, &admin, 1_000).unwrap();

    let epoch = storage::current_epoch(&env);

    // Three claims of 300 each; limit is 1000
    for id in 1u64..=3 {
        let owner = Address::generate(&env);
        seed_vault(&env, id, &owner, 300);
        vault::claim_vault(&env, id, &owner).unwrap();
    }

    let volume = storage::get_epoch_withdraw_volume(&env, epoch);
    assert_eq!(volume, 900);
    assert!(!storage::get_vault_circuit_breaker_paused(&env));

    // One more claim of 100 hits exactly 1000 → triggers
    let owner = Address::generate(&env);
    seed_vault(&env, 4, &owner, 100);
    vault::claim_vault(&env, 4, &owner).unwrap();
    assert!(storage::get_vault_circuit_breaker_paused(&env));
}

// ── Resume after manual review ────────────────────────────────────────────────

#[test]
fn test_admin_can_resume_after_circuit_breaker() {
    let (env, admin) = setup();
    let owner = Address::generate(&env);
    seed_vault(&env, 1, &owner, 1_000);

    vault::set_vault_withdraw_limit(&env, &admin, 1_000).unwrap();
    vault::claim_vault(&env, 1, &owner).unwrap();
    assert!(storage::get_vault_circuit_breaker_paused(&env));

    vault::resume_vault(&env, &admin).unwrap();
    assert!(!storage::get_vault_circuit_breaker_paused(&env));
}

#[test]
fn test_claims_allowed_after_resume() {
    let (env, admin) = setup();

    let owner1 = Address::generate(&env);
    seed_vault(&env, 1, &owner1, 1_000);
    vault::set_vault_withdraw_limit(&env, &admin, 1_000).unwrap();
    vault::claim_vault(&env, 1, &owner1).unwrap();

    vault::resume_vault(&env, &admin).unwrap();

    // New epoch so volume resets; but circuit breaker is unpaused so claim works
    // Advance to next epoch to reset volume
    let next_epoch_seq = (storage::current_epoch(&env) + 1) * storage::DEFAULT_EPOCH_LEDGERS;
    env.ledger().with_mut(|li| li.sequence = next_epoch_seq);

    let owner2 = Address::generate(&env);
    seed_vault(&env, 2, &owner2, 500);
    let result = vault::claim_vault(&env, 2, &owner2);
    assert!(result.is_ok(), "claim should succeed after resume in new epoch");
}

#[test]
fn test_non_admin_cannot_resume() {
    let (env, admin) = setup();
    let owner = Address::generate(&env);
    seed_vault(&env, 1, &owner, 1_000);

    vault::set_vault_withdraw_limit(&env, &admin, 1_000).unwrap();
    vault::claim_vault(&env, 1, &owner).unwrap();

    let attacker = Address::generate(&env);
    let result = vault::resume_vault(&env, &attacker);
    assert_eq!(result, Err(Error::Unauthorized));
}

#[test]
fn test_non_admin_cannot_set_limit() {
    let (env, _admin) = setup();
    let attacker = Address::generate(&env);
    let result = vault::set_vault_withdraw_limit(&env, &attacker, 500);
    assert_eq!(result, Err(Error::Unauthorized));
}

// ── Epoch boundary resets volume ─────────────────────────────────────────────

#[test]
fn test_new_epoch_starts_fresh_volume() {
    let (env, admin) = setup();
    vault::set_vault_withdraw_limit(&env, &admin, 1_000).unwrap();

    let owner1 = Address::generate(&env);
    seed_vault(&env, 1, &owner1, 1_000);
    vault::claim_vault(&env, 1, &owner1).unwrap();
    assert!(storage::get_vault_circuit_breaker_paused(&env));

    // Admin resumes and we advance to the next epoch
    vault::resume_vault(&env, &admin).unwrap();
    let next_epoch_seq = (storage::current_epoch(&env) + 1) * storage::DEFAULT_EPOCH_LEDGERS;
    env.ledger().with_mut(|li| li.sequence = next_epoch_seq);

    let new_epoch = storage::current_epoch(&env);
    assert_eq!(storage::get_epoch_withdraw_volume(&env, new_epoch), 0);

    // Fresh claim in new epoch should succeed (volume = 0 < limit 1000)
    let owner2 = Address::generate(&env);
    seed_vault(&env, 2, &owner2, 500);
    assert!(vault::claim_vault(&env, 2, &owner2).is_ok());
}
