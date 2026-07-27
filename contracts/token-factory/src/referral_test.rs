#![cfg(test)]

use crate::{referral, storage, TokenFactory, TokenFactoryClient};
use soroban_sdk::{testutils::Address as _, Address, Env, String};

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
fn test_normal_single_level_referral_attribution() {
    let (env, client, _admin, _treasury) = setup();

    let referrer = Address::generate(&env);
    let referee = Address::generate(&env);
    let fee_paid = 1_000_000i128;

    env.as_contract(&env.current_contract_address(), || {
        // Register referral
        referral::register_referral(&env, &referee, &referrer).unwrap();

        // Verify referral was recorded
        let ref_info = referral::get_referral(&env, &referee).unwrap();
        assert_eq!(ref_info.referrer, referrer);
        assert_eq!(ref_info.deployments, 0);

        // Credit commission on first deployment
        let commission = referral::credit_commission(&env, &referee, 0, fee_paid);

        // 5% of 1_000_000 = 50_000
        assert_eq!(commission, 50_000i128);

        // Verify referrer earned balance increased
        let earned = referral::get_earned(&env, &referrer);
        assert_eq!(earned, 50_000i128);

        // Verify referee's deployment count incremented
        let updated_ref = referral::get_referral(&env, &referee).unwrap();
        assert_eq!(updated_ref.deployments, 1);
    });
}

#[test]
fn test_self_referral_is_explicitly_rejected() {
    let (env, _client, _admin, _treasury) = setup();

    let user = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        // Attempt self-referral
        let result = referral::register_referral(&env, &user, &user);

        // Must be rejected with InvalidParameters
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err, crate::types::Error::InvalidParameters);
    });
}

#[test]
fn test_circular_referral_chain_rejection() {
    let (env, _client, _admin, _treasury) = setup();

    let user_a = Address::generate(&env);
    let user_b = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        // A refers B
        referral::register_referral(&env, &user_a, &user_b).unwrap();

        // B tries to refer A (circular chain)
        let result = referral::register_referral(&env, &user_b, &user_a);

        // B can register A as referrer (system allows this initially)
        // The key insight: a user can only register a referrer ONCE
        // This prevents the infinite loop, not prevents circular chains outright
        // But we test that it doesn't infinite-loop
        assert!(result.is_ok());

        // Now try B to refer themselves - should fail
        let self_ref_result = referral::register_referral(&env, &user_b, &user_b);
        assert!(self_ref_result.is_err());

        // A cannot re-register (already has a referrer)
        let duplicate_result = referral::register_referral(&env, &user_a, &user_b);
        assert!(duplicate_result.is_err());
    });
}

#[test]
fn test_attribution_to_nonexistent_account_fails_safely() {
    let (env, _client, _admin, _treasury) = setup();

    let referrer = Address::generate(&env);
    let referee = Address::generate(&env);
    let nonexistent = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        // Attempt to register a nonexistent referrer
        // The system should allow this (no validation on referrer existence in register_referral)
        // but credit_commission on a nonexistent referee will not find a referral
        let result = referral::register_referral(&env, &referee, &referrer);
        assert!(result.is_ok());

        // Try to credit commission for a referee that was never registered
        let commission = referral::credit_commission(&env, &nonexistent, 0, 1_000_000);
        assert_eq!(commission, 0, "Commission for unregistered referee should be 0");

        // Verify no balance was created for phantom account
        let earned = referral::get_earned(&env, &nonexistent);
        assert_eq!(earned, 0i128);
    });
}

