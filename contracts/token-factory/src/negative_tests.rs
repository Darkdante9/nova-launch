#![cfg(test)]

use soroban_sdk::{
    testutils::Address as _,
    vec, Address, Env, String, Vec,
};

use crate::{TokenFactory, TokenFactoryClient, Error};

// ─────────────────────────────────────────────────────────────────────────────
// Shared test setup
// Builds a fully initialized factory with an admin, treasury, and a plain user.
// Re-used across every test to avoid boilerplate.
// ─────────────────────────────────────────────────────────────────────────────

struct TestSetup {
    env: Env,
    client: TokenFactoryClient<'static>,
    admin: Address,
    treasury: Address,
    user: Address,
    base_fee: i128,
    metadata_fee: i128,
}

impl TestSetup {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        let user = Address::generate(&env);

        let base_fee: i128 = 70_000_000;
        let metadata_fee: i128 = 30_000_000;

        // initialize returns () so no unwrap needed
        client.initialize(&admin, &treasury, &base_fee, &metadata_fee);

        Self { env, client, admin, treasury, user, base_fee, metadata_fee }
    }

    fn token_name(&self) -> String {
        String::from_str(&self.env, "TestToken")
    }

    fn token_symbol(&self) -> String {
        String::from_str(&self.env, "TST")
    }

    // Deploys a token and returns its index in the factory registry.
    // create_token returns Address, not Result, so no unwrap needed.
    fn deploy_token(&self) -> u32 {
        self.client.create_token(
            &self.user,
            &self.token_name(),
            &self.token_symbol(),
            &7u32,
            &1_000_000_000i128,
            &None,
            &self.base_fee,
        );
        self.client.get_token_count() - 1
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// initialize
// ─────────────────────────────────────────────────────────────────────────────

// Calling initialize a second time must fail — the contract is already set up.
#[test]
fn initialize_already_initialized_returns_error() {
    let setup = TestSetup::new();
    let other_admin = Address::generate(&setup.env);
    let other_treasury = Address::generate(&setup.env);

    let result = setup.client.try_initialize(
        &other_admin,
        &other_treasury,
        &setup.base_fee,
        &setup.metadata_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::AlreadyInitialized);
}

// A negative base fee makes no sense and must be rejected at initialization.
#[test]
fn initialize_negative_base_fee_returns_invalid_parameters() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    let result = client.try_initialize(&admin, &treasury, &-1i128, &30_000_000i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// A negative metadata fee must also be rejected at initialization.
#[test]
fn initialize_negative_metadata_fee_returns_invalid_parameters() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, TokenFactory);
    let client = TokenFactoryClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let treasury = Address::generate(&env);

    let result = client.try_initialize(&admin, &treasury, &70_000_000i128, &-1i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// ─────────────────────────────────────────────────────────────────────────────
// create_token
// ─────────────────────────────────────────────────────────────────────────────

// Paying one stroop less than the required base fee must be rejected.
#[test]
fn create_token_insufficient_fee_returns_error() {
    let setup = TestSetup::new();
    let low_fee = setup.base_fee - 1;

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &setup.token_symbol(),
        &7u32,
        &1_000_000_000i128,
        &None,
        &low_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InsufficientFee);
}

// Paying zero fee must be rejected regardless of the configured base fee.
#[test]
fn create_token_zero_fee_returns_insufficient_fee() {
    let setup = TestSetup::new();

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &setup.token_symbol(),
        &7u32,
        &1_000_000_000i128,
        &None,
        &0i128,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InsufficientFee);
}

