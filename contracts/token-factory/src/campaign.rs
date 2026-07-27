//! Campaign Management Module
//!
//! This module provides operational control over treasury-driven buyback-and-burn campaigns.
//! It enforces strict state transitions with replay resistance and governance authorization.
//!
//! ## State Transitions
//!
//! Valid state transitions:
//! - Active -> Paused (via pause_campaign)
//! - Paused -> Active (via resume_campaign)
//! - Active -> Completed (via complete_campaign)
//! - Active -> Cancelled (via cancel_campaign)
//! - Paused -> Cancelled (via cancel_campaign)
//!
//! Invalid transitions (will return Error::InvalidStateTransition):
//! - Paused -> Paused (replay protection)
//! - Active -> Active (replay protection)
//! - Completed -> any state (terminal state)
//! - Cancelled -> any state (terminal state)

use crate::events;
use crate::storage;
use crate::types::{BuybackCampaign, CampaignStatus, Error};
use soroban_sdk::{Address, Env};

/// Pause an active campaign
///
/// Temporarily suspends campaign operations in response to market conditions
/// or protocol risk. Only the campaign owner or admin can pause a campaign.
///
/// # State Transition
/// Active -> Paused
///
/// # Arguments
/// * `env` - The contract environment
/// * `caller` - Address requesting the pause (must be owner or admin)
/// * `campaign_id` - ID of the campaign to pause
///
/// # Returns
/// * `Ok(())` - Campaign successfully paused
/// * `Err(Error::CampaignNotFound)` - Campaign does not exist
/// * `Err(Error::Unauthorized)` - Caller is not owner or admin
/// * `Err(Error::CampaignAlreadyPaused)` - Campaign is already paused (replay protection)
/// * `Err(Error::CampaignCompleted)` - Cannot pause completed campaign
/// * `Err(Error::CampaignCancelled)` - Cannot pause cancelled campaign
/// * `Err(Error::InvalidStateTransition)` - Invalid state transition
///
/// # Examples
/// ```ignore
/// pause_campaign(&env, &admin, 1)?;
/// ```
pub fn pause_campaign(env: &Env, caller: &Address, campaign_id: u64) -> Result<(), Error> {
    caller.require_auth();

    // Load campaign
    let mut campaign = storage::get_campaign(env, campaign_id).ok_or(Error::CampaignNotFound)?;

    // Authorization check: must be owner or admin
    let admin = storage::get_admin(env);
    if *caller != campaign.owner && *caller != admin {
        return Err(Error::Unauthorized);
    }

    // State transition validation with replay protection
    match campaign.status {
        CampaignStatus::Active => {
            // Valid transition: Active -> Paused
            campaign.status = CampaignStatus::Paused;
        }
        CampaignStatus::Paused => {
            // Replay protection: already paused
            return Err(Error::CampaignAlreadyPaused);
        }
        CampaignStatus::Completed => {
            // Terminal state: cannot pause completed campaign
            return Err(Error::CampaignCompleted);
        }
        CampaignStatus::Cancelled => {
            // Terminal state: cannot pause cancelled campaign
            return Err(Error::CampaignCancelled);
        }
        CampaignStatus::Expired => {
            // Terminal state: cannot pause expired campaign
            return Err(Error::CampaignExpiredError);
        }
    }

    // Persist state change
    storage::set_campaign(env, campaign_id, &campaign);

    // Emit event
    events::emit_campaign_paused(env, campaign_id, caller);

    Ok(())
}