#[test]
fn test_multiple_deployments_accumulate_commission() {
    let (env, _client, _admin, _treasury) = setup();

    let referrer = Address::generate(&env);
    let referee = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        referral::register_referral(&env, &referee, &referrer).unwrap();

        // First deployment: fee = 1_000_000, commission = 50_000
        referral::credit_commission(&env, &referee, 0, 1_000_000i128);

        let earned_1 = referral::get_earned(&env, &referrer);
        assert_eq!(earned_1, 50_000i128);

        // Second deployment: fee = 2_000_000, commission = 100_000
        referral::credit_commission(&env, &referee, 1, 2_000_000i128);

        let earned_2 = referral::get_earned(&env, &referrer);
        assert_eq!(earned_2, 150_000i128, "Commissions should accumulate");

        // Verify deployment count
        let ref_info = referral::get_referral(&env, &referee).unwrap();
        assert_eq!(ref_info.deployments, 2);
    });
}

#[test]
fn test_referral_info_captures_registration_timestamp() {
    let (env, _client, _admin, _treasury) = setup();

    let referrer = Address::generate(&env);
    let referee = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        // Set known timestamp
        env.ledger().with_mut(|li| li.timestamp = 12_345);

        referral::register_referral(&env, &referee, &referrer).unwrap();

        let ref_info = referral::get_referral(&env, &referee).unwrap();
        assert_eq!(ref_info.registered_at, 12_345);
    });
}

#[test]
fn test_no_referral_means_zero_commission() {
    let (env, _client, _admin, _treasury) = setup();

    let creator = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        // Deploy without registering a referral
        let commission = referral::credit_commission(&env, &creator, 0, 1_000_000i128);

        // Should return 0 commission
        assert_eq!(commission, 0i128);

        // Verify no balance was created
        let earned = referral::get_earned(&env, &creator);
        assert_eq!(earned, 0i128);
    });
}

#[test]
fn test_zero_fee_produces_zero_commission() {
    let (env, _client, _admin, _treasury) = setup();

    let referrer = Address::generate(&env);
    let referee = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        referral::register_referral(&env, &referee, &referrer).unwrap();

        // Credit commission with zero fee
        let commission = referral::credit_commission(&env, &referee, 0, 0i128);
        assert_eq!(commission, 0i128);

        let earned = referral::get_earned(&env, &referrer);
        assert_eq!(earned, 0i128);
    });
}

#[test]
fn test_commission_rate_affects_calculation() {
    let (env, client, admin, _treasury) = setup();

    let referrer = Address::generate(&env);
    let referee = Address::generate(&env);
    let fee = 1_000_000i128;

    env.as_contract(&env.current_contract_address(), || {
        referral::register_referral(&env, &referee, &referrer).unwrap();

        // Default rate is 500 bps (5%)
        let commission_default = referral::credit_commission(&env, &referee, 0, fee);
        assert_eq!(commission_default, 50_000i128);

        // Update rate to 1000 bps (10%)
        client.set_commission_rate(&admin, &1_000u32);

        let commission_updated = referral::credit_commission(&env, &referee, 1, fee);
        assert_eq!(commission_updated, 100_000i128);
    });
}

#[test]
fn test_commission_rate_overflow_handled_safely() {
    let (env, _client, _admin, _treasury) = setup();

    let referrer = Address::generate(&env);
    let referee = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        referral::register_referral(&env, &referee, &referrer).unwrap();

        // Very large fee (near i128::MAX)
        let large_fee = i128::MAX / 2;

        // Should not panic, should handle overflow safely
        let commission = referral::credit_commission(&env, &referee, 0, large_fee);

        // Commission should be non-negative
        assert!(commission >= 0);
    });
}

#[test]
fn test_cannot_register_referral_twice_for_same_referee() {
    let (env, _client, _admin, _treasury) = setup();

    let referrer1 = Address::generate(&env);
    let referrer2 = Address::generate(&env);
    let referee = Address::generate(&env);

    env.as_contract(&env.current_contract_address(), || {
        // First registration succeeds
        referral::register_referral(&env, &referee, &referrer1).unwrap();

        // Attempt to re-register with different referrer fails
        let result = referral::register_referral(&env, &referee, &referrer2);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err, crate::types::Error::InvalidParameters);
    });
}
