//! Multi-epoch dividend distribution integration tests (Issue #1316)
//!
//! Verifies that the dividend distribution engine behaves correctly across
//! multiple sequential distribution rounds ("epochs"), including:
//!
//! - Epoch independence: claims/reclaims in one epoch don't affect another
//! - Proportional correctness per epoch with changing balances between epochs
//! - Sum-of-claims never exceeds total_amount for any epoch
//! - Holders who miss an epoch window cannot retroactively claim
//! - Admin can reclaim unclaimed remainder independently per epoch
//! - Zero-supply epoch is rejected
//! - Non-admin cannot initiate any epoch

#[cfg(test)]
mod dividend_multi_epoch_integration {
    use soroban_sdk::{
        testutils::{Address as _, Ledger},
        Address, Env, String,
    };

    use crate::{TokenFactory, TokenFactoryClient};

    // ─────────────────────────────────────────────────────────────────────────
    // Constants & helpers
    // ─────────────────────────────────────────────────────────────────────────

    const CLAIM_WINDOW: u32 = 500;

    /// Register factory contract, initialise it, deploy one token.
    /// Returns (client, admin, token_index).
    fn setup(env: &Env) -> (TokenFactoryClient, Address, u32) {
        env.mock_all_auths();
        let cid = env.register_contract(None, TokenFactory);
        let client = TokenFactoryClient::new(env, &cid);

        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        client.initialize(&admin, &treasury, &0i128, &0i128);

        client.create_token(
            &admin,
            &String::from_str(env, "EpochToken"),
            &String::from_str(env, "EPT"),
            &7u32,
            &0i128,
            &None,
            &0i128,
        );

        (client, admin, 0u32)
    }

    fn mint(
        client: &TokenFactoryClient,
        admin: &Address,
        token_index: u32,
        to: &Address,
        amount: i128,
    ) {
        client.mint(admin, &token_index, to, &amount);
    }

    fn advance(env: &Env, ledgers: u32) {
        env.ledger().with_mut(|l| l.sequence_number += ledgers);
    }

    fn new_asset(env: &Env) -> Address {
        Address::generate(env)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Two sequential epochs — each epoch is independent
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn two_epochs_are_independent() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);

        let h1 = Address::generate(&env);
        let h2 = Address::generate(&env);
        mint(&client, &admin, token_index, &h1, 600_0000000);
        mint(&client, &admin, token_index, &h2, 400_0000000);

        let pool1: i128 = 1_000_000;
        let pool2: i128 = 2_000_000;

        // Epoch 0
        let dist0 = client.initiate_distribution(
            &admin, &token_index, &new_asset(&env), &pool1, &CLAIM_WINDOW,
        );
        assert_eq!(dist0, 0);

        let a1_e0 = client.claim_dividend(&h1, &dist0);
        let a2_e0 = client.claim_dividend(&h2, &dist0);
        assert_eq!(a1_e0, pool1 * 600 / 1000);
        assert_eq!(a2_e0, pool1 * 400 / 1000);
        assert!(a1_e0 + a2_e0 <= pool1);

        // Advance past epoch 0 window
        advance(&env, CLAIM_WINDOW + 1);

        // Epoch 1 — same holders, different pool
        let dist1 = client.initiate_distribution(
            &admin, &token_index, &new_asset(&env), &pool2, &CLAIM_WINDOW,
        );
        assert_eq!(dist1, 1);

        let a1_e1 = client.claim_dividend(&h1, &dist1);
        let a2_e1 = client.claim_dividend(&h2, &dist1);
        assert_eq!(a1_e1, pool2 * 600 / 1000);
        assert_eq!(a2_e1, pool2 * 400 / 1000);
        assert!(a1_e1 + a2_e1 <= pool2);

        // Claims from epoch 0 must not be re-claimable in epoch 1's IDs
        let res = client.try_claim_dividend(&h1, &dist0);
        assert!(res.is_err());
        assert_eq!(
            res.unwrap_err().unwrap(),
            crate::types::Error::DistributionAlreadyClaimed.into()
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Balances change between epochs — each epoch uses its own snapshot
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn changing_balances_between_epochs_use_correct_snapshot() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);

        let h1 = Address::generate(&env);
        let h2 = Address::generate(&env);
        let h3 = Address::generate(&env);

        // Epoch 0: h1=500, h2=500, h3=0
        mint(&client, &admin, token_index, &h1, 500_0000000);
        mint(&client, &admin, token_index, &h2, 500_0000000);

        let pool: i128 = 1_000_000_000;
        let dist0 = client.initiate_distribution(
            &admin, &token_index, &new_asset(&env), &pool, &CLAIM_WINDOW,
        );

        let a1_e0 = client.claim_dividend(&h1, &dist0);
        let a2_e0 = client.claim_dividend(&h2, &dist0);
        assert_eq!(a1_e0, pool / 2);
        assert_eq!(a2_e0, pool / 2);

