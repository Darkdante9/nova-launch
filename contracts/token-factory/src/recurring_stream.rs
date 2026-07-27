//! Recurring payment stream creation and management.
//!
//! This module provides functionality to create recurring payment streams that automatically
//! create child streams at fixed intervals. Each period creates an independent, claimable stream.

use crate::events;
use crate::storage;
use crate::types::{Error, RecurringStream, RecurringStreamParams, Vault, VaultStatus};
use soroban_sdk::{Address, Env, Vec};

/// Maximum number of periods for a recurring stream
const MAX_TOTAL_PERIODS: u32 = 10_000;

/// Maximum number of child streams to track
const MAX_CHILD_STREAMS: u32 = 1_000;

/// Create a new recurring payment stream.
///
/// This creates a recurring stream that will automatically create child vaults
/// at regular intervals. Each child vault is independent and claimable by the recipient.
///
/// # Arguments
/// * `env` - The contract environment
/// * `creator` - Address creating the recurring stream (must authorize)
/// * `params` - RecurringStreamParams defining the payment schedule
///
/// # Returns
/// Returns the recurring stream ID
///
/// # Errors
/// * `Error::Unauthorized` - Caller is not the creator
/// * `Error::InvalidParameters` - Invalid stream parameters
/// * `Error::ContractPaused` - Contract is paused
pub fn create_recurring_stream(
    env: &Env,
    creator: &Address,
    params: &RecurringStreamParams,
) -> Result<u64, Error> {
    creator.require_auth();

    // Check if contract is paused
    if storage::is_paused(env) {
        return Err(Error::ContractPaused);
    }

    // Validate parameters
    validate_recurring_stream_params(params)?;

    // Get current ledger
    let current_ledger = env.ledger().sequence();

    // Get next recurring stream ID
    let recurring_stream_id = storage::next_recurring_stream_id(env);

    // Create initial recurring stream
    let mut child_streams = Vec::new(env);

    // Create the first child stream immediately
    let first_vault_id = create_child_stream(
        env,
        creator,
        recurring_stream_id,
        &params.recipient,
        params.amount_per_period,
        current_ledger,
        params.period_ledgers,
        0, // period index
    )?;

    child_streams.push_back(first_vault_id);

    let recurring_stream = RecurringStream {
        id: recurring_stream_id,
        creator: creator.clone(),
        recipient: params.recipient.clone(),
        amount_per_period: params.amount_per_period,
        period_ledgers: params.period_ledgers,
        total_periods: params.total_periods,
        periods_created: 1,
        current_period_start_ledger: current_ledger,
        auto_renew: params.auto_renew,
        auto_renew_enabled: params.auto_renew,
        cancelled: false,
        child_streams,
    };

    // Store the recurring stream
    storage::set_recurring_stream(env, recurring_stream_id, &recurring_stream);

    // Record in creator's recurring streams
    storage::add_creator_recurring_stream(env, creator, recurring_stream_id)?;

    // Emit event
    events::emit_recurring_stream_created(
        env,
        recurring_stream_id,
        creator,
        &params.recipient,
        params.amount_per_period,
        params.period_ledgers,
        params.total_periods,
    );

    Ok(recurring_stream_id)
}

/// Cancel a recurring payment stream.
///
/// Prevents creation of future periods but does not affect already-created child streams.
/// Only the creator or admin can cancel.
///
/// # Arguments
/// * `env` - The contract environment
/// * `caller` - Address attempting to cancel
/// * `recurring_stream_id` - ID of the recurring stream to cancel
///
/// # Returns
/// Returns Ok if cancellation succeeds
///
/// # Errors
/// * `Error::Unauthorized` - Caller is not the creator or admin
/// * `Error::NotFound` - Recurring stream does not exist
pub fn cancel_recurring_stream(
    env: &Env,
    caller: &Address,
    recurring_stream_id: u64,
) -> Result<(), Error> {
    caller.require_auth();

    let mut stream = storage::get_recurring_stream(env, recurring_stream_id)
        .ok_or(Error::NotFound)?;

    // Only creator or admin can cancel
    if caller != &stream.creator && caller != &storage::get_admin(env) {
        return Err(Error::Unauthorized);
    }

    // Mark as cancelled
    stream.cancelled = true;
    stream.auto_renew_enabled = false;

    storage::set_recurring_stream(env, recurring_stream_id, &stream);

    events::emit_recurring_stream_cancelled(env, recurring_stream_id, caller);

    Ok(())
}

