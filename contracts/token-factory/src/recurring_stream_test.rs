#![cfg(test)]

use crate::{recurring_stream, storage, types::RecurringStreamParams, TokenFactory, TokenFactoryClient};
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup() -> (Env, TokenFactoryClient, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    client.initialize(&admin, &treasury, &1_000_000, &500_000);

    (env, client, admin, treasury)
}

#[test]
fn test_period_to_period_progression_creates_child_streams() {
    let (env, _client, _admin, _treasury) = setup();

    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        let params = RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: 1_000_000i128,
            period_ledgers: 1_000u64,
            total_periods: 3u32,
            auto_renew: false,
        };

        let recurring_id = recurring_stream::create_recurring_stream(&env, &creator, &params).unwrap();

        // Verify first period was created
        let stream = storage::get_recurring_stream(&env, recurring_id).unwrap();
        assert_eq!(stream.periods_created, 1);
        assert_eq!(stream.child_streams.len(), 1);

        // Advance to end of first period
        env.ledger().with_mut(|li| li.sequence = 1_001);

        // Tick to create second period
        let second_child = recurring_stream::tick_recurring_stream(&env, recurring_id).unwrap();
        assert!(second_child.is_some());

        let stream = storage::get_recurring_stream(&env, recurring_id).unwrap();
        assert_eq!(stream.periods_created, 2);
        assert_eq!(stream.child_streams.len(), 2);

        // Advance to end of second period
        env.ledger().with_mut(|li| li.sequence = 2_001);

        // Tick to create third period
        let third_child = recurring_stream::tick_recurring_stream(&env, recurring_id).unwrap();
        assert!(third_child.is_some());

        let stream = storage::get_recurring_stream(&env, recurring_id).unwrap();
        assert_eq!(stream.periods_created, 3);
        assert_eq!(stream.child_streams.len(), 3);

        // Advance past third period
        env.ledger().with_mut(|li| li.sequence = 3_001);

        // Should not create fourth period (total_periods = 3)
        let no_child = recurring_stream::tick_recurring_stream(&env, recurring_id).unwrap();
        assert!(no_child.is_none());

        let stream = storage::get_recurring_stream(&env, recurring_id).unwrap();
        assert_eq!(stream.periods_created, 3, "Should not create period beyond total_periods");
    });
}

#[test]
fn test_cancellation_mid_period_leaves_current_period_claimable() {
    let (env, _client, _admin, _treasury) = setup();

    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        let params = RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: 1_000_000i128,
            period_ledgers: 1_000u64,
            total_periods: 5u32,
            auto_renew: false,
        };

        let recurring_id = recurring_stream::create_recurring_stream(&env, &creator, &params).unwrap();

        // Verify first child stream was created
        let stream = storage::get_recurring_stream(&env, recurring_id).unwrap();
        assert_eq!(stream.child_streams.len(), 1);
        let first_child_id = stream.child_streams.get(0).unwrap();

        // Advance to middle of first period
        env.ledger().with_mut(|li| li.sequence = 500);

        // Cancel the recurring stream mid-period
        recurring_stream::cancel_recurring_stream(&env, &creator, recurring_id).unwrap();

        // Verify stream is marked as cancelled
        let stream = storage::get_recurring_stream(&env, recurring_id).unwrap();
        assert!(stream.cancelled);
        assert!(!stream.auto_renew_enabled);

        // First child stream should still be claimable (vault still exists)
        let vault = storage::get_vault(&env, first_child_id).unwrap();
        assert_eq!(vault.total_amount, 1_000_000i128);

        // Advance to end of first period
        env.ledger().with_mut(|li| li.sequence = 1_001);

        // Tick should not create a new period (stream is cancelled)
        let no_new_period = recurring_stream::tick_recurring_stream(&env, recurring_id).unwrap();
        assert!(no_new_period.is_none());

        let stream = storage::get_recurring_stream(&env, recurring_id).unwrap();
        assert_eq!(stream.periods_created, 1, "No new periods should be created after cancellation");
    });
}

#[test]
fn test_auto_renewal_stops_at_configured_total_periods() {
    let (env, _client, _admin, _treasury) = setup();

    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        let params = RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: 1_000_000i128,
            period_ledgers: 1_000u64,
            total_periods: 2u32,
            auto_renew: false,
        };

        let recurring_id = recurring_stream::create_recurring_stream(&env, &creator, &params).unwrap();

        let mut stream = storage::get_recurring_stream(&env, recurring_id).unwrap();
        assert_eq!(stream.periods_created, 1);

        // Advance to end of first period
        env.ledger().with_mut(|li| li.sequence = 1_001);

        recurring_stream::tick_recurring_stream(&env, recurring_id).unwrap();

        stream = storage::get_recurring_stream(&env, recurring_id).unwrap();
        assert_eq!(stream.periods_created, 2);

        // Advance to end of second period
        env.ledger().with_mut(|li| li.sequence = 2_001);

        // Attempt to create third period (should fail - total_periods = 2)
        let no_third = recurring_stream::tick_recurring_stream(&env, recurring_id).unwrap();
        assert!(no_third.is_none());

        stream = storage::get_recurring_stream(&env, recurring_id).unwrap();
        assert_eq!(stream.periods_created, 2, "Should not exceed total_periods");
    });
}

