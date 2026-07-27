//! Tests for the commit-reveal randomness scheme (#1626)
//!
//! Covers:
//! 1. Honest multi-bidder tie-break
//! 2. Non-reveal forfeiture
//! 3. Late-reveal rejection
//! 4. Late-commit rejection
//! 5. Commitment mismatch rejection
//! 6. No valid reveals → finalise fails
//! 7. Seed determinism

extern crate std;

use soroban_sdk::{
    testutils::{Address as _, Ledger},
    Address, BytesN, Env,
};

use crate::commit_reveal::CommitRevealStatus;
use crate::types::Error;

// ─── Helpers ─────────────────────────────────────────────────────────────────

fn sha256_commitment(env: &Env, seed: u8) -> (BytesN<32>, BytesN<32>) {
    let mut raw = [0u8; 32];
    raw[0] = seed;
    let pre_image = BytesN::from_array(env, &raw);
    let bytes: soroban_sdk::Bytes = pre_image.clone().into();
    let digest = env.crypto().sha256(&bytes);
    let commitment: BytesN<32> = digest.into();
    (pre_image, commitment)
}

fn setup_factory(env: &Env) -> (Address, Address) {
    let admin = Address::generate(env);
    let treasury = Address::generate(env);
    crate::storage::set_admin(env, &admin);
    crate::storage::set_treasury(env, &treasury);
    crate::storage::set_base_fee(env, 1_000_000i128);
    crate::storage::set_metadata_fee(env, 500_000i128);
    (admin, treasury)
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Honest multi-bidder tie-break
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_commit_reveal_honest_multibidder_tiebreak() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, crate::TokenFactory);

    env.as_contract(&contract_id, || {
        let (admin, _) = setup_factory(&env);

        let commit_start = 100u64;
        let commit_end   = 200u64;
        let reveal_end   = 300u64;

        env.ledger().with_mut(|l| l.timestamp = commit_start);

        let session_id = crate::commit_reveal::create_commit_reveal_session(
            env.clone(), admin.clone(), 1u64, commit_start, commit_end, reveal_end,
        ).expect("create session");

        let bidder_a = Address::generate(&env);
        let bidder_b = Address::generate(&env);
        let bidder_c = Address::generate(&env);

        let (pre_a, comm_a) = sha256_commitment(&env, 0xAA);
        let (pre_b, comm_b) = sha256_commitment(&env, 0xBB);
        let (pre_c, comm_c) = sha256_commitment(&env, 0xCC);

        env.ledger().with_mut(|l| l.timestamp = 150);
        crate::commit_reveal::submit_commitment(env.clone(), session_id, bidder_a.clone(), comm_a).unwrap();
        crate::commit_reveal::submit_commitment(env.clone(), session_id, bidder_b.clone(), comm_b).unwrap();
        crate::commit_reveal::submit_commitment(env.clone(), session_id, bidder_c.clone(), comm_c).unwrap();

        env.ledger().with_mut(|l| l.timestamp = 210);
        crate::commit_reveal::reveal_pre_image(env.clone(), session_id, bidder_a.clone(), pre_a).unwrap();
        crate::commit_reveal::reveal_pre_image(env.clone(), session_id, bidder_b.clone(), pre_b).unwrap();
        crate::commit_reveal::reveal_pre_image(env.clone(), session_id, bidder_c.clone(), pre_c).unwrap();

        env.ledger().with_mut(|l| l.timestamp = 310);
        let seed = crate::commit_reveal::finalise_session(env.clone(), session_id).unwrap();
        assert_eq!(seed.len(), 32);

        let session = crate::commit_reveal::get_session(env.clone(), session_id).unwrap();
        assert_eq!(session.status, CommitRevealStatus::Finalised);
        assert_eq!(session.reveal_count, 3);
        assert_eq!(session.final_seed, Some(seed));

        // Second finalise must fail
        let err = crate::commit_reveal::finalise_session(env.clone(), session_id).unwrap_err();
        assert_eq!(err, Error::AlreadyFinalised);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Non-reveal forfeiture
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_commit_reveal_non_revealer_forfeiture() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, crate::TokenFactory);

    env.as_contract(&contract_id, || {
        let (admin, _) = setup_factory(&env);

        let commit_start = 100u64;
        let commit_end   = 200u64;
        let reveal_end   = 300u64;

        env.ledger().with_mut(|l| l.timestamp = commit_start);
        let session_id = crate::commit_reveal::create_commit_reveal_session(
            env.clone(), admin.clone(), 1u64, commit_start, commit_end, reveal_end,
        ).unwrap();

        let honest   = Address::generate(&env);
        let forfeiter = Address::generate(&env);

        let (pre_honest,  comm_honest)   = sha256_commitment(&env, 0x01);
        let (_pre_forfeiter, comm_forfeiter) = sha256_commitment(&env, 0x02);

        env.ledger().with_mut(|l| l.timestamp = 150);
        crate::commit_reveal::submit_commitment(env.clone(), session_id, honest.clone(), comm_honest).unwrap();
        crate::commit_reveal::submit_commitment(env.clone(), session_id, forfeiter.clone(), comm_forfeiter).unwrap();

        // Only honest bidder reveals
        env.ledger().with_mut(|l| l.timestamp = 210);
        crate::commit_reveal::reveal_pre_image(env.clone(), session_id, honest.clone(), pre_honest).unwrap();
        // forfeiter never reveals

        env.ledger().with_mut(|l| l.timestamp = 310);
        let seed = crate::commit_reveal::finalise_session(env.clone(), session_id).unwrap();
        assert_eq!(seed.len(), 32);

        let session = crate::commit_reveal::get_session(env.clone(), session_id).unwrap();
        assert_eq!(session.status, CommitRevealStatus::Finalised);
        // Only 1 valid reveal despite 2 commits
        assert_eq!(session.reveal_count, 1);

        // Forfeiter's record is still unrevealed
        let rec = crate::commit_reveal::get_commitment(env.clone(), session_id, forfeiter).unwrap();
        assert!(!rec.revealed);
        assert!(rec.pre_image.is_none());
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Late-reveal rejection
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_commit_reveal_late_reveal_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, crate::TokenFactory);

    env.as_contract(&contract_id, || {
        let (admin, _) = setup_factory(&env);

        let commit_start = 100u64;
        let commit_end   = 200u64;
        let reveal_end   = 300u64;

        env.ledger().with_mut(|l| l.timestamp = commit_start);
        let session_id = crate::commit_reveal::create_commit_reveal_session(
            env.clone(), admin.clone(), 1u64, commit_start, commit_end, reveal_end,
        ).unwrap();

        let bidder = Address::generate(&env);
        let (pre_image, commitment) = sha256_commitment(&env, 0x55);

        env.ledger().with_mut(|l| l.timestamp = 150);
        crate::commit_reveal::submit_commitment(env.clone(), session_id, bidder.clone(), commitment).unwrap();

        // Reveal after reveal window closed
        env.ledger().with_mut(|l| l.timestamp = 301);
        let err = crate::commit_reveal::reveal_pre_image(env.clone(), session_id, bidder, pre_image).unwrap_err();
        assert_eq!(err, Error::RevealWindowClosed);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Late-commit rejection
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_commit_reveal_late_commit_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, crate::TokenFactory);

    env.as_contract(&contract_id, || {
        let (admin, _) = setup_factory(&env);

        let commit_start = 100u64;
        let commit_end   = 200u64;
        let reveal_end   = 300u64;

        env.ledger().with_mut(|l| l.timestamp = commit_start);
        let session_id = crate::commit_reveal::create_commit_reveal_session(
            env.clone(), admin.clone(), 1u64, commit_start, commit_end, reveal_end,
        ).unwrap();

        let bidder = Address::generate(&env);
        let (_, commitment) = sha256_commitment(&env, 0x77);

        // Commit after window closed
        env.ledger().with_mut(|l| l.timestamp = 201);
        let err = crate::commit_reveal::submit_commitment(env.clone(), session_id, bidder, commitment).unwrap_err();
        assert_eq!(err, Error::CommitWindowClosed);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Commitment mismatch rejected
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_commit_reveal_commitment_mismatch_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, crate::TokenFactory);

    env.as_contract(&contract_id, || {
        let (admin, _) = setup_factory(&env);

        let commit_start = 100u64;
        let commit_end   = 200u64;
        let reveal_end   = 300u64;

        env.ledger().with_mut(|l| l.timestamp = commit_start);
        let session_id = crate::commit_reveal::create_commit_reveal_session(
            env.clone(), admin.clone(), 1u64, commit_start, commit_end, reveal_end,
        ).unwrap();

        let bidder = Address::generate(&env);
        let (_, commitment)    = sha256_commitment(&env, 0x11);
        let (wrong_pre, _)     = sha256_commitment(&env, 0x22); // different pre-image

        env.ledger().with_mut(|l| l.timestamp = 150);
        crate::commit_reveal::submit_commitment(env.clone(), session_id, bidder.clone(), commitment).unwrap();

        env.ledger().with_mut(|l| l.timestamp = 210);
        let err = crate::commit_reveal::reveal_pre_image(env.clone(), session_id, bidder, wrong_pre).unwrap_err();
        assert_eq!(err, Error::CommitmentMismatch);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: All bidders forfeit → no seed
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_commit_reveal_no_valid_reveals_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, crate::TokenFactory);

    env.as_contract(&contract_id, || {
        let (admin, _) = setup_factory(&env);

        let commit_start = 100u64;
        let commit_end   = 200u64;
        let reveal_end   = 300u64;

        env.ledger().with_mut(|l| l.timestamp = commit_start);
        let session_id = crate::commit_reveal::create_commit_reveal_session(
            env.clone(), admin.clone(), 1u64, commit_start, commit_end, reveal_end,
        ).unwrap();

        let bidder = Address::generate(&env);
        let (_, commitment) = sha256_commitment(&env, 0x33);

        env.ledger().with_mut(|l| l.timestamp = 150);
        crate::commit_reveal::submit_commitment(env.clone(), session_id, bidder, commitment).unwrap();
        // bidder never reveals

        env.ledger().with_mut(|l| l.timestamp = 310);
        let err = crate::commit_reveal::finalise_session(env.clone(), session_id).unwrap_err();
        assert_eq!(err, Error::NoValidReveals);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: Seed is deterministic
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_commit_reveal_seed_is_deterministic() {
    // Run the same two-bidder scenario twice (different session IDs) and
    // assert the resulting seeds are equal.
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, crate::TokenFactory);

    env.as_contract(&contract_id, || {
        let (admin, _) = setup_factory(&env);

        let run = |auction_id: u64| -> BytesN<32> {
            let commit_start = 100u64;
            let commit_end   = 200u64;
            let reveal_end   = 300u64;

            env.ledger().with_mut(|l| l.timestamp = commit_start);
            let session_id = crate::commit_reveal::create_commit_reveal_session(
                env.clone(), admin.clone(), auction_id, commit_start, commit_end, reveal_end,
            ).unwrap();

            let bidder_a = Address::generate(&env);
            let bidder_b = Address::generate(&env);

            // Fixed pre-images so both runs are identical
            let mut raw_a = [0u8; 32]; raw_a[0] = 0xDE;
            let mut raw_b = [0u8; 32]; raw_b[0] = 0xAD;
            let pre_a = BytesN::from_array(&env, &raw_a);
            let pre_b = BytesN::from_array(&env, &raw_b);
            let bytes_a: soroban_sdk::Bytes = pre_a.clone().into();
            let bytes_b: soroban_sdk::Bytes = pre_b.clone().into();
            let comm_a: BytesN<32> = env.crypto().sha256(&bytes_a).into();
            let comm_b: BytesN<32> = env.crypto().sha256(&bytes_b).into();

            env.ledger().with_mut(|l| l.timestamp = 150);
            crate::commit_reveal::submit_commitment(env.clone(), session_id, bidder_a.clone(), comm_a).unwrap();
            crate::commit_reveal::submit_commitment(env.clone(), session_id, bidder_b.clone(), comm_b).unwrap();

            env.ledger().with_mut(|l| l.timestamp = 210);
            crate::commit_reveal::reveal_pre_image(env.clone(), session_id, bidder_a, pre_a).unwrap();
            crate::commit_reveal::reveal_pre_image(env.clone(), session_id, bidder_b, pre_b).unwrap();

            env.ledger().with_mut(|l| l.timestamp = 310);
            crate::commit_reveal::finalise_session(env.clone(), session_id).unwrap()
        };

        let seed1 = run(1);
        let seed2 = run(2);
        assert_eq!(seed1, seed2, "same inputs must produce identical seeds");
    });
}
