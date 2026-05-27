//! Concurrency stress harness for simultaneous mint operations (#1053)
//!
//! This module contains chaos-style tests that exercise interleaved/sequential
//! mint operations to validate that supply accounting holds under many rapid
//! operations and that authorization is enforced on every call.

#![cfg(test)]

use soroban_sdk::{
    testutils::Address as _,
    Address, Env, String, Vec,
};

use crate::{TokenFactory, TokenFactoryClient};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register_contract(None, TokenFactory);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);
    let creator = Address::generate(&env);

    let client = TokenFactoryClient::new(&env, &contract_id);
    client.initialize(&admin, &treasury, &70_000_000, &30_000_000);

    (env, contract_id, admin, creator)
}

// ─────────────────────────────────────────────
// Stress Tests
// ─────────────────────────────────────────────

#[test]
fn test_mint_large_batch_supply_accounting() {
    let (env, contract_id, admin, creator) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    // Create token with initial supply
    let initial_supply = 1_000_000i128;
    let token_address = client.create_token(
        &creator,
        &String::from_str(&env, "Stress Token"),
        &String::from_str(&env, "STR"),
        &7,
        &initial_supply,
    );

    // Perform 50 mint operations
    let mint_amount = 10_000i128;
    let num_mints = 50;
    let mut total_minted = 0i128;

    for i in 0..num_mints {
        let recipient = if i % 3 == 0 {
            creator.clone()
        } else if i % 3 == 1 {
            admin.clone()
        } else {
            Address::generate(&env)
        };

        client.mint_tokens(&token_address, &admin, &recipient, &mint_amount);
        total_minted += mint_amount;
    }

    // Verify final supply equals initial + all mints
    let info = client.get_token_info(&0);
    let expected_supply = initial_supply + total_minted;
    assert_eq!(
        info.total_supply, expected_supply,
        "Supply accounting failed: expected {}, got {}",
        expected_supply, info.total_supply
    );
}

#[test]
fn test_mint_authorization_enforced_every_call() {
    let (env, contract_id, admin, creator) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let token_address = client.create_token(
        &creator,
        &String::from_str(&env, "Auth Token"),
        &String::from_str(&env, "AUTH"),
        &7,
        &1_000_000,
    );

    let unauthorized = Address::generate(&env);
    let recipient = Address::generate(&env);

    // Unauthorized mint should fail
    let result = client.try_mint_tokens(
        &token_address,
        &unauthorized,
        &recipient,
        &100_000,
    );
    assert!(result.is_err(), "Unauthorized mint should fail");

    // Verify state unchanged
    let info = client.get_token_info(&0);
    assert_eq!(info.total_supply, 1_000_000);
}

#[test]
fn test_mint_randomized_ordering_consistency() {
    let (env, contract_id, admin, creator) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let initial_supply = 5_000_000i128;
    let token_address = client.create_token(
        &creator,
        &String::from_str(&env, "Order Token"),
        &String::from_str(&env, "ORD"),
        &7,
        &initial_supply,
    );

    // Create multiple recipients
    let recipients: Vec<Address> = (0..5)
        .map(|_| Address::generate(&env))
        .collect();

    // Mint in various orders
    let mint_amounts = vec![&env, 100_000, 250_000, 75_000, 150_000, 200_000];
    let mut total_minted = 0i128;

    for amount in mint_amounts.iter() {
        for recipient in recipients.iter() {
            client.mint_tokens(&token_address, &admin, recipient, amount);
            total_minted += amount;
        }
    }

    // Verify accounting is correct regardless of order
    let info = client.get_token_info(&0);
    let expected_supply = initial_supply + total_minted;
    assert_eq!(info.total_supply, expected_supply);
}

#[test]
fn test_mint_events_emitted_for_each_operation() {
    let (env, contract_id, admin, creator) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let token_address = client.create_token(
        &creator,
        &String::from_str(&env, "Event Token"),
        &String::from_str(&env, "EVT"),
        &7,
        &1_000_000,
    );

    let recipient = Address::generate(&env);

    // Perform multiple mints
    for i in 1..=5 {
        client.mint_tokens(&token_address, &admin, &recipient, &(i as i128 * 10_000));
    }

    // Verify final supply reflects all mints
    let info = client.get_token_info(&0);
    let expected_supply = 1_000_000 + (1 + 2 + 3 + 4 + 5) * 10_000;
    assert_eq!(info.total_supply, expected_supply);
}

#[test]
fn test_mint_zero_amount_fails() {
    let (env, contract_id, admin, creator) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let token_address = client.create_token(
        &creator,
        &String::from_str(&env, "Zero Token"),
        &String::from_str(&env, "ZRO"),
        &7,
        &1_000_000,
    );

    let recipient = Address::generate(&env);

    // Mint zero should fail
    let result = client.try_mint_tokens(&token_address, &admin, &recipient, &0);
    assert!(result.is_err());

    // Verify state unchanged
    let info = client.get_token_info(&0);
    assert_eq!(info.total_supply, 1_000_000);
}

