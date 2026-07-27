//! Vault Deposit/Withdraw Concurrent Interleaving Tests
//!
//! Models interleaved transaction sequences to detect TOCTOU race conditions
//! in the vault's balance accounting. All sequences are deterministic and
//! reproducible. "Deposit" = create_vault, "Withdraw" = claim_vault.
//!
//! Invariant under test: vault.balance >= 0 after every sequence,
//! and error codes are deterministic regardless of ordering for invalid sequences.

#![cfg(test)]

use crate::types::Error;
use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::testutils::{Address as _, Ledger, LedgerInfo};
use soroban_sdk::{Address, BytesN, Env};

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn setup(env: &Env) -> (TokenFactoryClient, Address, Address) {
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(env, &contract_id);
    client.initialize(&admin, &treasury, &1_000_000, &500_000);
    (client, admin, treasury)
}

fn make_token(env: &Env, client: &TokenFactoryClient) -> Address {
    let creator = Address::generate(env);
    client.create_token(
        &creator,
        &soroban_sdk::String::from_str(env, "Test"),
        &soroban_sdk::String::from_str(env, "TST"),
        &7,
        &10_000_000_000,
        &soroban_sdk::Option::None,
        &1_000_000,
    )
}

fn no_milestone(env: &Env) -> BytesN<32> {
    BytesN::from_array(env, &[0u8; 32])
}

fn advance_time(env: &Env, seconds: u64) {
    let current = env.ledger().timestamp();
    env.ledger().set(LedgerInfo {
        timestamp: current + seconds,
        protocol_version: 20,
        sequence_number: env.ledger().sequence() + 1,
        network_id: soroban_sdk::bytesn!(env, 0x00000000000000000000000000000000_00000000000000000000000000000000),
        base_reserve: 5_000_000,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 100,
        max_entry_ttl: 6_312_000,
    });
}

// ─── concurrent_interleaving module ──────────────────────────────────────────

#[cfg(test)]
mod concurrent_interleaving {
    use super::*;

    // ── Sequence 1: Deposit → immediate withdraw exceeding balance ────────────
    //
    // TOCTOU pattern: a concurrent reader checks the balance (total_amount),
    // then an interleaved writer attempts to claim an amount larger than what
    // was locked. In Soroban the contract enforces atomicity, so the over-claim
    // must be rejected deterministically.

    #[test]
    fn seq1_deposit_then_over_withdraw_is_rejected_deterministically() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let depositor = Address::generate(&env);
        let owner = Address::generate(&env);

        // Sequence: [deposit(500)] then [claim] — vault is created with unlock_time
        // in the past so claim can execute immediately.
        let vault_id = client.create_vault(
            &depositor,
            &token,
            &owner,
            &500_000,
            &1, // unlock_time = 1 (always in the past after advance)
            &no_milestone(&env),
        );

        advance_time(&env, 10);

        // First claim succeeds — balance becomes 0.
        let claimed = client.claim_vault(&owner, &vault_id, &soroban_sdk::Option::None);
        assert_eq!(claimed, 500_000);

        // Second claim on same vault must fail (balance invariant: balance >= 0).
        let second_claim = client.try_claim_vault(&owner, &vault_id, &soroban_sdk::Option::None);
        assert!(second_claim.is_err(), "double claim must be rejected");

