//! Integration tests for campaign pause_campaign and resume_campaign entry points.
//!
//! These tests exercise the entry points **through the contract client**
//! (i.e. through `TokenFactoryClient`), satisfying the requirement from
//! issue #1676 that the new entry points be covered by an integration-style
//! test rather than by calling the internal campaign module functions directly.
//!
//! Covered scenarios:
//!  1. pause_campaign transitions Active → Paused
//!  2. resume_campaign transitions Paused → Active
//!  3. Full pause → resume → pause cycle
//!  4. Unauthorized caller is rejected for both operations
//!  5. Replay-protection: pausing an already-paused campaign returns CampaignAlreadyPaused
//!  6. Replay-protection: resuming an already-active campaign returns CampaignNotPaused

#![cfg(test)]

use crate::{TokenFactory, TokenFactoryClient};
use crate::types::CampaignStatus;
use soroban_sdk::{testutils::Address as _, Address, Env, String};

// ── helpers ──────────────────────────────────────────────────────────────────

fn setup(env: &Env) -> (TokenFactoryClient, Address, Address) {
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(env, &contract_id);

    let admin    = Address::generate(env);
    let treasury = Address::generate(env);

    client.initialize(&admin, &treasury, &70_000_000_i128, &30_000_000_i128);

    (client, admin, treasury)
}

/// Deploy a token and return (token_index, token_address).
fn deploy_token(
    env: &Env,
    client: &TokenFactoryClient,
    creator: &Address,
) -> u32 {
    client.create_token(
        creator,
        &String::from_str(env, "CampaignToken"),
        &String::from_str(env, "CTK"),
        &7_u32,
        &1_000_000_000_i128,
        &None,
        &70_000_000_i128,
    );
    0 // first token created is always index 0
}

/// Create a buyback campaign and return the campaign ID.
fn create_campaign(
    env: &Env,
    client: &TokenFactoryClient,
    creator: &Address,
    token_index: u32,
) -> u64 {
    // We need the token address to pass as target_token
    let token_info = client.get_token_info(&token_index);
    let source_token = Address::generate(env);
    let now = env.ledger().timestamp();

    client.create_buyback_campaign(
        creator,
        &token_index,
        &10_000_i128,          // budget
        &now,                  // start_time
        &(now + 86_400),       // end_time (1 day)
        &300_u64,              // min_interval (5 min)
        &500_u32,              // max_slippage_bps (5%)
        &source_token,
        &token_info.address,
    )
}

// ── tests ─────────────────────────────────────────────────────────────────────

/// 1. pause_campaign transitions Active → Paused through the contract client.
#[test]
fn test_pause_campaign_via_client() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, _treasury) = setup(&env);
    let token_index = deploy_token(&env, &client, &admin);
    let campaign_id = create_campaign(&env, &client, &admin, token_index);

    // Precondition: campaign is Active
    let before = client.get_buyback_campaign(&campaign_id);
    assert_eq!(before.status, CampaignStatus::Active);

    // Act
    client.pause_campaign(&admin, &campaign_id);

    // Postcondition: campaign is Paused
    let after = client.get_buyback_campaign(&campaign_id);
    assert_eq!(after.status, CampaignStatus::Paused);
}

/// 2. resume_campaign transitions Paused → Active through the contract client.
#[test]
fn test_resume_campaign_via_client() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, _treasury) = setup(&env);
    let token_index = deploy_token(&env, &client, &admin);
    let campaign_id = create_campaign(&env, &client, &admin, token_index);

    // Pause first
    client.pause_campaign(&admin, &campaign_id);
    let mid = client.get_buyback_campaign(&campaign_id);
    assert_eq!(mid.status, CampaignStatus::Paused);

    // Act: resume
    client.resume_campaign(&admin, &campaign_id);

    // Postcondition: campaign is Active again
    let after = client.get_buyback_campaign(&campaign_id);
    assert_eq!(after.status, CampaignStatus::Active);
}

/// 3. Full pause → resume → pause cycle to confirm repeated transitions work.
#[test]
fn test_campaign_pause_resume_cycle_via_client() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, _treasury) = setup(&env);
    let token_index = deploy_token(&env, &client, &admin);
    let campaign_id = create_campaign(&env, &client, &admin, token_index);

    // Cycle 1: Active → Paused → Active
    client.pause_campaign(&admin, &campaign_id);
    assert_eq!(client.get_buyback_campaign(&campaign_id).status, CampaignStatus::Paused);
    client.resume_campaign(&admin, &campaign_id);
    assert_eq!(client.get_buyback_campaign(&campaign_id).status, CampaignStatus::Active);

    // Cycle 2: Active → Paused (second pause must also succeed)
    client.pause_campaign(&admin, &campaign_id);
    assert_eq!(client.get_buyback_campaign(&campaign_id).status, CampaignStatus::Paused);
}

/// 4a. Unauthorized caller is rejected for pause_campaign.
#[test]
fn test_pause_campaign_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, _treasury) = setup(&env);
    let token_index = deploy_token(&env, &client, &admin);
    let campaign_id = create_campaign(&env, &client, &admin, token_index);

    let stranger = Address::generate(&env);
    let result = client.try_pause_campaign(&stranger, &campaign_id);
    assert!(result.is_err(), "Stranger should not be able to pause a campaign");
}

/// 4b. Unauthorized caller is rejected for resume_campaign.
#[test]
fn test_resume_campaign_unauthorized() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, _treasury) = setup(&env);
    let token_index = deploy_token(&env, &client, &admin);
    let campaign_id = create_campaign(&env, &client, &admin, token_index);

    // Pause via admin first
    client.pause_campaign(&admin, &campaign_id);

    let stranger = Address::generate(&env);
    let result = client.try_resume_campaign(&stranger, &campaign_id);
    assert!(result.is_err(), "Stranger should not be able to resume a campaign");
}

/// 5. Replay-protection: pausing an already-paused campaign is rejected.
#[test]
fn test_pause_already_paused_campaign() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, _treasury) = setup(&env);
    let token_index = deploy_token(&env, &client, &admin);
    let campaign_id = create_campaign(&env, &client, &admin, token_index);

    client.pause_campaign(&admin, &campaign_id);

    // Second pause on the same already-paused campaign must fail
    let result = client.try_pause_campaign(&admin, &campaign_id);
    assert!(result.is_err(), "Pausing an already-paused campaign must return an error");
}

/// 6. Replay-protection: resuming an already-active campaign is rejected.
#[test]
fn test_resume_already_active_campaign() {
    let env = Env::default();
    env.mock_all_auths();

    let (client, admin, _treasury) = setup(&env);
    let token_index = deploy_token(&env, &client, &admin);
    let campaign_id = create_campaign(&env, &client, &admin, token_index);

    // Campaign starts Active; resuming immediately must fail
    let result = client.try_resume_campaign(&admin, &campaign_id);
    assert!(result.is_err(), "Resuming an already-active campaign must return an error");
}