/// Resume a paused campaign
///
/// Resumes campaign operations after a pause. Only the campaign owner or admin
/// can resume a campaign.
///
/// # State Transition
/// Paused -> Active
///
/// # Arguments
/// * `env` - The contract environment
/// * `caller` - Address requesting the resume (must be owner or admin)
/// * `campaign_id` - ID of the campaign to resume
///
/// # Returns
/// * `Ok(())` - Campaign successfully resumed
/// * `Err(Error::CampaignNotFound)` - Campaign does not exist
/// * `Err(Error::Unauthorized)` - Caller is not owner or admin
/// * `Err(Error::CampaignNotPaused)` - Campaign is not paused (replay protection)
/// * `Err(Error::CampaignCompleted)` - Cannot resume completed campaign
/// * `Err(Error::CampaignCancelled)` - Cannot resume cancelled campaign
/// * `Err(Error::InvalidStateTransition)` - Invalid state transition
///
/// # Examples
/// ```ignore
/// resume_campaign(&env, &admin, 1)?;
/// ```
pub fn resume_campaign(env: &Env, caller: &Address, campaign_id: u64) -> Result<(), Error> {
    caller.require_auth();

    // Load campaign
    let mut campaign = storage::get_campaign(env, campaign_id).ok_or(Error::CampaignNotFound)?;

    // Authorization check: must be owner or admin
    let admin = storage::get_admin(env);
    if *caller != campaign.owner && *caller != admin {
        return Err(Error::Unauthorized);
    }

    // State transition validation with replay protection
    match campaign.status {
        CampaignStatus::Paused => {
            // Valid transition: Paused -> Active
            campaign.status = CampaignStatus::Active;
        }
        CampaignStatus::Active => {
            // Replay protection: already active
            return Err(Error::CampaignNotPaused);
        }
        CampaignStatus::Completed => {
            // Terminal state: cannot resume completed campaign
            return Err(Error::CampaignCompleted);
        }
        CampaignStatus::Cancelled => {
            // Terminal state: cannot resume cancelled campaign
            return Err(Error::CampaignCancelled);
        }
        CampaignStatus::Expired => {
            // Terminal state: cannot resume expired campaign
            return Err(Error::CampaignExpiredError);
        }
    }

    // Persist state change
    storage::set_campaign(env, campaign_id, &campaign);

    // Emit event
    events::emit_campaign_resumed(env, campaign_id, caller);

    Ok(())
}

/// Finalize a campaign, transitioning it to Completed.
///
/// Only the campaign owner or admin may finalize. The campaign must be Active
/// or Paused. If finalization fails (e.g. arithmetic), the campaign remains in
/// its current state so the caller can retry safely.
///
/// # State Transitions
/// Active | Paused -> Completed
///
/// # Errors
/// * `CampaignNotFound`       – campaign does not exist
/// * `Unauthorized`           – caller is not owner or admin
/// * `CampaignCompleted`      – already completed (terminal)
/// * `CampaignCancelled`      – already cancelled (terminal)
/// * `CampaignFinalizationFailed` – internal error; state unchanged, retry is safe
pub fn finalize_campaign(env: &Env, caller: &Address, campaign_id: u64) -> Result<(), Error> {
    caller.require_auth();

    let mut campaign = storage::get_campaign(env, campaign_id).ok_or(Error::CampaignNotFound)?;

    let admin = storage::get_admin(env);
    if *caller != campaign.owner && *caller != admin {
        return Err(Error::Unauthorized);
    }

    match campaign.status {
        CampaignStatus::Active | CampaignStatus::Paused => {}
        CampaignStatus::Completed => return Err(Error::CampaignCompleted),
        CampaignStatus::Cancelled => return Err(Error::CampaignCancelled),
        CampaignStatus::Expired => return Err(Error::CampaignCompleted),
    }

    campaign.status = CampaignStatus::Completed;
    storage::set_campaign(env, campaign_id, &campaign);

    events::emit_campaign_finalized(env, campaign_id, caller);

    Ok(())
}

/// Retry a failed finalization attempt.
///
/// Idempotent: if the campaign is already Completed this is a no-op success,
/// allowing callers to safely retry without checking state first.
///
/// # Errors
/// * `CampaignNotFound`  – campaign does not exist
/// * `Unauthorized`      – caller is not owner or admin
/// * `CampaignCancelled` – cancelled campaigns cannot be finalized
pub fn retry_finalize_campaign(env: &Env, caller: &Address, campaign_id: u64) -> Result<(), Error> {
    caller.require_auth();

    let campaign = storage::get_campaign(env, campaign_id).ok_or(Error::CampaignNotFound)?;

    let admin = storage::get_admin(env);
    if *caller != campaign.owner && *caller != admin {
        return Err(Error::Unauthorized);
    }

    // Already completed — idempotent success
    if campaign.status == CampaignStatus::Completed {
        return Ok(());
    }

    if campaign.status == CampaignStatus::Cancelled {
        return Err(Error::CampaignCancelled);
    }

    finalize_campaign(env, caller, campaign_id)
}