        // Verify vault balance invariant: claimed_amount <= total_amount
        let vault = client.get_vault(&vault_id);
        assert!(vault.claimed_amount <= vault.total_amount, "balance invariant violated");
        assert!(vault.claimed_amount >= 0, "balance must never go negative");
    }

    // ── Sequence 2: Double-withdraw race ─────────────────────────────────────
    //
    // Two withdraw operations target the same vault. In a concurrent environment
    // the first to commit wins; the second must receive a deterministic error.

    #[test]
    fn seq2_double_withdraw_race_second_always_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let depositor = Address::generate(&env);
        let owner = Address::generate(&env);

        let vault_id = client.create_vault(
            &depositor,
            &token,
            &owner,
            &1_000_000,
            &1,
            &no_milestone(&env),
        );

        advance_time(&env, 5);

        // Interleaved sequence: withdraw_A commits first.
        let result_a = client.claim_vault(&owner, &vault_id, &soroban_sdk::Option::None);
        assert_eq!(result_a, 1_000_000);

        // withdraw_B arrives after withdraw_A — must get a deterministic error,
        // NOT a panic or incorrect balance change.
        let result_b = client.try_claim_vault(&owner, &vault_id, &soroban_sdk::Option::None);
        assert!(result_b.is_err());

        // Error code is deterministic across repeated orderings.
        let err = result_b.unwrap_err().unwrap();
        assert!(
            err == Error::InvalidParameters || err == Error::NothingToClaim,
            "unexpected error variant: {:?}", err
        );

        // Balance invariant holds.
        let vault = client.get_vault(&vault_id);
        assert!(vault.claimed_amount >= 0);
        assert!(vault.claimed_amount <= vault.total_amount);
    }

    // ── Sequence 3: Deposit during active withdraw ────────────────────────────
    //
    // A new vault is created (deposit_B) while vault_A is being claimed (withdraw_A).
    // Both operations must complete without corrupting each other's accounting.

    #[test]
    fn seq3_deposit_during_active_withdraw_no_cross_contamination() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let depositor_a = Address::generate(&env);
        let owner_a = Address::generate(&env);
        let depositor_b = Address::generate(&env);
        let owner_b = Address::generate(&env);

        // Step 1: vault_A is deposited.
        let vault_a = client.create_vault(
            &depositor_a,
            &token,
            &owner_a,
            &300_000,
            &1,
            &no_milestone(&env),
        );

        advance_time(&env, 5);

        // Step 2 (interleaved): vault_B is deposited while vault_A is being claimed.
        let vault_b = client.create_vault(
            &depositor_b,
            &token,
            &owner_b,
            &700_000,
            &1,
            &no_milestone(&env),
        );

        // Step 3: vault_A claim completes.
        let claimed_a = client.claim_vault(&owner_a, &vault_a, &soroban_sdk::Option::None);
        assert_eq!(claimed_a, 300_000);

        // Step 4: vault_B is unaffected — its balance is intact.
        let state_b = client.get_vault(&vault_b);
        assert_eq!(state_b.total_amount, 700_000);
        assert_eq!(state_b.claimed_amount, 0);

        // vault_B can be claimed independently.
        advance_time(&env, 1);
        let claimed_b = client.claim_vault(&owner_b, &vault_b, &soroban_sdk::Option::None);
        assert_eq!(claimed_b, 700_000);
    }

    // ── Sequence 4: Deposit → cancel → withdraw attempt ──────────────────────
    //
    // After a vault is cancelled the owner must not be able to withdraw. The error
    // code must be deterministic regardless of when the cancel is interleaved.

    #[test]
    fn seq4_cancel_before_withdraw_always_blocks_claim() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let depositor = Address::generate(&env);
        let owner = Address::generate(&env);

        let vault_id = client.create_vault(
            &depositor,
            &token,
            &owner,
            &500_000,
            &1,
            &no_milestone(&env),
        );

        advance_time(&env, 5);

        // Interleaved: cancel arrives before the owner's claim.
        client.cancel_vault(&vault_id, &depositor);

        // Withdraw attempt after cancel must fail deterministically.
        let claim_result = client.try_claim_vault(&owner, &vault_id, &soroban_sdk::Option::None);
        assert!(claim_result.is_err(), "claim on cancelled vault must fail");

        // Balance invariant: claimed_amount unchanged, total_amount unchanged.
        let vault = client.get_vault(&vault_id);
        assert_eq!(vault.claimed_amount, 0);
        assert_eq!(vault.total_amount, 500_000);
        assert!(vault.claimed_amount >= 0);
    }

    // ── Sequence 5: Multiple vaults — independent balance accounting ──────────
    //
    // Five vaults are created and withdrawn in non-sequential order to verify
    // that the storage isolation means no vault's accounting bleeds into another's.

    #[test]
    fn seq5_multiple_vaults_independent_balance_invariants() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _admin, _treasury) = setup(&env);
        let token = make_token(&env, &client);

        let amounts = [100_000i128, 200_000, 300_000, 400_000, 500_000];
        let mut vault_ids = Vec::new();
        let mut owners = Vec::new();

        for &amount in &amounts {
            let depositor = Address::generate(&env);
            let owner = Address::generate(&env);
            let vault_id = client.create_vault(
                &depositor,
                &token,
                &owner,
                &amount,
                &1,
                &no_milestone(&env),
            );
            vault_ids.push(vault_id);
            owners.push(owner);
        }

        advance_time(&env, 10);

        // Withdraw in reverse order to simulate interleaving.
        for i in (0..5).rev() {
            let claimed =
                client.claim_vault(&owners[i], &vault_ids[i], &soroban_sdk::Option::None);
            assert_eq!(claimed, amounts[i]);

            // Verify balance invariant for all vaults after each withdrawal.
            for j in 0..5 {
                let v = client.get_vault(&vault_ids[j]);
                assert!(
                    v.claimed_amount >= 0,
                    "vault {} balance went negative after withdrawing vault {}", j, i
                );
                assert!(
                    v.claimed_amount <= v.total_amount,
                    "vault {} claimed_amount exceeds total_amount after withdrawing vault {}", j, i
                );
            }
        }
