//! Per-proposal-type timelock delay tests (issue #1361).
//!
//! Verifies that:
//! - Default delays are correctly applied per ActionType.
//! - The delay stored in a queued proposal matches the delay at queue time, not execution time.
//! - Execution is blocked until the stored delay (in ledgers) has elapsed.
//! - Custom delays can be set and are enforced independently per type.

#![cfg(test)]

use super::*;
use crate::governance;
use crate::timelock;
use crate::types::{ActionType, TimelockDelayConfig, VoteChoice};
use soroban_sdk::testutils::{Address as _, Ledger};
use soroban_sdk::{Address, Bytes, Env};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn setup() -> (Env, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &1_000_000, &500_000);

    env.as_contract(&contract_id, || {
        timelock::initialize_timelock(&env, Some(3_600)).unwrap();
        governance::initialize_governance(&env, Some(30), Some(51)).unwrap();
    });

    (env, contract_id, admin)
}

/// Create a proposal, advance time into voting, cast enough For votes, then
/// advance to end_time so it can be queued.  Returns (proposal_id, end_time, eta).
fn create_passing_proposal(
    env: &Env,
    contract_id: &Address,
    admin: &Address,
    action_type: ActionType,
) -> (u64, u64, u64) {
    let now = env.ledger().timestamp();
    let start = now + 100;
    let end = start + 86_400;
    let eta = end + 3_600;

    let payload = Bytes::new(env);

    let proposal_id = env.as_contract(contract_id, || {
        timelock::create_proposal(env, admin, action_type, payload, start, end, eta).unwrap()
    });

    // Advance into voting window
    env.ledger().with_mut(|li| li.timestamp = start + 1);

    let voter1 = Address::generate(env);
    let voter2 = Address::generate(env);

    env.as_contract(contract_id, || {
        timelock::vote_proposal(env, &voter1, proposal_id, VoteChoice::For).unwrap();
        timelock::vote_proposal(env, &voter2, proposal_id, VoteChoice::For).unwrap();
    });

    // Advance past end of voting
    env.ledger().with_mut(|li| li.timestamp = end);

    (proposal_id, end, eta)
}

// ── Default delay constants ───────────────────────────────────────────────────

#[test]
fn test_default_fee_change_delay_is_100_ledgers() {
    let (env, contract_id, admin) = setup();
    let (proposal_id, _end, _eta) = create_passing_proposal(
        &env, &contract_id, &admin, ActionType::FeeChange,
    );

    env.as_contract(&contract_id, || {
        timelock::queue_proposal(&env, proposal_id).unwrap();
        let p = timelock::get_proposal(&env, proposal_id).unwrap();
        assert_eq!(p.timelock_delay, 100, "FeeChange default delay should be 100 ledgers");
    });
}

#[test]
fn test_default_admin_transfer_delay_is_1000_ledgers() {
    let (env, contract_id, admin) = setup();
    let (proposal_id, _end, _eta) = create_passing_proposal(
        &env, &contract_id, &admin, ActionType::TreasuryChange,
    );

    env.as_contract(&contract_id, || {
        timelock::queue_proposal(&env, proposal_id).unwrap();
        let p = timelock::get_proposal(&env, proposal_id).unwrap();
        assert_eq!(p.timelock_delay, 1_000, "TreasuryChange default delay should be 1000 ledgers");
    });
}

#[test]
fn test_default_upgrade_delay_is_5000_ledgers() {
    let (env, contract_id, admin) = setup();
    let (proposal_id, _end, _eta) = create_passing_proposal(
        &env, &contract_id, &admin, ActionType::ParameterChange,
    );

    env.as_contract(&contract_id, || {
        timelock::queue_proposal(&env, proposal_id).unwrap();
        let p = timelock::get_proposal(&env, proposal_id).unwrap();
        assert_eq!(p.timelock_delay, 5_000, "ParameterChange default delay should be 5000 ledgers");
    });
}

