//! Vault Balance Invariant Property Tests (#1332)
//!
//! Invariant under test: `vault_balance == sum(deposits) - sum(withdrawals)`.
//!
//! This vault contract's API only exposes two operations:
//!   - `fund_vault` (deposit): adds `amount` to `vault.total_amount`. Rejects
//!     `amount <= 0` (`Error::InvalidAmount`) and overflow
//!     (`Error::ArithmeticError`) without mutating state — these are the
//!     "failed-deposit" cases.
//!   - `claim_vault` (withdraw): claims the *entire* outstanding balance in
//!     one call (there is no partial-withdraw amount parameter). Calling it
//!     when nothing is claimable returns `Error::NothingToClaim` without
//!     mutating state — this is the "failed-withdraw" case.
//!
//! The proptest below generates arbitrary sequences of 1-50 deposit/withdraw
//! operations (including amounts that are invalid or large enough to
//! overflow) against a single vault, and after *every* operation asserts:
//!   1. `vault.total_amount - vault.claimed_amount` equals an independently
//!      tracked `sum(successful deposits) - sum(successful withdrawals)`.
//!   2. Operations that return an error never change the vault's balance.

#![cfg(test)]

extern crate std;

use proptest::prelude::*;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::{Address, BytesN, Env};

use crate::storage;
use crate::types::{Vault, VaultStatus};
use crate::vault::{claim_vault, fund_vault};

const VAULT_ID: u64 = 1;

/// Seed a fresh vault: `Active`, immediately unlocked (`unlock_time = 0`), no
/// milestone gating, so `claim_vault` is governed purely by the deposit/claim
/// accounting this suite is testing — not by timing or milestone state.
fn seed_vault(env: &Env, owner: &Address) {
    let vault = Vault {
        id: VAULT_ID,
        token: Address::generate(env),
        owner: owner.clone(),
        creator: owner.clone(),
        total_amount: 0,
        claimed_amount: 0,
        unlock_time: 0,
        milestone_hash: BytesN::from_array(env, &[0u8; 32]),
        status: VaultStatus::Active,
        created_at: 0,
        verifier: None,
        milestone_verified: false,
    };
    storage::set_vault(env, &vault).unwrap();
}

fn balance(env: &Env, vault_id: u64) -> i128 {
    let vault = storage::get_vault(env, vault_id).unwrap();
    vault.total_amount - vault.claimed_amount
}

/// `Deposit` maps to `fund_vault`. Amounts are drawn from three ranges so a
/// single sequence naturally exercises: ordinary positive deposits, invalid
/// amounts (<= 0, the "failed-deposit" path), and amounts large enough to
/// overflow `total_amount` once it's already large (the overflow
/// "failed-deposit" path). `Withdraw` maps to `claim_vault`, which claims the
/// entire outstanding balance — calling it with nothing outstanding is the
/// "failed-withdraw" path.
#[derive(Clone, Copy, Debug)]
enum Operation {
    Deposit(i128),
    Withdraw,
}

fn operation_strategy() -> impl Strategy<Value = Operation> {
    prop_oneof![
        5 => (-1_000i128..=500_000_000i128).prop_map(Operation::Deposit),
        1 => (i128::MAX - 1_000_000i128..=i128::MAX).prop_map(Operation::Deposit),
        4 => Just(Operation::Withdraw),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(500))]

    /// Property: after every operation in an arbitrary 1..=50-length sequence
    /// of deposits/withdrawals (including invalid/overflowing ones),
    /// `vault_balance == sum(deposits) - sum(withdrawals)`, and failed
    /// operations never move the balance.
    #[test]
    fn prop_vault_balance_invariant_holds_across_operation_sequences(
        ops in prop::collection::vec(operation_strategy(), 1..=50)
    ) {
        let env = Env::default();
        env.mock_all_auths();

        let owner = Address::generate(&env);
        let funder = Address::generate(&env);
        seed_vault(&env, &owner);

        let mut total_deposited: i128 = 0;
        let mut total_withdrawn: i128 = 0;

        for (step, op) in ops.iter().enumerate() {
            let balance_before = balance(&env, VAULT_ID);

            match *op {
                Operation::Deposit(amount) => {
                    let result = fund_vault(&env, VAULT_ID, &funder, amount);
                    match result {
                        Ok(()) => {
                            prop_assert!(
                                amount > 0,
                                "step={step}: fund_vault succeeded with non-positive amount {amount}"
                            );
                            total_deposited += amount;
                        }
                        Err(_) => {
                            // Failed deposit (invalid amount or overflow) — total_deposited
                            // unchanged, so the invariant check below also asserts no
                            // side effect on the vault's stored balance.
                        }
                    }
                }
                Operation::Withdraw => {
                    let result = claim_vault(&env, VAULT_ID, &owner);
                    match result {
                        Ok(claimed) => {
                            prop_assert!(
                                claimed > 0,
                                "step={step}: claim_vault returned non-positive claimed amount {claimed}"
                            );
                            prop_assert_eq!(
                                claimed, balance_before,
                                "step={step}: claimed amount did not equal the outstanding balance"
                            );
                            total_withdrawn += claimed;
                        }
                        Err(_) => {
                            // Failed withdraw (nothing claimable) — total_withdrawn unchanged.
                        }
                    }
                }
            }

            let balance_after = balance(&env, VAULT_ID);
            let expected = total_deposited - total_withdrawn;
            prop_assert_eq!(
                balance_after, expected,
                "step={step} op={op:?}: vault_balance ({balance_after}) != sum(deposits) - sum(withdrawals) ({expected}); balance_before={balance_before}"
            );
        }
    }
}
