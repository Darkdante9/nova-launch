#![cfg(test)]

use crate::{TokenFactory, TokenFactoryClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &1_000_000, &500_000);

    (env, contract_id, admin, treasury)
}

#[test]
fn test_timelock_basic_setup() {
    let (_env, _contract_id, _admin, _treasury) = setup();
    // Basic test to verify setup works
}

// ── #1130: Timelock delay bounds ──────────────────────────────────────────

#[test]
fn test_timelock_delay_below_min_rejected() {
    // A delay of 0 (below MIN_TIMELOCK_DELAY = 3600) must be rejected.
    use crate::timelock::{initialize_timelock, MIN_TIMELOCK_DELAY};
    use crate::storage;

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);

    env.as_contract(&contract_id, || {
        storage::set_admin(&env, &Address::generate(&env));
        // below minimum
        let result = initialize_timelock(&env, Some(MIN_TIMELOCK_DELAY - 1));
        assert!(result.is_err());
        // exactly at minimum — must succeed
        let result = initialize_timelock(&env, Some(MIN_TIMELOCK_DELAY));
        assert!(result.is_ok());
    });
}

#[test]
fn test_timelock_delay_above_max_rejected() {
    // A delay above MAX_TIMELOCK_DELAY must be rejected.
    use crate::timelock::{initialize_timelock, MAX_TIMELOCK_DELAY};
    use crate::storage;

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);

    env.as_contract(&contract_id, || {
        storage::set_admin(&env, &Address::generate(&env));
        let result = initialize_timelock(&env, Some(MAX_TIMELOCK_DELAY + 1));
        assert!(result.is_err());
        // exactly at maximum — must succeed
        let result = initialize_timelock(&env, Some(MAX_TIMELOCK_DELAY));
        assert!(result.is_ok());
    });
}

#[test]
fn test_timelock_delay_in_range_accepted() {
    // A delay within [MIN, MAX] must succeed.
    use crate::timelock::{initialize_timelock, MAX_TIMELOCK_DELAY, MIN_TIMELOCK_DELAY};
    use crate::storage;

    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);

    env.as_contract(&contract_id, || {
        storage::set_admin(&env, &Address::generate(&env));
        let mid = (MIN_TIMELOCK_DELAY + MAX_TIMELOCK_DELAY) / 2;
        let result = initialize_timelock(&env, Some(mid));
        assert!(result.is_ok());
    });
}