#[test]
fn test_default_pause_delay_is_100_ledgers() {
    let (env, contract_id, admin) = setup();
    let (proposal_id, _end, _eta) = create_passing_proposal(
        &env, &contract_id, &admin, ActionType::PauseContract,
    );

    env.as_contract(&contract_id, || {
        timelock::queue_proposal(&env, proposal_id).unwrap();
        let p = timelock::get_proposal(&env, proposal_id).unwrap();
        assert_eq!(p.timelock_delay, 100, "PauseContract default delay should be 100 ledgers");
    });
}

// ── Delay captured at queue time, not execution time ─────────────────────────

#[test]
fn test_delay_stored_at_queue_time_not_execution_time() {
    let (env, contract_id, admin) = setup();
    let (proposal_id, _end, _eta) = create_passing_proposal(
        &env, &contract_id, &admin, ActionType::FeeChange,
    );

    // Queue at default config (delay = 100)
    env.as_contract(&contract_id, || {
        timelock::queue_proposal(&env, proposal_id).unwrap();
        let p = timelock::get_proposal(&env, proposal_id).unwrap();
        assert_eq!(p.timelock_delay, 100);
    });

    // Now change the config so FeeChange delay would be 999
    env.as_contract(&contract_id, || {
        timelock::set_timelock_delay_config(
            &env,
            &TimelockDelayConfig {
                fee_change_delay: 999,
                admin_transfer_delay: 1_000,
                upgrade_delay: 5_000,
                default_delay: 100,
            },
        ).unwrap();
    });

    // The stored delay on the already-queued proposal must still be 100 (captured at queue time)
    env.as_contract(&contract_id, || {
        let p = timelock::get_proposal(&env, proposal_id).unwrap();
        assert_eq!(
            p.timelock_delay, 100,
            "delay must reflect config at queue time, not current config"
        );
    });
}

// ── Execution blocked until delay elapses ────────────────────────────────────

#[test]
fn test_fee_change_execution_blocked_before_delay() {
    let (env, contract_id, admin) = setup();
    let (proposal_id, _end, eta) = create_passing_proposal(
        &env, &contract_id, &admin, ActionType::FeeChange,
    );

    let queue_ledger = env.as_contract(&contract_id, || {
        timelock::queue_proposal(&env, proposal_id).unwrap();
        env.ledger().sequence()
    });

    // Advance time past eta so timestamp check passes
    env.ledger().with_mut(|li| li.timestamp = eta + 1);

    // Advance ledger by only 99 (delay = 100, need >= 100 elapsed)
    env.ledger().with_mut(|li| li.sequence = queue_ledger + 99);

    let result = env.as_contract(&contract_id, || {
        timelock::execute_proposal(&env, proposal_id)
    });

    assert!(result.is_err(), "should be blocked: only 99 of 100 required ledgers elapsed");
}

#[test]
fn test_fee_change_execution_allowed_after_delay() {
    let (env, contract_id, admin) = setup();
    let (proposal_id, _end, eta) = create_passing_proposal(
        &env, &contract_id, &admin, ActionType::FeeChange,
    );

    let queue_ledger = env.as_contract(&contract_id, || {
        timelock::queue_proposal(&env, proposal_id).unwrap();
        env.ledger().sequence()
    });

    // Advance time past eta
    env.ledger().with_mut(|li| li.timestamp = eta + 1);

    // Advance ledger by exactly delay (100)
    env.ledger().with_mut(|li| li.sequence = queue_ledger + 100);

    let result = env.as_contract(&contract_id, || {
        timelock::execute_proposal(&env, proposal_id)
    });

    assert!(result.is_ok(), "should be allowed after exactly 100 ledgers: {:?}", result.err());
}