// An empty token name (zero length) violates the 1–64 character rule.
#[test]
fn create_token_empty_name_returns_invalid_parameters() {
    let setup = TestSetup::new();
    let empty_name = String::from_str(&setup.env, "");

    let result = setup.client.try_create_token(
        &setup.user,
        &empty_name,
        &setup.token_symbol(),
        &7u32,
        &1_000_000_000i128,
        &None,
        &setup.base_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// An empty token symbol (zero length) violates the 1–12 character rule.
#[test]
fn create_token_empty_symbol_returns_invalid_parameters() {
    let setup = TestSetup::new();
    let empty_symbol = String::from_str(&setup.env, "");

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &empty_symbol,
        &7u32,
        &1_000_000_000i128,
        &None,
        &setup.base_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// A zero initial supply means no tokens would be minted — not a valid token.
#[test]
fn create_token_zero_initial_supply_returns_invalid_parameters() {
    let setup = TestSetup::new();

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &setup.token_symbol(),
        &7u32,
        &0i128,
        &None,
        &setup.base_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// A negative initial supply is nonsensical and must be rejected.
#[test]
fn create_token_negative_initial_supply_returns_invalid_parameters() {
    let setup = TestSetup::new();

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &setup.token_symbol(),
        &7u32,
        &-1i128,
        &None,
        &setup.base_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// Decimals above 18 exceed the Stellar standard and must be rejected.
#[test]
fn create_token_decimals_out_of_range_returns_invalid_parameters() {
    let setup = TestSetup::new();

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &setup.token_symbol(),
        &19u32,
        &1_000_000_000i128,
        &None,
        &setup.base_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// An empty string supplied as the metadata URI must be rejected.
#[test]
fn create_token_empty_metadata_uri_returns_invalid_parameters() {
    let setup = TestSetup::new();
    let empty_uri = Some(String::from_str(&setup.env, ""));

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &setup.token_symbol(),
        &7u32,
        &1_000_000_000i128,
        &empty_uri,
        &(setup.base_fee + setup.metadata_fee),
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// ─────────────────────────────────────────────────────────────────────────────
// burn
// ─────────────────────────────────────────────────────────────────────────────

// Burning zero tokens is a no-op that the contract must explicitly reject.
#[test]
fn burn_zero_amount_returns_invalid_burn_amount() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();

    let result = setup.client.try_burn(&setup.user, &token_index, &0i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidBurnAmount);
}

// A negative burn amount is undefined behaviour and must be rejected.
#[test]
fn burn_negative_amount_returns_invalid_burn_amount() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();

    let result = setup.client.try_burn(&setup.user, &token_index, &-1i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidBurnAmount);
}

// Attempting to burn more than the holder's balance must be rejected.
#[test]
fn burn_exceeds_balance_returns_error() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();
    let too_much: i128 = 1_000_000_001; // one above the initial supply

    let result = setup.client.try_burn(&setup.user, &token_index, &too_much);
    assert_eq!(result.unwrap_err().unwrap(), Error::BurnAmountExceedsBalance);
}

// Referencing a token index that was never created must return TokenNotFound.
#[test]
fn burn_token_not_found_returns_error() {
    let setup = TestSetup::new();

    let result = setup.client.try_burn(&setup.user, &9999u32, &100i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::TokenNotFound);
}

// ─────────────────────────────────────────────────────────────────────────────
// batch_burn
// ─────────────────────────────────────────────────────────────────────────────

// An empty burn list provides nothing to process and must be rejected.
#[test]
fn batch_burn_empty_list_returns_invalid_parameters() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();
    let burns: Vec<(Address, i128)> = Vec::new(&setup.env);

    let result = setup.client.try_batch_burn(&setup.admin, &token_index, &burns);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// Only the factory admin may invoke batch_burn; any other caller must be rejected.
#[test]
fn batch_burn_unauthorized_non_admin_returns_error() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();
    let stranger = Address::generate(&setup.env);
    let burns = vec![&setup.env, (setup.user.clone(), 100i128)];

    let result = setup.client.try_batch_burn(&stranger, &token_index, &burns);
    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized);
}

// Providing a non-existent token index to batch_burn must return TokenNotFound.
#[test]
fn batch_burn_token_not_found_returns_error() {
    let setup = TestSetup::new();
    let burns = vec![&setup.env, (setup.user.clone(), 100i128)];

    let result = setup.client.try_batch_burn(&setup.admin, &9999u32, &burns);
    assert_eq!(result.unwrap_err().unwrap(), Error::TokenNotFound);
}

// ─────────────────────────────────────────────────────────────────────────────
// update_fees
// ─────────────────────────────────────────────────────────────────────────────

// A non-admin address must not be able to change fees.
#[test]
fn update_fees_unauthorized_non_admin_returns_error() {
    let setup = TestSetup::new();
    let stranger = Address::generate(&setup.env);

    let result = setup.client.try_update_fees(&stranger, &Some(80_000_000i128), &None);
    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized);
}

// A negative base fee must be rejected even when sent by the admin.
#[test]
fn update_fees_negative_base_fee_returns_invalid_parameters() {
    let setup = TestSetup::new();

    let result = setup.client.try_update_fees(&setup.admin, &Some(-1i128), &None);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// A negative metadata fee must be rejected even when sent by the admin.
#[test]
fn update_fees_negative_metadata_fee_returns_invalid_parameters() {
    let setup = TestSetup::new();

    let result = setup.client.try_update_fees(&setup.admin, &None, &Some(-1i128));
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// Passing None for both fees means no change was requested — must be rejected.
#[test]
fn update_fees_both_none_returns_invalid_parameters() {
    let setup = TestSetup::new();

    let result = setup.client.try_update_fees(&setup.admin, &None, &None);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// ─────────────────────────────────────────────────────────────────────────────
// get_token_info
// ─────────────────────────────────────────────────────────────────────────────

// Querying index 0 when no tokens have been deployed must return TokenNotFound.
#[test]
fn get_token_info_out_of_bounds_index_returns_token_not_found() {
    let setup = TestSetup::new();

    let result = setup.client.try_get_token_info(&0u32);
    assert_eq!(result.unwrap_err().unwrap(), Error::TokenNotFound);
}

// Querying u32::MAX when only one token exists must return TokenNotFound.
#[test]
fn get_token_info_large_index_returns_token_not_found() {
    let setup = TestSetup::new();
    setup.deploy_token();

    let result = setup.client.try_get_token_info(&u32::MAX);
    assert_eq!(result.unwrap_err().unwrap(), Error::TokenNotFound);
}

// ─────────────────────────────────────────────────────────────────────────────
// mint
// ─────────────────────────────────────────────────────────────────────────────

// Only the token creator may mint; any other address must be rejected.
#[test]
fn mint_unauthorized_non_creator_returns_error() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();
    let stranger = Address::generate(&setup.env);

    let result = setup.client.try_mint(&stranger, &token_index, &setup.user, &1_000i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized);
}

// Minting to a non-existent token index must return TokenNotFound.
#[test]
fn mint_token_not_found_returns_error() {
    let setup = TestSetup::new();

    let result = setup.client.try_mint(&setup.user, &9999u32, &setup.user, &1_000i128);
    assert_eq!(result.unwrap_err().unwrap(), Error::TokenNotFound);
}

// ─────────────────────────────────────────────────────────────────────────────
// pause / unpause
// ─────────────────────────────────────────────────────────────────────────────

// A non-admin address must not be able to pause the contract.
#[test]
fn pause_unauthorized_non_admin_returns_error() {
    let setup = TestSetup::new();
    let stranger = Address::generate(&setup.env);

    let result = setup.client.try_pause(&stranger);
    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized);
}

// A non-admin address must not be able to unpause the contract.
// pause() returns () so it is called directly without unwrap.
#[test]
fn unpause_unauthorized_non_admin_returns_error() {
    let setup = TestSetup::new();
    setup.client.pause(&setup.admin);
    let stranger = Address::generate(&setup.env);

    let result = setup.client.try_unpause(&stranger);
    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized);
}

// ─────────────────────────────────────────────────────────────────────────────
// transfer_admin
// ─────────────────────────────────────────────────────────────────────────────

// A non-admin address must not be able to transfer admin rights.
#[test]
fn transfer_admin_unauthorized_returns_error() {
    let setup = TestSetup::new();
    let stranger = Address::generate(&setup.env);
    let new_admin = Address::generate(&setup.env);

    let result = setup.client.try_transfer_admin(&stranger, &new_admin);
    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized);
}