#[test]
fn test_admin_cancellation_disables_auto_renewal_without_affecting_in_progress_periods() {
    let (env, client, admin, _treasury) = setup();

    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        let params = RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: 1_000_000i128,
            period_ledgers: 1_000u64,
            total_periods: 0u32, // Unlimited with auto-renew
            auto_renew: true,
        };

        let recurring_id = recurring_stream::create_recurring_stream(&env, &creator, &params).unwrap();

        let stream = storage::get_recurring_stream(&env, recurring_id).unwrap();
        assert_eq!(stream.periods_created, 1);
        let first_child = stream.child_streams.get(0).unwrap();

        // Verify auto-renewal is enabled
        assert!(stream.auto_renew_enabled);

        // Admin cancels the recurring stream
        recurring_stream::cancel_recurring_stream(&env, &admin, recurring_id).unwrap();

        let stream = storage::get_recurring_stream(&env, recurring_id).unwrap();
        assert!(stream.cancelled);
        assert!(!stream.auto_renew_enabled);

        // First child stream (in-progress period) should still exist and be claimable
        let vault = storage::get_vault(&env, first_child).unwrap();
        assert_eq!(vault.total_amount, 1_000_000i128);

        // No new periods should be created
        env.ledger().with_mut(|li| li.sequence = 1_001);
        let no_new = recurring_stream::tick_recurring_stream(&env, recurring_id).unwrap();
        assert!(no_new.is_none());
    });
}

#[test]
fn test_disable_auto_renewal_stops_future_periods() {
    let (env, _client, _admin, _treasury) = setup();

    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        let params = RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: 1_000_000i128,
            period_ledgers: 1_000u64,
            total_periods: 0u32, // Unlimited with auto-renew
            auto_renew: true,
        };

        let recurring_id = recurring_stream::create_recurring_stream(&env, &creator, &params).unwrap();

        let stream = storage::get_recurring_stream(&env, recurring_id).unwrap();
        assert!(stream.auto_renew_enabled);
        assert_eq!(stream.periods_created, 1);

        // Disable auto-renewal
        recurring_stream::disable_auto_renewal(&env, &creator, recurring_id).unwrap();

        let stream = storage::get_recurring_stream(&env, recurring_id).unwrap();
        assert!(!stream.auto_renew_enabled, "Auto-renewal should be disabled");
        assert!(!stream.cancelled, "Stream should not be marked as cancelled");

        // Advance to end of first period
        env.ledger().with_mut(|li| li.sequence = 1_001);

        // Attempt to create next period (should fail - auto-renew disabled)
        let no_new = recurring_stream::tick_recurring_stream(&env, recurring_id).unwrap();
        assert!(no_new.is_none());

        let stream = storage::get_recurring_stream(&env, recurring_id).unwrap();
        assert_eq!(stream.periods_created, 1, "No new periods after auto-renewal disabled");
    });
}

#[test]
fn test_non_creator_cannot_disable_auto_renewal() {
    let (env, _client, _admin, _treasury) = setup();

    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);
    let imposter = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        let params = RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: 1_000_000i128,
            period_ledgers: 1_000u64,
            total_periods: 0u32,
            auto_renew: true,
        };

        let recurring_id = recurring_stream::create_recurring_stream(&env, &creator, &params).unwrap();

        // Imposter attempts to disable auto-renewal
        let result = recurring_stream::disable_auto_renewal(&env, &imposter, recurring_id);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), crate::types::Error::Unauthorized);
    });
}

#[test]
fn test_invalid_parameters_rejected() {
    let (env, _client, _admin, _treasury) = setup();

    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        // Invalid: zero amount
        let params = RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: 0i128,
            period_ledgers: 1_000u64,
            total_periods: 3u32,
            auto_renew: false,
        };
        assert!(recurring_stream::create_recurring_stream(&env, &creator, &params).is_err());

        // Invalid: zero period_ledgers
        let params = RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: 1_000_000i128,
            period_ledgers: 0u64,
            total_periods: 3u32,
            auto_renew: false,
        };
        assert!(recurring_stream::create_recurring_stream(&env, &creator, &params).is_err());

        // Invalid: auto_renew false without total_periods
        let params = RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: 1_000_000i128,
            period_ledgers: 1_000u64,
            total_periods: 0u32,
            auto_renew: false,
        };
        assert!(recurring_stream::create_recurring_stream(&env, &creator, &params).is_err());
    });
}

#[test]
fn test_recurring_stream_not_found_error() {
    let (env, _client, _admin, _treasury) = setup();

    env.as_contract(&env.current_contract_address(), || {
        // Try to tick a non-existent recurring stream
        let result = recurring_stream::tick_recurring_stream(&env, 999);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), crate::types::Error::NotFound);
    });
}

#[test]
fn test_first_child_created_on_recurring_stream_creation() {
    let (env, _client, _admin, _treasury) = setup();

    let creator = Address::generate(&env);
    let recipient = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        let params = RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: 2_500_000i128,
            period_ledgers: 500u64,
            total_periods: 10u32,
            auto_renew: false,
        };

        let recurring_id = recurring_stream::create_recurring_stream(&env, &creator, &params).unwrap();

        let stream = storage::get_recurring_stream(&env, recurring_id).unwrap();

        // First period should be created immediately
        assert_eq!(stream.periods_created, 1);
        assert_eq!(stream.child_streams.len(), 1);

        // Verify the child stream was actually created
        let first_child_id = stream.child_streams.get(0).unwrap();
        let vault = storage::get_vault(&env, first_child_id).unwrap();
        assert_eq!(vault.total_amount, 2_500_000i128);
    });
}