/// Disable auto-renewal for a recurring stream.
///
/// This prevents new periods from being created after the current period ends.
/// Existing and in-progress periods remain claimable.
/// Only the creator can disable auto-renewal.
///
/// # Arguments
/// * `env` - The contract environment
/// * `caller` - Address attempting to disable auto-renewal
/// * `recurring_stream_id` - ID of the recurring stream
///
/// # Returns
/// Returns Ok if successful
///
/// # Errors
/// * `Error::Unauthorized` - Caller is not the creator
/// * `Error::NotFound` - Recurring stream does not exist
pub fn disable_auto_renewal(
    env: &Env,
    caller: &Address,
    recurring_stream_id: u64,
) -> Result<(), Error> {
    caller.require_auth();

    let mut stream = storage::get_recurring_stream(env, recurring_stream_id)
        .ok_or(Error::NotFound)?;

    // Only creator can disable auto-renewal
    if caller != &stream.creator {
        return Err(Error::Unauthorized);
    }

    stream.auto_renew_enabled = false;

    storage::set_recurring_stream(env, recurring_stream_id, &stream);

    events::emit_auto_renewal_disabled(env, recurring_stream_id);

    Ok(())
}

/// Tick a recurring stream to create the next period if needed.
///
/// This is called automatically by the ledger and creates a new child stream
/// when the current period has ended.
///
/// # Arguments
/// * `env` - The contract environment
/// * `recurring_stream_id` - ID of the recurring stream to tick
///
/// # Returns
/// Returns the new child stream ID if a new period was created, None if no action was needed
///
/// # Errors
/// * `Error::NotFound` - Recurring stream does not exist
pub fn tick_recurring_stream(env: &Env, recurring_stream_id: u64) -> Result<Option<u64>, Error> {
    let mut stream = storage::get_recurring_stream(env, recurring_stream_id)
        .ok_or(Error::NotFound)?;

    if stream.cancelled {
        return Ok(None);
    }

    let current_ledger = env.ledger().sequence();

    // Check if current period has ended
    let period_end_ledger = stream
        .current_period_start_ledger
        .checked_add(stream.period_ledgers)
        .ok_or(Error::ArithmeticError)?;

    if current_ledger < period_end_ledger {
        // Current period hasn't ended yet
        return Ok(None);
    }

    // Check if we should create a new period
    let should_create_next = if stream.total_periods == 0 {
        // Unlimited periods with auto-renewal
        stream.auto_renew_enabled
    } else {
        // Limited periods
        stream.auto_renew_enabled && stream.periods_created < stream.total_periods
    };

    if !should_create_next {
        return Ok(None);
    }

    // Check child streams limit
    if stream.child_streams.len() as u32 >= MAX_CHILD_STREAMS {
        return Err(Error::InvalidParameters);
    }

    // Create next child stream
    let next_period_index = stream.periods_created;
    let new_vault_id = create_child_stream(
        env,
        &stream.creator,
        recurring_stream_id,
        &stream.recipient,
        stream.amount_per_period,
        period_end_ledger,
        stream.period_ledgers,
        next_period_index,
    )?;

    // Update recurring stream
    stream.periods_created = stream
        .periods_created
        .checked_add(1)
        .ok_or(Error::ArithmeticError)?;
    stream.current_period_start_ledger = period_end_ledger;
    stream.child_streams.push_back(new_vault_id);

    storage::set_recurring_stream(env, recurring_stream_id, &stream);

    events::emit_recurring_stream_period_created(env, recurring_stream_id, next_period_index, new_vault_id);

    Ok(Some(new_vault_id))
}

/// Internal helper to create a child stream (vault) for a recurring stream period.
///
/// # Arguments
/// * `env` - The contract environment
/// * `creator` - The creator of the recurring stream (becomes vault creator)
/// * `recurring_stream_id` - ID of the parent recurring stream
/// * `recipient` - Payment recipient
/// * `amount` - Amount for this period
/// * `start_ledger` - Ledger when this period starts
/// * `period_ledgers` - Duration of the period in ledgers
/// * `period_index` - Which period this is (0-indexed)
///
/// # Returns
/// Returns the new vault ID
///
/// # Errors
/// * Various vault creation errors
fn create_child_stream(
    env: &Env,
    creator: &Address,
    recurring_stream_id: u64,
    recipient: &Address,
    amount: i128,
    start_ledger: u64,
    period_ledgers: u64,
    period_index: u32,
) -> Result<u64, Error> {
    // Get next vault ID
    let vault_id = storage::increment_vault_count(env)?;

    let end_ledger = start_ledger
        .checked_add(period_ledgers)
        .ok_or(Error::ArithmeticError)?;

    // Create vault for this period
    let vault = Vault {
        id: vault_id,
        token: Address::from_contract_id(env, &soroban_sdk::ContractId::from_array(
            env,
            &[0u8; 32],
        )), // Placeholder - actual token would be passed in params
        owner: recipient.clone(),
        creator: creator.clone(),
        total_amount: amount,
        claimed_amount: 0,
        unlock_time: end_ledger,
        milestone_hash: soroban_sdk::BytesN::from_array(env, &[0u8; 32]),
        status: VaultStatus::Created,
        created_at: env.ledger().timestamp(),
        verifier: None,
        milestone_verified: false,
    };

    storage::set_vault(env, &vault)?;

    events::emit_recurring_stream_child_created(
        env,
        recurring_stream_id,
        period_index,
        vault_id,
        recipient,
        amount,
    );

    Ok(vault_id)
}