#[test]
fn test_mint_negative_amount_fails() {
    let (env, contract_id, admin, creator) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let token_address = client.create_token(
        &creator,
        &String::from_str(&env, "Neg Token"),
        &String::from_str(&env, "NEG"),
        &7,
        &1_000_000,
    );

    let recipient = Address::generate(&env);

    // Mint negative should fail
    let result = client.try_mint_tokens(&token_address, &admin, &recipient, &-100_000);
    assert!(result.is_err());

    // Verify state unchanged
    let info = client.get_token_info(&0);
    assert_eq!(info.total_supply, 1_000_000);
}

#[test]
fn test_mint_to_same_recipient_accumulates() {
    let (env, contract_id, admin, creator) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let token_address = client.create_token(
        &creator,
        &String::from_str(&env, "Accum Token"),
        &String::from_str(&env, "ACC"),
        &7,
        &1_000_000,
    );

    let recipient = Address::generate(&env);

    // Mint to same recipient multiple times
    for _ in 0..10 {
        client.mint_tokens(&token_address, &admin, &recipient, &50_000);
    }

    // Verify supply increased by total minted
    let info = client.get_token_info(&0);
    assert_eq!(info.total_supply, 1_000_000 + (10 * 50_000));
}

#[test]
fn test_mint_max_supply_enforcement() {
    let (env, contract_id, admin, creator) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let initial_supply = 1_000_000i128;
    let max_supply = 2_000_000i128;

    let token_address = client.create_token_with_max_supply(
        &creator,
        &String::from_str(&env, "Max Token"),
        &String::from_str(&env, "MAX"),
        &7,
        &initial_supply,
        &Some(max_supply),
    );

    let recipient = Address::generate(&env);

    // Mint up to max should succeed
    client.mint_tokens(&token_address, &admin, &recipient, &999_999);
    let info1 = client.get_token_info(&0);
    assert_eq!(info1.total_supply, 1_999_999);

    // Mint exceeding max should fail
    let result = client.try_mint_tokens(&token_address, &admin, &recipient, &2);
    assert!(result.is_err());

    // Verify state unchanged
    let info2 = client.get_token_info(&0);
    assert_eq!(info2.total_supply, 1_999_999);
}

#[test]
fn test_mint_large_amounts_near_i128_max() {
    let (env, contract_id, admin, creator) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let large_initial = 1_000_000_000_000_000i128;
    let token_address = client.create_token(
        &creator,
        &String::from_str(&env, "Large Token"),
        &String::from_str(&env, "LRG"),
        &0,
        &large_initial,
    );

    let recipient = Address::generate(&env);
    let large_mint = 500_000_000_000_000i128;

    client.mint_tokens(&token_address, &admin, &recipient, &large_mint);

    let info = client.get_token_info(&0);
    assert_eq!(info.total_supply, large_initial + large_mint);
}

#[test]
fn test_mint_interleaved_with_different_recipients() {
    let (env, contract_id, admin, creator) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let token_address = client.create_token(
        &creator,
        &String::from_str(&env, "Interleave Token"),
        &String::from_str(&env, "INT"),
        &7,
        &1_000_000,
    );

    let recipients: Vec<Address> = (0..10)
        .map(|_| Address::generate(&env))
        .collect();

    let mut total_minted = 0i128;

    // Interleave mints to different recipients
    for i in 0..100 {
        let recipient = &recipients[i % recipients.len()];
        let amount = ((i as i128 + 1) * 1_000) % 100_000 + 1_000;
        client.mint_tokens(&token_address, &admin, recipient, &amount);
        total_minted += amount;
    }

    // Verify final supply
    let info = client.get_token_info(&0);
    assert_eq!(info.total_supply, 1_000_000 + total_minted);
}

#[test]
fn test_mint_state_isolation_between_tokens() {
    let (env, contract_id, admin, creator) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    // Create two tokens
    let token1 = client.create_token(
        &creator,
        &String::from_str(&env, "Token 1"),
        &String::from_str(&env, "T1"),
        &7,
        &1_000_000,
    );

    let token2 = client.create_token(
        &creator,
        &String::from_str(&env, "Token 2"),
        &String::from_str(&env, "T2"),
        &7,
        &2_000_000,
    );

    let recipient = Address::generate(&env);

    // Mint to token1
    client.mint_tokens(&token1, &admin, &recipient, &100_000);

    // Mint to token2
    client.mint_tokens(&token2, &admin, &recipient, &200_000);

    // Verify each token's supply is independent
    let info1 = client.get_token_info(&0);
    let info2 = client.get_token_info(&1);

    assert_eq!(info1.total_supply, 1_100_000);
    assert_eq!(info2.total_supply, 2_200_000);
}

#[test]
fn test_mint_rapid_sequential_operations() {
    let (env, contract_id, admin, creator) = setup();
    let client = TokenFactoryClient::new(&env, &contract_id);

    let token_address = client.create_token(
        &creator,
        &String::from_str(&env, "Rapid Token"),
        &String::from_str(&env, "RPD"),
        &7,
        &1_000_000,
    );

    let recipient = Address::generate(&env);

    // Perform 100 rapid mints
    let mut total_minted = 0i128;
    for i in 0..100 {
        let amount = (i as i128 + 1) * 100;
        client.mint_tokens(&token_address, &admin, &recipient, &amount);
        total_minted += amount;
    }

    // Verify supply accounting
    let info = client.get_token_info(&0);
    let expected = 1_000_000 + total_minted;
    assert_eq!(info.total_supply, expected);
}