        // h3 had zero balance — nothing to claim
        let res = client.try_claim_dividend(&h3, &dist0);
        assert_eq!(
            res.unwrap_err().unwrap(),
            crate::types::Error::NothingToClaim.into()
        );

        advance(&env, CLAIM_WINDOW + 1);

        // Epoch 1: mint to h3 (h1 & h2 balances unchanged)
        mint(&client, &admin, token_index, &h3, 1000_0000000);
        // Total supply now: h1=500, h2=500, h3=1000 → total=2000 units
        let dist1 = client.initiate_distribution(
            &admin, &token_index, &new_asset(&env), &pool, &CLAIM_WINDOW,
        );

        let a1_e1 = client.claim_dividend(&h1, &dist1);
        let a2_e1 = client.claim_dividend(&h2, &dist1);
        let a3_e1 = client.claim_dividend(&h3, &dist1);

        // Shares: h1=500/2000=25%, h2=500/2000=25%, h3=1000/2000=50%
        assert_eq!(a1_e1, pool * 500 / 2000);
        assert_eq!(a2_e1, pool * 500 / 2000);
        assert_eq!(a3_e1, pool * 1000 / 2000);
        assert!(a1_e1 + a2_e1 + a3_e1 <= pool);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Property: sum of all claims ≤ total_amount for every epoch
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn sum_of_claims_never_exceeds_pool_across_epochs() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);

        // Deliberately non-round balances to stress integer division
        let balances: [i128; 4] = [97, 251, 503, 149];
        let mut holders: Vec<Address> = Vec::new();
        for &b in &balances {
            let h = Address::generate(&env);
            mint(&client, &admin, token_index, &h, b * 10_000_000);
            holders.push(h);
        }

        let pools: [i128; 3] = [999_999_997, 1_000_000_001, 500_000_003];

        for (epoch, &pool) in pools.iter().enumerate() {
            if epoch > 0 {
                advance(&env, CLAIM_WINDOW + 1);
            }
            let dist_id = client.initiate_distribution(
                &admin, &token_index, &new_asset(&env), &pool, &CLAIM_WINDOW,
            );
            assert_eq!(dist_id, epoch as u32);

            let mut sum: i128 = 0;
            for h in &holders {
                sum += client.claim_dividend(h, &dist_id);
            }
            assert!(
                sum <= pool,
                "epoch {}: sum {} exceeded pool {}",
                epoch, sum, pool
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Missed window in epoch N — holder cannot claim retroactively
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn missed_epoch_window_cannot_be_claimed_retroactively() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);

        let holder = Address::generate(&env);
        mint(&client, &admin, token_index, &holder, 1000_0000000);

        let pool: i128 = 1_000_000;

        // Epoch 0
        let dist0 = client.initiate_distribution(
            &admin, &token_index, &new_asset(&env), &pool, &CLAIM_WINDOW,
        );
        // Holder misses epoch 0 window
        advance(&env, CLAIM_WINDOW + 1);

        // Epoch 1
        let dist1 = client.initiate_distribution(
            &admin, &token_index, &new_asset(&env), &pool, &CLAIM_WINDOW,
        );

        // Attempting to claim epoch 0 after its window must fail
        let res0 = client.try_claim_dividend(&holder, &dist0);
        assert!(res0.is_err());
        assert_eq!(
            res0.unwrap_err().unwrap(),
            crate::types::Error::DistributionWindowClosed.into()
        );

        // Claiming epoch 1 (still within window) must succeed
        let claimed = client.claim_dividend(&holder, &dist1);
        assert!(claimed > 0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Admin reclaims independently per epoch
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn admin_reclaims_per_epoch_independently() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);

        let h1 = Address::generate(&env);
        let h2 = Address::generate(&env);
        mint(&client, &admin, token_index, &h1, 700_0000000);
        mint(&client, &admin, token_index, &h2, 300_0000000);

        let pool: i128 = 1_000_000;

        // Epoch 0: only h1 claims
        let dist0 = client.initiate_distribution(
            &admin, &token_index, &new_asset(&env), &pool, &CLAIM_WINDOW,
        );
        let claimed0 = client.claim_dividend(&h1, &dist0);

        advance(&env, CLAIM_WINDOW + 1);

        let reclaimed0 = client.reclaim_unclaimed(&admin, &dist0);
        assert_eq!(reclaimed0, pool - claimed0);

        // Epoch 1: nobody claims
        let dist1 = client.initiate_distribution(
            &admin, &token_index, &new_asset(&env), &pool, &CLAIM_WINDOW,
        );
        advance(&env, CLAIM_WINDOW + 1);

        let reclaimed1 = client.reclaim_unclaimed(&admin, &dist1);
        assert_eq!(reclaimed1, pool); // full pool unclaimed

        // Double-reclaim on either epoch must fail
        for dist_id in [dist0, dist1] {
            let res = client.try_reclaim_unclaimed(&admin, &dist_id);
            assert!(res.is_err());
            assert_eq!(
                res.unwrap_err().unwrap(),
                crate::types::Error::DistributionAlreadyReclaimed.into()
            );
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Three sequential epochs — IDs increment monotonically
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn distribution_ids_increment_monotonically_across_epochs() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);

        let holder = Address::generate(&env);
        mint(&client, &admin, token_index, &holder, 1000_0000000);

        for epoch in 0u32..3 {
            if epoch > 0 {
                advance(&env, CLAIM_WINDOW + 1);
            }
            let dist_id = client.initiate_distribution(
                &admin, &token_index, &new_asset(&env), &1_000_000i128, &CLAIM_WINDOW,
            );
            assert_eq!(dist_id, epoch, "expected dist_id={} got {}", epoch, dist_id);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Partial claims across epochs — leftover reclaimed correctly
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn partial_claims_reclaimed_correctly_across_epochs() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);

        // 5 holders
        let n: usize = 5;
        let mut holders: Vec<Address> = Vec::new();
        for _ in 0..n {
            let h = Address::generate(&env);
            mint(&client, &admin, token_index, &h, 200_0000000); // equal shares
            holders.push(h);
        }

        let pool: i128 = 1_000_000;
        let per_holder = pool / n as i128; // 200_000 each

        // Epoch 0: only first 3 holders claim
        let dist0 = client.initiate_distribution(
            &admin, &token_index, &new_asset(&env), &pool, &CLAIM_WINDOW,
        );
        let mut claimed: i128 = 0;
        for h in holders.iter().take(3) {
            claimed += client.claim_dividend(h, &dist0);
        }
        assert_eq!(claimed, per_holder * 3);

        advance(&env, CLAIM_WINDOW + 1);
        let reclaimed = client.reclaim_unclaimed(&admin, &dist0);
        // Remaining 2 holders' share
        assert_eq!(reclaimed, pool - claimed);

        // Epoch 1: all 5 holders claim
        let dist1 = client.initiate_distribution(
            &admin, &token_index, &new_asset(&env), &pool, &CLAIM_WINDOW,
        );
        let mut total_e1: i128 = 0;
        for h in &holders {
            total_e1 += client.claim_dividend(h, &dist1);
        }
        assert!(total_e1 <= pool);
        assert_eq!(total_e1, per_holder * n as i128);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 8. Initiating a distribution with zero supply is rejected
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn epoch_with_zero_supply_is_rejected() {
        let env = Env::default();
        let (client, admin, _) = setup(&env);

        // Register a second token but do NOT mint anything → supply = 0
        client.create_token(
            &admin,
            &String::from_str(&env, "ZeroToken"),
            &String::from_str(&env, "ZRO"),
            &7u32,
            &0i128,
            &None,
            &0i128,
        );
        let zero_token_index: u32 = 1;

        let res = client.try_initiate_distribution(
            &admin, &zero_token_index, &new_asset(&env), &1_000_000i128, &CLAIM_WINDOW,
        );
        assert!(res.is_err());
        assert_eq!(
            res.unwrap_err().unwrap(),
            crate::types::Error::DistributionZeroSupply.into()
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 9. Non-admin cannot initiate any epoch
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn non_admin_cannot_initiate_any_epoch() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);

        let attacker = Address::generate(&env);
        mint(&client, &admin, token_index, &attacker, 1000_0000000);

        for epoch in 0u32..3 {
            if epoch > 0 {
                advance(&env, CLAIM_WINDOW + 1);
            }
            let res = client.try_initiate_distribution(
                &attacker, &token_index, &new_asset(&env), &1_000_000i128, &CLAIM_WINDOW,
            );
            assert!(res.is_err(), "epoch {}: attacker should not be able to initiate", epoch);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 10. get_distribution returns correct record for each epoch
    // ─────────────────────────────────────────────────────────────────────────

    #[test]
    fn get_distribution_record_correct_per_epoch() {
        let env = Env::default();
        let (client, admin, token_index) = setup(&env);

        let holder = Address::generate(&env);
        mint(&client, &admin, token_index, &holder, 1000_0000000);

        let pools: [i128; 2] = [500_000, 750_000];
        let mut dist_ids = Vec::new();

        for (i, &pool) in pools.iter().enumerate() {
            if i > 0 {
                advance(&env, CLAIM_WINDOW + 1);
            }
            let id = client.initiate_distribution(
                &admin, &token_index, &new_asset(&env), &pool, &CLAIM_WINDOW,
            );
            dist_ids.push(id);
        }

        for (i, &pool) in pools.iter().enumerate() {
            let record = client.get_distribution(&dist_ids[i]).expect("record must exist");
            assert_eq!(record.id, dist_ids[i]);
            assert_eq!(record.total_amount, pool);
            assert_eq!(record.token_index, token_index);
            assert!(!record.reclaimed);
        }
    }
}