#[test]
fn test_treasury_change_requires_1000_ledger_delay() {
    let (env, contract_id, admin) = setup();
    let (proposal_id, _end, eta) = create_passing_proposal(
        &env, &contract_id, &admin, ActionType::TreasuryChange,
    );

    let queue_ledger = env.as_contract(&contract_id, || {
        timelock::queue_proposal(&env, proposal_id).unwrap();
        env.ledger().sequence()
    });

    env.ledger().with_mut(|li| li.timestamp = eta + 1);

    // 999 ledgers — one short of required 1000
    env.ledger().with_mut(|li| li.sequence = queue_ledger + 999);
    let result_short = env.as_contract(&contract_id, || {
        timelock::execute_proposal(&env, proposal_id)
    });
    assert!(result_short.is_err(), "should block at 999 ledgers for TreasuryChange");

    // Exactly 1000 ledgers — should succeed
    env.ledger().with_mut(|li| li.sequence = queue_ledger + 1000);
    let result_ok = env.as_contract(&contract_id, || {
        timelock::execute_proposal(&env, proposal_id)
    });
    assert!(result_ok.is_ok(), "should allow at 1000 ledgers for TreasuryChange: {:?}", result_ok.err());
}

#[test]
fn test_upgrade_requires_5000_ledger_delay() {
    let (env, contract_id, admin) = setup();
    let (proposal_id, _end, eta) = create_passing_proposal(
        &env, &contract_id, &admin, ActionType::ParameterChange,
    );

    let queue_ledger = env.as_contract(&contract_id, || {
        timelock::queue_proposal(&env, proposal_id).unwrap();
        env.ledger().sequence()
    });

    env.ledger().with_mut(|li| li.timestamp = eta + 1);

    // 4999 — one short
    env.ledger().with_mut(|li| li.sequence = queue_ledger + 4_999);
    let result_short = env.as_contract(&contract_id, || {
        timelock::execute_proposal(&env, proposal_id)
    });
    assert!(result_short.is_err(), "should block at 4999 ledgers for upgrade");

    // Exactly 5000
    env.ledger().with_mut(|li| li.sequence = queue_ledger + 5_000);
    let result_ok = env.as_contract(&contract_id, || {
        timelock::execute_proposal(&env, proposal_id)
    });
    assert!(result_ok.is_ok(), "should allow at 5000 ledgers for upgrade: {:?}", result_ok.err());
}

// ── Custom delay config ───────────────────────────────────────────────────────

#[test]
fn test_custom_delay_config_is_enforced() {
    let (env, contract_id, admin) = setup();

    // Override defaults before queuing
    env.as_contract(&contract_id, || {
        timelock::set_timelock_delay_config(
            &env,
            &TimelockDelayConfig {
                fee_change_delay: 50,
                admin_transfer_delay: 200,
                upgrade_delay: 500,
                default_delay: 10,
            },
        ).unwrap();
    });

    let (proposal_id, _end, eta) = create_passing_proposal(
        &env, &contract_id, &admin, ActionType::FeeChange,
    );

    let queue_ledger = env.as_contract(&contract_id, || {
        timelock::queue_proposal(&env, proposal_id).unwrap();
        let p = timelock::get_proposal(&env, proposal_id).unwrap();
        assert_eq!(p.timelock_delay, 50, "custom fee_change_delay should be 50");
        env.ledger().sequence()
    });

    env.ledger().with_mut(|li| li.timestamp = eta + 1);

    // 49 ledgers — short
    env.ledger().with_mut(|li| li.sequence = queue_ledger + 49);
    assert!(
        env.as_contract(&contract_id, || timelock::execute_proposal(&env, proposal_id)).is_err()
    );

    // 50 ledgers — OK
    env.ledger().with_mut(|li| li.sequence = queue_ledger + 50);
    assert!(
        env.as_contract(&contract_id, || timelock::execute_proposal(&env, proposal_id)).is_ok()
    );
}

#[test]
fn test_invalid_zero_delay_rejected() {
    let (env, contract_id, _admin) = setup();

    let result = env.as_contract(&contract_id, || {
        timelock::set_timelock_delay_config(
            &env,
            &TimelockDelayConfig {
                fee_change_delay: 0,
                admin_transfer_delay: 1_000,
                upgrade_delay: 5_000,
                default_delay: 100,
            },
        )
    });

    assert!(result.is_err(), "zero delay should be rejected");
}