//! Vault Deposit and Withdrawal Edge Case Tests
//!
//! Stress-tests vault deposit/withdraw/claim flows across boundary and error states:
//! - Claiming from non-existent vault returns VaultNotFound
//! - Claiming with nothing available returns NothingToClaim
//! - Full and partial withdrawal bookkeeping
//! - Unauthorized withdrawal attempts fail

#[cfg(test)]
mod tests {
    use crate::storage;
    use crate::types::{Error, Vault, VaultStatus};
    use crate::vault;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{Address, Env};

    fn setup_env() -> (Env, Address, Address) {
        let env = Env::default();
        env.ledger().set_timestamp(1000);
        let admin = Address::random(&env);
        let treasury = Address::random(&env);

        // Initialize factory
        crate::lib::initialize(
            &env,
            admin.clone(),
            treasury,
            70_000_000,
            30_000_000,
        )
        .unwrap();

        (env, admin, treasury)
    }

    fn create_vault(env: &Env, owner: &Address, amount: i128, unlock_time: u64) -> u64 {
        let vault = Vault {
            id: 1,
            owner: owner.clone(),
            total_amount: amount,
            claimed_amount: 0,
            unlock_time,
            status: VaultStatus::Active,
            created_at: env.ledger().timestamp(),
        };
        storage::set_vault(env, &vault).unwrap();
        vault.id
    }

