//! Tests for on-chain metadata immutability enforcement (#1359).
//!
//! Coverage:
//! - `initialize` engages the lock and records `metadata_locked_at`
//! - Identity fields (name/symbol/decimals) are mutable *before* the lock
//! - Identity fields are rejected with `MetadataImmutable` *after* the lock
//! - A non-creator cannot reach the identity update path
//! - Metadata URI updates succeed via governance approval
//! - Governance metadata updates require a configured governance contract

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, Env, String,
};

use crate::{
    storage,
    types::{Error, TokenInfo},
    TokenFactory, TokenFactoryClient,
};

// ── helpers ──────────────────────────────────────────────────────────────────

/// Register the contract and insert a bare token at index 0 *without* running
/// `initialize`, leaving the metadata lock disengaged.
fn setup_unlocked() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let creator = Address::generate(&env);
    let treasury = Address::generate(&env);

    env.as_contract(&contract_id, || {
        storage::set_treasury(&env, &treasury);
        storage::set_base_fee(&env, 100);
        storage::set_metadata_fee(&env, 50);
        insert_token(&env, &contract_id, &creator);
    });

    (env, contract_id, creator)
}

/// Insert a minimal `TokenInfo` at index 0 with metadata already set to version 1.
fn insert_token(env: &Env, contract_id: &Address, creator: &Address) {
    let token_info = TokenInfo {
        address: contract_id.clone(),
        creator: creator.clone(),
        name: String::from_str(env, "OriginalName"),
        symbol: String::from_str(env, "ORIG"),
        decimals: 7,
        total_supply: 1_000_000,
        initial_supply: 1_000_000,
        max_supply: None,
        total_burned: 0,
        burn_count: 0,
        metadata_uri: Some(String::from_str(env, "ipfs://QmOriginal")),
        metadata_version: 1,
        created_at: env.ledger().timestamp(),
        is_paused: false,
        clawback_enabled: false,
        freeze_enabled: false,
    };
    storage::set_token_info(env, 0, &token_info);
    storage::set_token_info_by_address(env, &token_info.address, &token_info);
}

// ── initialize engages the lock ───────────────────────────────────────────────

/// `initialize` engages the metadata lock and records the ledger sequence.
#[test]
fn test_initialize_engages_metadata_lock() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| li.sequence_number = 4_242);

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    // Before initialization the lock is disengaged and unrecorded.
    assert!(!client.is_metadata_locked());
    assert_eq!(client.metadata_locked_at(), None);

    client.initialize(&admin, &treasury, &100i128, &50i128);

    // After initialization the lock is engaged and the ledger is recorded.
    assert!(client.is_metadata_locked());
    assert_eq!(client.metadata_locked_at(), Some(4_242));
}

// ── identity fields: mutable before lock ──────────────────────────────────────

/// Before the lock is engaged, the creator may update identity fields.
#[test]
fn test_identity_fields_mutable_before_lock() {
    let (env, contract_id, creator) = setup_unlocked();
    let client = TokenFactoryClient::new(&env, &contract_id);

    assert!(!client.is_metadata_locked());

    client.update_token_identity(
        &creator,
        &0u32,
        &String::from_str(&env, "RenamedToken"),
        &String::from_str(&env, "RENM"),
        &9u32,
    );

    let info = client.get_token_info(&0u32).unwrap();
    assert_eq!(info.name, String::from_str(&env, "RenamedToken"));
    assert_eq!(info.symbol, String::from_str(&env, "RENM"));
    assert_eq!(info.decimals, 9);
}

// ── identity fields: immutable after lock ─────────────────────────────────────

/// After the lock is engaged, identity updates are rejected and state is intact.
#[test]
fn test_identity_fields_immutable_after_lock() {
    let (env, contract_id, creator) = setup_unlocked();
    let client = TokenFactoryClient::new(&env, &contract_id);

    // Engage the lock, mirroring what `initialize` does in production.
    env.as_contract(&contract_id, || storage::set_metadata_locked(&env, true));
    assert!(client.is_metadata_locked());

    let result = client.try_update_token_identity(
        &creator,
        &0u32,
        &String::from_str(&env, "RenamedToken"),
        &String::from_str(&env, "RENM"),
        &9u32,
    );

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), Error::MetadataImmutable.into());

    // Original identity must be untouched.
    let info = client.get_token_info(&0u32).unwrap();
    assert_eq!(info.name, String::from_str(&env, "OriginalName"));
    assert_eq!(info.symbol, String::from_str(&env, "ORIG"));
    assert_eq!(info.decimals, 7);
}

/// A non-creator is rejected with `Unauthorized` before reaching the lock check.
#[test]
fn test_identity_update_rejects_non_creator() {
    let (env, contract_id, _creator) = setup_unlocked();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let attacker = Address::generate(&env);
    let result = client.try_update_token_identity(
        &attacker,
        &0u32,
        &String::from_str(&env, "Hijacked"),
        &String::from_str(&env, "HIJK"),
        &2u32,
    );

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized.into());
}

// ── metadata URI: governance-gated updates ────────────────────────────────────

/// A governance-approved metadata URI update succeeds and bumps the version.
#[test]
fn test_governance_metadata_update_succeeds() {
    let (env, contract_id, _creator) = setup_unlocked();
    let governance = Address::generate(&env);
    env.as_contract(&contract_id, || {
        storage::set_governance(&env, &governance);
        // Lock identity fields, as production always would.
        storage::set_metadata_locked(&env, true);
    });

    let client = TokenFactoryClient::new(&env, &contract_id);
    let new_version = client.governance_update_metadata(
        &0u32,
        &String::from_str(&env, "ipfs://QmGovApproved"),
    );

    assert_eq!(new_version, 2);
    let info = client.get_token_info(&0u32).unwrap();
    assert_eq!(
        info.metadata_uri,
        Some(String::from_str(&env, "ipfs://QmGovApproved"))
    );
    assert_eq!(info.metadata_version, 2);
}

/// Governance metadata updates fail when no governance contract is configured.
#[test]
fn test_governance_metadata_update_requires_governance() {
    let (env, contract_id, _creator) = setup_unlocked();
    // No governance configured.
    let client = TokenFactoryClient::new(&env, &contract_id);

    let result = client.try_governance_update_metadata(
        &0u32,
        &String::from_str(&env, "ipfs://QmNope"),
    );

    assert!(result.is_err());
    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized.into());
}
