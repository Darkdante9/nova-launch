#![cfg(test)]

//! Property-based tests for campaign state machine transitions
//!
//! Covers all invalid transition permutations using proptest strategies.
//! Regression seeds are persisted in proptest-regressions/campaign_state_machine.txt
//!
//! Closes #1284

extern crate std;

use crate::campaign::validate_state_transition;
use crate::types::{CampaignStatus, Error};
use proptest::prelude::*;

// ---------------------------------------------------------------------------
// Strategy: arbitrary CampaignStatus
// ---------------------------------------------------------------------------

fn arb_status() -> impl Strategy<Value = CampaignStatus> {
    prop_oneof![
        Just(CampaignStatus::Active),
        Just(CampaignStatus::Paused),
        Just(CampaignStatus::Completed),
        Just(CampaignStatus::Cancelled),
        Just(CampaignStatus::Expired),
    ]
}

// ---------------------------------------------------------------------------
// Valid transitions table (derived from campaign.rs)
// ---------------------------------------------------------------------------

fn is_valid_transition(from: CampaignStatus, to: CampaignStatus) -> bool {
    matches!(
        (from, to),
        (CampaignStatus::Active, CampaignStatus::Paused)
            | (CampaignStatus::Paused, CampaignStatus::Active)
            | (CampaignStatus::Active, CampaignStatus::Completed)
            | (CampaignStatus::Active, CampaignStatus::Cancelled)
            | (CampaignStatus::Paused, CampaignStatus::Cancelled)
    )
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 500,
        max_shrink_iters: 1000,
        source_file: Some("src/campaign_state_machine_proptest.rs"),
        ..ProptestConfig::default()
    })]

    /// Every invalid (from, to) pair must return InvalidStateTransition.
    #[test]
    fn prop_invalid_transitions_return_error(
        from in arb_status(),
        to in arb_status(),
    ) {
        if !is_valid_transition(from, to) {
            prop_assert_eq!(
                validate_state_transition(from, to),
                Err(Error::InvalidStateTransition),
                "Expected InvalidStateTransition for {:?} -> {:?}",
                from,
                to
            );
        }
    }

    /// Every valid (from, to) pair must return Ok(()).
    #[test]
    fn prop_valid_transitions_return_ok(
        from in arb_status(),
        to in arb_status(),
    ) {
        if is_valid_transition(from, to) {
            prop_assert!(
                validate_state_transition(from, to).is_ok(),
                "Expected Ok for {:?} -> {:?}",
                from,
                to
            );
        }
    }

    /// Terminal states (Completed, Cancelled, Expired) must reject any target state.
    #[test]
    fn prop_terminal_states_reject_all_transitions(to in arb_status()) {
        for terminal in [
            CampaignStatus::Completed,
            CampaignStatus::Cancelled,
            CampaignStatus::Expired,
        ] {
            prop_assert_eq!(
                validate_state_transition(terminal, to),
                Err(Error::InvalidStateTransition),
                "Terminal state {:?} should reject transition to {:?}",
                terminal,
                to
            );
        }
    }

    /// Replay-protection: same-state transitions are always invalid.
    #[test]
    fn prop_same_state_transitions_are_invalid(status in arb_status()) {
        prop_assert_eq!(
            validate_state_transition(status, status),
            Err(Error::InvalidStateTransition),
            "Self-transition {:?} -> {:?} should be invalid",
            status,
            status
        );
    }
}

// ---------------------------------------------------------------------------
// Exhaustive enumeration of all 15 documented invalid paths
// ---------------------------------------------------------------------------

#[cfg(test)]
mod exhaustive {
    use super::*;

    fn check_invalid(from: CampaignStatus, to: CampaignStatus) {
        assert_eq!(
            validate_state_transition(from, to),
            Err(Error::InvalidStateTransition),
            "{:?} -> {:?} should be InvalidStateTransition",
            from,
            to
        );
    }

    fn check_valid(from: CampaignStatus, to: CampaignStatus) {
        assert!(
            validate_state_transition(from, to).is_ok(),
            "{:?} -> {:?} should be Ok",
            from,
            to
        );
    }

    #[test]
    fn all_valid_transitions_pass() {
        check_valid(CampaignStatus::Active, CampaignStatus::Paused);
        check_valid(CampaignStatus::Paused, CampaignStatus::Active);
        check_valid(CampaignStatus::Active, CampaignStatus::Completed);
        check_valid(CampaignStatus::Active, CampaignStatus::Cancelled);
        check_valid(CampaignStatus::Paused, CampaignStatus::Cancelled);
    }

    #[test]
    fn replay_protection_active_to_active() {
        check_invalid(CampaignStatus::Active, CampaignStatus::Active);
    }

    #[test]
    fn replay_protection_paused_to_paused() {
        check_invalid(CampaignStatus::Paused, CampaignStatus::Paused);
    }

    #[test]
    fn paused_cannot_transition_to_completed() {
        check_invalid(CampaignStatus::Paused, CampaignStatus::Completed);
    }

    #[test]
    fn paused_cannot_transition_to_expired() {
        check_invalid(CampaignStatus::Paused, CampaignStatus::Expired);
    }

    #[test]
    fn active_cannot_transition_to_expired() {
        check_invalid(CampaignStatus::Active, CampaignStatus::Expired);
    }

    #[test]
    fn completed_cannot_transition_to_active() {
        check_invalid(CampaignStatus::Completed, CampaignStatus::Active);
    }

    #[test]
    fn completed_cannot_transition_to_paused() {
        check_invalid(CampaignStatus::Completed, CampaignStatus::Paused);
    }

    #[test]
    fn completed_cannot_transition_to_completed() {
        check_invalid(CampaignStatus::Completed, CampaignStatus::Completed);
    }

    #[test]
    fn completed_cannot_transition_to_cancelled() {
        check_invalid(CampaignStatus::Completed, CampaignStatus::Cancelled);
    }

    #[test]
    fn completed_cannot_transition_to_expired() {
        check_invalid(CampaignStatus::Completed, CampaignStatus::Expired);
    }

    #[test]
    fn cancelled_cannot_transition_to_active() {
        check_invalid(CampaignStatus::Cancelled, CampaignStatus::Active);
    }

    #[test]
    fn cancelled_cannot_transition_to_paused() {
        check_invalid(CampaignStatus::Cancelled, CampaignStatus::Paused);
    }

    #[test]
    fn cancelled_cannot_transition_to_completed() {
        check_invalid(CampaignStatus::Cancelled, CampaignStatus::Completed);
    }

    #[test]
    fn cancelled_cannot_transition_to_cancelled() {
        check_invalid(CampaignStatus::Cancelled, CampaignStatus::Cancelled);
    }

    #[test]
    fn cancelled_cannot_transition_to_expired() {
        check_invalid(CampaignStatus::Cancelled, CampaignStatus::Expired);
    }
}