// Transferring admin to the same address that already holds it must be rejected.
#[test]
fn transfer_admin_same_address_returns_invalid_parameters() {
    let setup = TestSetup::new();

    let result = setup.client.try_transfer_admin(&setup.admin, &setup.admin);
    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// ─────────────────────────────────────────────────────────────────────────────
// contract paused guard
// ─────────────────────────────────────────────────────────────────────────────

// When the contract is paused, create_token must return ContractPaused
// regardless of whether the other parameters are valid.
// pause() returns () so it is called directly without unwrap.
#[test]
fn create_token_paused_contract_returns_error() {
    let setup = TestSetup::new();
    setup.client.pause(&setup.admin);

    let result = setup.client.try_create_token(
        &setup.user,
        &setup.token_name(),
        &setup.token_symbol(),
        &7u32,
        &1_000_000_000i128,
        &None,
        &setup.base_fee,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::ContractPaused);
}

// ─────────────────────────────────────────────────────────────────────────────
// set_metadata
// ─────────────────────────────────────────────────────────────────────────────

// Calling set_metadata a second time on the same token must fail because
// metadata is immutable once set.
#[test]
fn set_metadata_already_set_returns_error() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();
    let uri = String::from_str(&setup.env, "ipfs://QmFirst");

    // First call succeeds — metadata is still None at this point.
    setup.client.set_metadata(&token_index, &uri);

    // Second call must fail because metadata_uri is now Some(_).
    let second_uri = String::from_str(&setup.env, "ipfs://QmSecond");
    let result = setup.client.try_set_metadata(&token_index, &second_uri);

    assert_eq!(result.unwrap_err().unwrap(), Error::MetadataAlreadySet);
}