/// Validate recurring stream parameters.
fn validate_recurring_stream_params(params: &RecurringStreamParams) -> Result<(), Error> {
    // Validate amount
    if params.amount_per_period <= 0 {
        return Err(Error::InvalidParameters);
    }

    // Validate period length
    if params.period_ledgers == 0 {
        return Err(Error::InvalidParameters);
    }

    // Validate total periods
    if params.total_periods > MAX_TOTAL_PERIODS && params.total_periods != 0 {
        return Err(Error::InvalidParameters);
    }

    // If auto_renew is false, must have a positive total_periods
    if !params.auto_renew && params.total_periods == 0 {
        return Err(Error::InvalidParameters);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    #[test]
    fn test_create_recurring_stream() {
        let env = Env::default();
        env.mock_all_auths();

        let creator = Address::random(&env);
        let recipient = Address::random(&env);

        let params = RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: 1_000_000,
            period_ledgers: 1000,
            total_periods: 10,
            auto_renew: false,
        };

        let stream_id = create_recurring_stream(&env, &creator, &params).expect("Failed to create recurring stream");

        assert_eq!(stream_id, 0); // First recurring stream

        let stream = storage::get_recurring_stream(&env, stream_id).expect("Stream not found");
        assert_eq!(stream.creator, creator);
        assert_eq!(stream.recipient, recipient);
        assert_eq!(stream.amount_per_period, 1_000_000);
        assert_eq!(stream.period_ledgers, 1000);
        assert_eq!(stream.total_periods, 10);
        assert_eq!(stream.periods_created, 1); // First period created immediately
        assert_eq!(stream.child_streams.len(), 1);
        assert!(!stream.cancelled);
    }

    #[test]
    fn test_cancel_recurring_stream_by_creator() {
        let env = Env::default();
        env.mock_all_auths();

        let creator = Address::random(&env);
        let recipient = Address::random(&env);

        let params = RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: 500_000,
            period_ledgers: 500,
            total_periods: 5,
            auto_renew: true,
        };

        let stream_id = create_recurring_stream(&env, &creator, &params).expect("Failed to create");

        // Cancel by creator
        cancel_recurring_stream(&env, &creator, stream_id).expect("Failed to cancel");

        let stream = storage::get_recurring_stream(&env, stream_id).expect("Stream not found");
        assert!(stream.cancelled);
        assert!(!stream.auto_renew_enabled);
    }

    #[test]
    fn test_disable_auto_renewal() {
        let env = Env::default();
        env.mock_all_auths();

        let creator = Address::random(&env);
        let recipient = Address::random(&env);

        let params = RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: 1_000_000,
            period_ledgers: 1000,
            total_periods: 0, // Unlimited
            auto_renew: true,
        };

        let stream_id = create_recurring_stream(&env, &creator, &params).expect("Failed to create");

        let stream_before = storage::get_recurring_stream(&env, stream_id).expect("Stream not found");
        assert!(stream_before.auto_renew_enabled);

        // Disable auto-renewal
        disable_auto_renewal(&env, &creator, stream_id).expect("Failed to disable");

        let stream_after = storage::get_recurring_stream(&env, stream_id).expect("Stream not found");
        assert!(!stream_after.auto_renew_enabled);
        assert!(!stream_after.cancelled); // Not cancelled, just auto-renew disabled
    }

    #[test]
    #[should_panic(expected = "Error(Contract, ")]
    fn test_create_recurring_stream_invalid_amount() {
        let env = Env::default();
        env.mock_all_auths();

        let creator = Address::random(&env);
        let recipient = Address::random(&env);

        let params = RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: -1, // Invalid: negative amount
            period_ledgers: 1000,
            total_periods: 10,
            auto_renew: false,
        };

        let _ = create_recurring_stream(&env, &creator, &params);
    }

    #[test]
    #[should_panic(expected = "Error(Contract, ")]
    fn test_create_recurring_stream_zero_period() {
        let env = Env::default();
        env.mock_all_auths();

        let creator = Address::random(&env);
        let recipient = Address::random(&env);

        let params = RecurringStreamParams {
            recipient: recipient.clone(),
            amount_per_period: 1_000_000,
            period_ledgers: 0, // Invalid: zero period
            total_periods: 10,
            auto_renew: false,
        };

        let _ = create_recurring_stream(&env, &creator, &params);
    }
}
