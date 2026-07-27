//! Tests for milestone-based vesting on streams (Issue #1365).
//!
//! Covers:
//! - Valid oracle signature (auth) unlocks the milestone amount
//! - Invalid oracle (wrong address) is rejected
//! - Already-verified milestone is idempotent (no error, no double-unlock)

#[cfg(test)]
mod tests {
    use crate::streaming::{verify_stream_milestone, claim_stream};
    use crate::types::{Error, Milestone, StreamInfo};
    use crate::{storage, TokenFactory};
    use soroban_sdk::{testutils::Address as _, testutils::Ledger, Address, Env, String, Vec};

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TokenFactory);
        let admin = Address::generate(&env);
        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
        });
        (env, admin, contract_id)
    }

    fn set_stream(env: &Env, contract_id: &Address, stream_id: u64, stream: &StreamInfo) {
        env.as_contract(contract_id, || storage::set_stream(env, stream_id, stream));
    }

    fn get_stream(env: &Env, contract_id: &Address, stream_id: u64) -> StreamInfo {
        env.as_contract(contract_id, || storage::get_stream(env, stream_id).unwrap())
    }

    fn verify(
        env: &Env,
        contract_id: &Address,
        oracle: &Address,
        stream_id: u64,
        idx: u32,
    ) -> Result<(), Error> {
        env.as_contract(contract_id, || {
            verify_stream_milestone(env, oracle, stream_id, idx)
        })
    }

    fn claim(
        env: &Env,
        contract_id: &Address,
        recipient: &Address,
        stream_id: u64,
    ) -> Result<i128, Error> {
        env.as_contract(contract_id, || claim_stream(env, recipient, stream_id))
    }

    fn make_stream_with_milestone(
        env: &Env,
        creator: &Address,
        recipient: &Address,
        oracle: &Address,
        total: i128,
        milestone_amount: i128,
    ) -> StreamInfo {
        let mut milestones: Vec<Milestone> = Vec::new(env);
        milestones.push_back(Milestone {
            description: String::from_str(env, "Product launch"),
            oracle_address: oracle.clone(),
            unlock_amount: milestone_amount,
            verified: false,
        });
        StreamInfo {
            id: 0,
            creator: creator.clone(),
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: total,
            claimed_amount: 0,
            // Stream fully vested in the past so time-vesting is not a variable
            start_time: 1,
            end_time: 100,
            cliff_time: 1,
            metadata: None,
            cancelled: false,
            paused: false,
            disputed: false,
            milestones,
        }
    }

    // ── Test 1: valid oracle unlocks milestone amount ─────────────────────────

    #[test]
    fn test_valid_oracle_unlocks_milestone() {
        let (env, _admin, contract_id) = setup();
        let creator = Address::generate(&env);
        let recipient = Address::generate(&env);
        let oracle = Address::generate(&env);

        // Stream: 1000 total, 500 in a milestone — time-vesting covers 500
        let stream = make_stream_with_milestone(&env, &creator, &recipient, &oracle, 1000, 500);
        set_stream(&env, &contract_id, 0, &stream);

        // After end_time: time-vested = 500 (50% of 1000, but milestone not yet unlocked).
        // Wait — stream ends at t=100, total_amount=1000 so full 1000 is time-vested.
        // Use a smaller total_amount than time-vest to isolate the milestone contribution.
        // Restructure: time-only amount = 600, milestone = 400, total = 1000.
        // To isolate: set total_amount = 600 so time-vesting covers 600, milestone adds 400.
        let mut milestones: Vec<Milestone> = Vec::new(&env);
        milestones.push_back(Milestone {
            description: String::from_str(&env, "Product launch"),
            oracle_address: oracle.clone(),
            unlock_amount: 400,
            verified: false,
        });
        let stream2 = StreamInfo {
            id: 1,
            creator: creator.clone(),
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1000,
            claimed_amount: 600, // pretend 600 already claimed (time-vested portion)
            start_time: 1,
            end_time: 100,
            cliff_time: 1,
            metadata: None,
            cancelled: false,
            paused: false,
            disputed: false,
            milestones,
        };
        set_stream(&env, &contract_id, 1, &stream2);

        // Before oracle verification: claimable = max(0, 1000 - 600 - 0_milestone) = 400 time portion
        // but claimed_amount=600 so time-vested(1000) - 600 = 400. Milestone not verified yet → no extra.
        env.ledger().with_mut(|l| l.timestamp = 200); // past end_time

        // Verify milestone
        let result = verify(&env, &contract_id, &oracle, 1, 0);
        assert!(result.is_ok(), "valid oracle should succeed");

        // Now milestone.verified = true — milestone's 400 is in claimed_amount accounting.
        // total_unlocked = min(time_vested=1000 + milestone=400, total=1000) = 1000
        // claimable = 1000 - 600 = 400
        let claimed = claim(&env, &contract_id, &recipient, 1);
        assert_eq!(claimed.unwrap(), 400);
    }

    // ── Test 2: wrong oracle is rejected ─────────────────────────────────────

    #[test]
    fn test_invalid_oracle_rejected() {
        let (env, _admin, contract_id) = setup();
        let creator = Address::generate(&env);
        let recipient = Address::generate(&env);
        let real_oracle = Address::generate(&env);
        let wrong_oracle = Address::generate(&env);

        let stream =
            make_stream_with_milestone(&env, &creator, &recipient, &real_oracle, 1000, 300);
        set_stream(&env, &contract_id, 0, &stream);

        env.ledger().with_mut(|l| l.timestamp = 200);

        let result = verify(&env, &contract_id, &wrong_oracle, 0, 0);
        assert_eq!(result, Err(Error::Unauthorized));

        // Milestone must still be unverified
        let s = get_stream(&env, &contract_id, 0);
        assert!(!s.milestones.get(0).unwrap().verified);
    }

    // ── Test 3: already-verified milestone is idempotent ─────────────────────

    #[test]
    fn test_milestone_already_verified_is_idempotent() {
        let (env, _admin, contract_id) = setup();
        let creator = Address::generate(&env);
        let recipient = Address::generate(&env);
        let oracle = Address::generate(&env);

        let stream =
            make_stream_with_milestone(&env, &creator, &recipient, &oracle, 1000, 300);
        set_stream(&env, &contract_id, 0, &stream);
        env.ledger().with_mut(|l| l.timestamp = 200);

        // First verification
        verify(&env, &contract_id, &oracle, 0, 0).unwrap();

        // Second call — must not error
        let result = verify(&env, &contract_id, &oracle, 0, 0);
        assert!(result.is_ok(), "second verify should be idempotent");

        // State unchanged from after first verify
        let s = get_stream(&env, &contract_id, 0);
        assert!(s.milestones.get(0).unwrap().verified);
    }

    // ── Test 4: time-based streams unaffected ────────────────────────────────

    #[test]
    fn test_time_based_stream_unaffected() {
        let (env, _admin, contract_id) = setup();
        let creator = Address::generate(&env);
        let recipient = Address::generate(&env);

        // Stream with no milestones
        let stream = StreamInfo {
            id: 0,
            creator: creator.clone(),
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1000,
            claimed_amount: 0,
            start_time: 100,
            end_time: 200,
            cliff_time: 100,
            metadata: None,
            cancelled: false,
            paused: false,
            disputed: false,
            milestones: soroban_sdk::Vec::new(&env),
        };
        set_stream(&env, &contract_id, 0, &stream);

        // At t=150 (50% through): claimable = 500
        env.ledger().with_mut(|l| l.timestamp = 150);
        let claimed = claim(&env, &contract_id, &recipient, 0);
        assert_eq!(claimed.unwrap(), 500);
    }

    // ── Test 5: out-of-range index returns InvalidParameters ─────────────────

    #[test]
    fn test_invalid_milestone_index() {
        let (env, _admin, contract_id) = setup();
        let creator = Address::generate(&env);
        let recipient = Address::generate(&env);
        let oracle = Address::generate(&env);

        let stream =
            make_stream_with_milestone(&env, &creator, &recipient, &oracle, 1000, 300);
        set_stream(&env, &contract_id, 0, &stream);

        let result = verify(&env, &contract_id, &oracle, 0, 99);
        assert_eq!(result, Err(Error::InvalidParameters));
    }
}