/// Validate campaign state transition
///
/// Helper function to check if a state transition is valid.
///
/// # Arguments
/// * `from` - Current campaign status
/// * `to` - Desired campaign status
///
/// # Returns
/// * `Ok(())` - Transition is valid
/// * `Err(Error::InvalidStateTransition)` - Transition is invalid
pub fn validate_state_transition(from: CampaignStatus, to: CampaignStatus) -> Result<(), Error> {
    match (from, to) {
        // Valid transitions
        (CampaignStatus::Active, CampaignStatus::Paused) => Ok(()),
        (CampaignStatus::Paused, CampaignStatus::Active) => Ok(()),
        (CampaignStatus::Active, CampaignStatus::Completed) => Ok(()),
        (CampaignStatus::Active, CampaignStatus::Cancelled) => Ok(()),
        (CampaignStatus::Paused, CampaignStatus::Cancelled) => Ok(()),
        
        // Invalid transitions (including replay attempts)
        _ => Err(Error::InvalidStateTransition),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::TestEnv;
    use soroban_sdk::testutils::Address as _;

    fn make_campaign(env: &soroban_sdk::Env, owner: &Address, status: CampaignStatus) -> BuybackCampaign {
        let dummy = Address::generate(env);
        BuybackCampaign {
            id: 1,
            token_index: 0,
            owner: owner.clone(),
            budget: 1_000_000,
            spent: 0,
            tokens_bought: 0,
            execution_count: 0,
            start_time: env.ledger().timestamp(),
            end_time: env.ledger().timestamp() + 86400,
            min_interval: 300,
            max_slippage_bps: 100,
            source_token: dummy.clone(),
            target_token: dummy,
            status,
            created_at: env.ledger().timestamp(),
            updated_at: env.ledger().timestamp(),
            trigger_price: 0,
            last_executed_at: 0,
        }
    }

    #[test]
    fn test_pause_active_campaign() {
        let test_env = TestEnv::new();
        let env = &test_env.env;
        let admin = &test_env.admin;

        env.as_contract(&env.current_contract_address(), || {
            let campaign = make_campaign(env, admin, CampaignStatus::Active);
            storage::set_campaign(env, 1, &campaign);

            let result = pause_campaign(env, admin, 1);
            assert!(result.is_ok());

            let updated = storage::get_campaign(env, 1).unwrap();
            assert_eq!(updated.status, CampaignStatus::Paused);
        });
    }

    #[test]
    fn test_pause_already_paused_campaign_fails() {
        let test_env = TestEnv::new();
        let env = &test_env.env;
        let admin = &test_env.admin;

        env.as_contract(&env.current_contract_address(), || {
            let campaign = make_campaign(env, admin, CampaignStatus::Paused);
            storage::set_campaign(env, 1, &campaign);

            let result = pause_campaign(env, admin, 1);
            assert_eq!(result, Err(Error::CampaignAlreadyPaused));
        });
    }

    #[test]
    fn test_resume_paused_campaign() {
        let test_env = TestEnv::new();
        let env = &test_env.env;
        let admin = &test_env.admin;

        env.as_contract(&env.current_contract_address(), || {
            let campaign = make_campaign(env, admin, CampaignStatus::Paused);
            storage::set_campaign(env, 1, &campaign);

            let result = resume_campaign(env, admin, 1);
            assert!(result.is_ok());

            let updated = storage::get_campaign(env, 1).unwrap();
            assert_eq!(updated.status, CampaignStatus::Active);
        });
    }

    #[test]
    fn test_resume_active_campaign_fails() {
        let test_env = TestEnv::new();
        let env = &test_env.env;
        let admin = &test_env.admin;

        env.as_contract(&env.current_contract_address(), || {
            let campaign = make_campaign(env, admin, CampaignStatus::Active);
            storage::set_campaign(env, 1, &campaign);

            let result = resume_campaign(env, admin, 1);
            assert_eq!(result, Err(Error::CampaignNotPaused));
        });
    }

    #[test]
    fn test_pause_completed_campaign_fails() {
        let test_env = TestEnv::new();
        let env = &test_env.env;
        let admin = &test_env.admin;

        env.as_contract(&env.current_contract_address(), || {
            let campaign = make_campaign(env, admin, CampaignStatus::Completed);
            storage::set_campaign(env, 1, &campaign);

            let result = pause_campaign(env, admin, 1);
            assert_eq!(result, Err(Error::CampaignCompleted));
        });
    }

    #[test]
    fn test_unauthorized_pause_fails() {
        let test_env = TestEnv::new();
        let env = &test_env.env;
        let admin = &test_env.admin;
        let attacker = Address::generate(env);

        env.as_contract(&env.current_contract_address(), || {
            let campaign = make_campaign(env, admin, CampaignStatus::Active);
            storage::set_campaign(env, 1, &campaign);

            let result = pause_campaign(env, &attacker, 1);
            assert_eq!(result, Err(Error::Unauthorized));
        });
    }

    #[test]
    fn test_state_transition_validation() {
        // Valid transitions
        assert!(validate_state_transition(
            CampaignStatus::Active,
            CampaignStatus::Paused
        ).is_ok());
        assert!(validate_state_transition(
            CampaignStatus::Paused,
            CampaignStatus::Active
        ).is_ok());
        assert!(validate_state_transition(
            CampaignStatus::Active,
            CampaignStatus::Completed
        ).is_ok());
        assert!(validate_state_transition(
            CampaignStatus::Active,
            CampaignStatus::Cancelled
        ).is_ok());
        assert!(validate_state_transition(
            CampaignStatus::Paused,
            CampaignStatus::Cancelled
        ).is_ok());

        // Invalid transitions (replay protection)
        assert_eq!(
            validate_state_transition(CampaignStatus::Active, CampaignStatus::Active),
            Err(Error::InvalidStateTransition)
        );
        assert_eq!(
            validate_state_transition(CampaignStatus::Paused, CampaignStatus::Paused),
            Err(Error::InvalidStateTransition)
        );

        // Terminal state transitions
        assert_eq!(
            validate_state_transition(CampaignStatus::Completed, CampaignStatus::Active),
            Err(Error::InvalidStateTransition)
        );
        assert_eq!(
            validate_state_transition(CampaignStatus::Cancelled, CampaignStatus::Active),
            Err(Error::InvalidStateTransition)
        );
    }

    #[test]
    fn test_finalize_active_campaign() {
        let test_env = TestEnv::new();
        let env = &test_env.env;
        let admin = &test_env.admin;

        env.as_contract(&env.current_contract_address(), || {
            let campaign = make_campaign(env, admin, CampaignStatus::Active);
            storage::set_campaign(env, 1, &campaign);

            finalize_campaign(env, admin, 1).unwrap();
            let updated = storage::get_campaign(env, 1).unwrap();
            assert_eq!(updated.status, CampaignStatus::Completed);
        });
    }

    #[test]
    fn test_finalize_paused_campaign() {
        let test_env = TestEnv::new();
        let env = &test_env.env;
        let admin = &test_env.admin;

        env.as_contract(&env.current_contract_address(), || {
            let campaign = make_campaign(env, admin, CampaignStatus::Paused);
            storage::set_campaign(env, 1, &campaign);

            finalize_campaign(env, admin, 1).unwrap();
            let updated = storage::get_campaign(env, 1).unwrap();
            assert_eq!(updated.status, CampaignStatus::Completed);
        });
    }

    #[test]
    fn test_finalize_completed_campaign_fails() {
        let test_env = TestEnv::new();
        let env = &test_env.env;
        let admin = &test_env.admin;

        env.as_contract(&env.current_contract_address(), || {
            let campaign = make_campaign(env, admin, CampaignStatus::Completed);
            storage::set_campaign(env, 1, &campaign);

            let err = finalize_campaign(env, admin, 1).unwrap_err();
            assert_eq!(err, Error::CampaignCompleted);
        });
    }

    #[test]
    fn test_retry_finalize_idempotent_when_completed() {
        let test_env = TestEnv::new();
        let env = &test_env.env;
        let admin = &test_env.admin;

        env.as_contract(&env.current_contract_address(), || {
            let campaign = make_campaign(env, admin, CampaignStatus::Completed);
            storage::set_campaign(env, 1, &campaign);

            // Should succeed silently (idempotent)
            retry_finalize_campaign(env, admin, 1).unwrap();
        });
    }

    #[test]
    fn test_retry_finalize_cancelled_fails() {
        let test_env = TestEnv::new();
        let env = &test_env.env;
        let admin = &test_env.admin;

        env.as_contract(&env.current_contract_address(), || {
            let campaign = make_campaign(env, admin, CampaignStatus::Cancelled);
            storage::set_campaign(env, 1, &campaign);

            let err = retry_finalize_campaign(env, admin, 1).unwrap_err();
            assert_eq!(err, Error::CampaignCancelled);
        });
    }
}