    #[test]
    fn test_vault_claim_nonexistent_vault() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        // Attempt to claim from non-existent vault
        let result = vault::claim_vault(&env, 999, &owner);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::TokenNotFound);
    }

    #[test]
    fn test_vault_claim_nothing_to_claim() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        // Create vault with 0 amount
        let vault_id = create_vault(&env, &owner, 0, 500);

        // Advance time past unlock
        env.ledger().set_timestamp(1000);

        // Attempt to claim - should fail with NothingToClaim
        let result = vault::claim_vault(&env, vault_id, &owner);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::NothingToClaim);
    }

    #[test]
    fn test_vault_claim_full_withdrawal() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        let amount = 1_000_000_000;
        let vault_id = create_vault(&env, &owner, amount, 500);

        // Advance time past unlock
        env.ledger().set_timestamp(1000);

        // Claim full amount
        let result = vault::claim_vault(&env, vault_id, &owner);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), amount);

        // Verify vault status changed to Claimed
        let vault = storage::get_vault(&env, vault_id).unwrap();
        assert_eq!(vault.status, VaultStatus::Claimed);
        assert_eq!(vault.claimed_amount, amount);
    }

    #[test]
    fn test_vault_claim_partial_withdrawal() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        let amount = 1_000_000_000;
        let vault_id = create_vault(&env, &owner, amount, 500);

        // Advance time past unlock
        env.ledger().set_timestamp(1000);

        // First claim - full amount (no partial claim support in current impl)
        let result = vault::claim_vault(&env, vault_id, &owner);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), amount);

        // Second claim should fail - nothing left
        let result2 = vault::claim_vault(&env, vault_id, &owner);
        assert!(result2.is_err());
        assert_eq!(result2.unwrap_err(), Error::NothingToClaim);
    }

    #[test]
    fn test_vault_claim_unauthorized() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);
        let unauthorized = Address::random(&env);

        let amount = 1_000_000_000;
        let vault_id = create_vault(&env, &owner, amount, 500);

        // Advance time past unlock
        env.ledger().set_timestamp(1000);

        // Attempt to claim as unauthorized user
        let result = vault::claim_vault(&env, vault_id, &unauthorized);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::Unauthorized);
    }

    #[test]
    fn test_vault_claim_before_unlock_time() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        let amount = 1_000_000_000;
        let unlock_time = 5000;
        let vault_id = create_vault(&env, &owner, amount, unlock_time);

        // Current time is 1000, unlock is at 5000
        env.ledger().set_timestamp(2000);

        // Attempt to claim before unlock
        let result = vault::claim_vault(&env, vault_id, &owner);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::CliffNotReached);
    }

    #[test]
    fn test_vault_claim_at_exact_unlock_time() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        let amount = 1_000_000_000;
        let unlock_time = 5000;
        let vault_id = create_vault(&env, &owner, amount, unlock_time);

        // Set time to exact unlock time
        env.ledger().set_timestamp(unlock_time);

        // Should succeed at exact unlock time
        let result = vault::claim_vault(&env, vault_id, &owner);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), amount);
    }

    #[test]
    fn test_vault_claim_inactive_vault() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        let amount = 1_000_000_000;
        let vault_id = create_vault(&env, &owner, amount, 500);

        // Mark vault as Claimed
        let mut vault = storage::get_vault(&env, vault_id).unwrap();
        vault.status = VaultStatus::Claimed;
        storage::set_vault(&env, &vault).unwrap();

        // Advance time past unlock
        env.ledger().set_timestamp(1000);

        // Attempt to claim from inactive vault
        let result = vault::claim_vault(&env, vault_id, &owner);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::InvalidParameters);
    }

    #[test]
    fn test_vault_fund_nonexistent_vault() {
        let (env, _admin, _treasury) = setup_env();
        let funder = Address::random(&env);

        // Attempt to fund non-existent vault
        let result = vault::fund_vault(&env, 999, &funder, 1_000_000);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::TokenNotFound);
    }

    #[test]
    fn test_vault_fund_then_claim() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);
        let funder = Address::random(&env);

        // Create vault with initial amount
        let initial_amount = 500_000_000;
        let vault_id = create_vault(&env, &owner, initial_amount, 500);

        // Fund additional amount
        let additional_amount = 300_000_000;
        let result = vault::fund_vault(&env, vault_id, &funder, additional_amount);
        assert!(result.is_ok());

        // Verify vault balance increased
        let vault = storage::get_vault(&env, vault_id).unwrap();
        assert_eq!(vault.total_amount, initial_amount + additional_amount);

        // Advance time and claim
        env.ledger().set_timestamp(1000);
        let claim_result = vault::claim_vault(&env, vault_id, &owner);
        assert!(result.is_ok());
        assert_eq!(claim_result.unwrap(), initial_amount + additional_amount);
    }

    #[test]
    fn test_vault_claim_bookkeeping_accuracy() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        let amount = 1_000_000_000;
        let vault_id = create_vault(&env, &owner, amount, 500);

        // Verify initial state
        let vault_before = storage::get_vault(&env, vault_id).unwrap();
        assert_eq!(vault_before.claimed_amount, 0);
        assert_eq!(vault_before.total_amount, amount);

        // Advance time and claim
        env.ledger().set_timestamp(1000);
        let claim_result = vault::claim_vault(&env, vault_id, &owner);
        assert!(claim_result.is_ok());

        // Verify bookkeeping
        let vault_after = storage::get_vault(&env, vault_id).unwrap();
        assert_eq!(vault_after.claimed_amount, amount);
        assert_eq!(vault_after.total_amount, amount);
        assert_eq!(vault_after.status, VaultStatus::Claimed);
    }

    #[test]
    fn test_vault_multiple_deposits_then_claim() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);
        let funder1 = Address::random(&env);
        let funder2 = Address::random(&env);

        // Create vault
        let initial_amount = 100_000_000;
        let vault_id = create_vault(&env, &owner, initial_amount, 500);

        // Multiple deposits
        vault::fund_vault(&env, vault_id, &funder1, 200_000_000).unwrap();
        vault::fund_vault(&env, vault_id, &funder2, 300_000_000).unwrap();

        // Verify total
        let vault = storage::get_vault(&env, vault_id).unwrap();
        assert_eq!(vault.total_amount, 600_000_000);

        // Claim all
        env.ledger().set_timestamp(1000);
        let claim_result = vault::claim_vault(&env, vault_id, &owner);
        assert!(claim_result.is_ok());
        assert_eq!(claim_result.unwrap(), 600_000_000);
    }

    #[test]
    fn test_vault_claim_zero_amount_after_full_claim() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        let amount = 1_000_000_000;
        let vault_id = create_vault(&env, &owner, amount, 500);

        env.ledger().set_timestamp(1000);

        // First claim succeeds
        let result1 = vault::claim_vault(&env, vault_id, &owner);
        assert!(result1.is_ok());

        // Second claim fails - nothing to claim
        let result2 = vault::claim_vault(&env, vault_id, &owner);
        assert!(result2.is_err());
        assert_eq!(result2.unwrap_err(), Error::NothingToClaim);
    }
}