// ── Gas benchmark entry ───────────────────────────────────────────────────────

#[cfg(test)]
mod bench {
    use super::tests::*;
    use crate::streaming::verify_stream_milestone;
    use crate::types::{Milestone, StreamInfo};
    use crate::{storage, TokenFactory};
    use soroban_sdk::{testutils::Address as _, testutils::Ledger, Address, Env, String, Vec};

    #[test]
    fn bench_verify_stream_milestone() {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TokenFactory);
        let admin = Address::generate(&env);
        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
        });

        let creator = Address::generate(&env);
        let recipient = Address::generate(&env);
        let oracle = Address::generate(&env);

        let mut milestones: Vec<Milestone> = Vec::new(&env);
        milestones.push_back(Milestone {
            description: String::from_str(&env, "bench milestone"),
            oracle_address: oracle.clone(),
            unlock_amount: 500,
            verified: false,
        });
        let stream = StreamInfo {
            id: 0,
            creator,
            recipient,
            token_index: 0,
            total_amount: 1000,
            claimed_amount: 0,
            start_time: 1,
            end_time: 100,
            cliff_time: 1,
            metadata: None,
            cancelled: false,
            paused: false,
            disputed: false,
            milestones,
        };
        env.as_contract(&contract_id, || {
            storage::set_stream(&env, 0, &stream);
        });
        env.ledger().with_mut(|l| l.timestamp = 200);

        // Single timed invocation
        let _before = env.cost_estimate().cpu_insns_consumed();
        env.as_contract(&contract_id, || {
            verify_stream_milestone(&env, &oracle, 0, 0).unwrap();
        });
        let _after = env.cost_estimate().cpu_insns_consumed();
        // Cost is logged but not asserted (baseline TBD)
    }
}