// Calling set_metadata on a token that has been individually paused must
// return TokenPaused so callers can distinguish from ContractPaused.
#[test]
fn set_metadata_paused_token_returns_token_paused() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();

    // Pause the individual token (not the whole contract).
    setup.client.pause_token(&setup.admin, &token_index);

    let uri = String::from_str(&setup.env, "ipfs://QmPaused");
    let result = setup.client.try_set_metadata(&token_index, &uri);

    assert_eq!(result.unwrap_err().unwrap(), Error::TokenPaused);
}

// ─────────────────────────────────────────────────────────────────────────────
// freeze_address / unfreeze_address
// ─────────────────────────────────────────────────────────────────────────────

// Attempting to freeze an address on a token that has not had freeze enabled
// must be rejected. The contract uses Unauthorized to signal this condition.
#[test]
fn freeze_address_freeze_not_enabled_returns_unauthorized() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();
    let token_info = setup.client.get_token_info(&token_index).unwrap();
    let target = Address::generate(&setup.env);

    // freeze_enabled is false by default after create_token.
    let result = setup.client.try_freeze_address(
        &token_info.address,
        &setup.user,
        &target,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::Unauthorized);
}

// Freezing an address that is already frozen must be rejected.
// The contract returns InvalidParameters for this duplicate-freeze case.
#[test]
fn freeze_address_already_frozen_returns_invalid_parameters() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();
    let token_info = setup.client.get_token_info(&token_index).unwrap();
    let target = Address::generate(&setup.env);

    // Enable freeze for this token first.
    setup.client.set_freeze_enabled(&token_info.address, &setup.user, &true);

    // First freeze succeeds.
    setup.client.freeze_address(&token_info.address, &setup.user, &target);

    // Second freeze on the same address must fail.
    let result = setup.client.try_freeze_address(
        &token_info.address,
        &setup.user,
        &target,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// Unfreezing an address that has never been frozen must be rejected.
// The contract returns InvalidParameters for this not-frozen case.
#[test]
fn unfreeze_address_not_frozen_returns_invalid_parameters() {
    let setup = TestSetup::new();
    let token_index = setup.deploy_token();
    let token_info = setup.client.get_token_info(&token_index).unwrap();
    let target = Address::generate(&setup.env);

    // Enable freeze so the call reaches the frozen-check (not the enabled-check).
    setup.client.set_freeze_enabled(&token_info.address, &setup.user, &true);

    // target was never frozen — unfreeze must fail.
    let result = setup.client.try_unfreeze_address(
        &token_info.address,
        &setup.user,
        &target,
    );

    assert_eq!(result.unwrap_err().unwrap(), Error::InvalidParameters);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tracking comment — error variants without a triggerable negative test
// ─────────────────────────────────────────────────────────────────────────────
//
// The following Error codes exist in types.rs but cannot be directly triggered
// through the TokenFactory client API with the current contract implementation.
// They are listed here so future contributors know they still need coverage:
//
//   Error::InsufficientBalance     (#7)  — admin_burn path; no direct test because
//                                         admin_burn balance check uses a storage
//                                         path not reachable without low-level setup.
//   Error::ArithmeticError         (#8)  — requires crafted overflow; covered by
//                                         arithmetic_boundary_tests.rs.
//   Error::BatchTooLarge           (#9)  — batch_burn with an oversized list;
//                                         covered by batch_atomicity_test.rs.
//   Error::InvalidAmount           (#10) — covered in mint negative path by
//                                         supply_cap_test.rs.
//   Error::ClawbackDisabled        (#11) — contract does not currently return this
//                                         code; admin_burn skips the clawback check.
//   Error::InvalidTokenParams      (#15) — batch_create_tokens; covered by
//                                         batch_token_creation_test.rs.
//   Error::BatchCreationFailed     (#16) — internal batch path; no public trigger.
//   Error::StreamNotFound          (#17) — streaming module; covered by
//                                         stream_error_test.rs.
//   Error::InvalidSchedule         (#18) — streaming module; covered by
//                                         stream_error_test.rs.
//   Error::StreamCancelled         (#19) — streaming module; covered by
//                                         stream_error_test.rs.
//   Error::CliffNotReached         (#20) — streaming claim; covered by
//                                         stream_claim_test.rs.
//   Error::NothingToClaim          (#21) — streaming claim; covered by
//                                         stream_claim_test.rs.
//   Error::MissingAdmin            (#22) — internal storage validation path.
//   Error::MissingTreasury         (#23) — internal storage validation path.
//   Error::InvalidBaseFee          (#24) — separate validation path from #3.
//   Error::InvalidMetadataFee      (#25) — separate validation path from #3.
//   Error::InconsistentTokenCount  (#26) — invariant guard; covered by
//                                         invariant_tests.rs.
//   Error::WithdrawalCapExceeded   (#27) — vault module; covered by
//                                         vault_error_test.rs.
//   Error::RecipientNotAllowed     (#28) — transfer restriction; covered by
//                                         transfer_restrictions_test.rs.
//   Error::TimelockNotExpired      (#29) — timelock; covered by
//                                         timelock_test.rs.
//   Error::ChangeAlreadyExecuted   (#30) — governance; covered by
//                                         governance_error_test.rs.
//   Error::ChangeNotFound          (#31) — governance; covered by
//                                         governance_error_test.rs.
//   Error::MaxSupplyExceeded       (#32) — mint path; covered by
//                                         supply_cap_test.rs.
//   Error::InvalidMaxSupply        (#33) — mint path; covered by
//                                         supply_cap_test.rs.
//   Error::MintingDisabled         (#34) — mint path; covered by
//                                         supply_cap_test.rs.
//   Error::FreezeNotEnabled        (#36) — contract returns Unauthorized instead
//                                         (see freeze_functions.rs L63–L66); no
//                                         distinct trigger exists at this time.
//   Error::AddressFrozen           (#37) — contract returns InvalidParameters
//                                         instead (see freeze_functions.rs).
//   Error::AddressNotFrozen        (#38) — contract returns InvalidParameters
//                                         instead (see freeze_functions.rs).
//   Error::ProposalInTerminalState (#39) — governance; covered by
//                                         governance_error_test.rs.
//   Error::InvalidStateTransition  (#40) — governance state machine; covered by
//                                         proposal_state_machine_test.rs.
//   Error::InvalidTimeWindow       (#41) — governance; covered by
//                                         governance_timelock_boundary_test.rs.
//   Error::PayloadTooLarge         (#42) — governance; covered by
//                                         payload_validation_fuzz_test.rs.
//   Error::ProposalNotFound        (#43) — governance; covered by
//                                         governance_error_test.rs.
//   Error::VotingNotStarted        (#44) — governance; covered by
//                                         governance_error_test.rs.
//   Error::VotingEnded             (#45) — governance; covered by
//                                         governance_error_test.rs.
//   Error::VotingClosed            (#46) — governance; covered by
//                                         governance_error_test.rs.
//   Error::AlreadyVoted            (#47) — governance; covered by
//                                         governance_quorum_test.rs.
//   Error::ProposalNotQueued       (#48) — governance; covered by
//                                         queue_proposal_test.rs.
//   Error::ProposalCancelled       (#49) — governance; covered by
//                                         governance_error_test.rs.
//   Error::QuorumNotMet            (#50) — governance; covered by
//                                         queue_proposal_test.rs.
//   Error::CampaignNotFound        (#51) — campaign module.
//   Error::InvalidBudget           (#52) — campaign module.
//   Error::InsufficientBudget      (#53) — campaign module.
//   Error::PriceTriggerNotMet      (#54) — campaign module.
//   Error::CampaignExpiredError    (#55) — campaign module.
//   Error::IntervalNotElapsed      (#56) — campaign module.
//   Error::AirdropNotFound         (#57) — airdrop module.
//   Error::AirdropAlreadyClaimed   (#58) — airdrop module.
//   Error::InvalidMerkleProof      (#59) — airdrop module.
//   Error::AirdropExpired          (#60) — airdrop module.