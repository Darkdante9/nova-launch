#[cfg(test)]
mod burn_auction_tests {
    use crate::burn_auction;
    use crate::storage;
    use crate::types::{Error, TokenInfo};
    use crate::TokenFactory;
    use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env, String};

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TokenFactory);
        let admin = Address::generate(&env);
        let token_addr = Address::generate(&env);

        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
            storage::set_token_info(&env, 0, &TokenInfo {
                address: token_addr.clone(),
                creator: admin.clone(),
                name: String::from_str(&env, "T"),
                symbol: String::from_str(&env, "T"),
                decimals: 7,
                total_supply: 1_000_000_000,
                initial_supply: 1_000_000_000,
                max_supply: None,
                total_burned: 0,
                burn_count: 0,
                metadata_uri: None,
                metadata_version: 0,
                created_at: env.ledger().timestamp(),
                is_paused: false,
                clawback_enabled: false,
                freeze_enabled: false,
            });
        });

        (env, contract_id, admin)
    }

    fn make_auction(env: &Env, cid: &Address, admin: &Address) -> (u64, u64, u64) {
        let now = env.ledger().timestamp();
        let start = now + 10;
        let end   = now + 3_600;
        let id = env.as_contract(cid, || {
            burn_auction::create_auction(env, admin, 0, 1_000, 1_000_000, 100_000, start, end).unwrap()
        });
        (id, start, end)
    }

    // ── create_auction ───────────────────────────────────────────────────────

    #[test]
    fn create_auction_success() {
        let (env, cid, admin) = setup();
        let (id, _, _) = make_auction(&env, &cid, &admin);
        assert_eq!(id, 1);
    }

    #[test]
    fn create_auction_start_price_eq_reserve_rejected() {
        let (env, cid, admin) = setup();
        let now = env.ledger().timestamp();
        let res = env.as_contract(&cid, || {
            burn_auction::create_auction(&env, &admin, 0, 1_000, 500_000, 500_000, now + 10, now + 3_600)
        });
        assert_eq!(res, Err(Error::InvalidParameters));
    }

    #[test]
    fn create_auction_zero_burn_amount_rejected() {
        let (env, cid, admin) = setup();
        let now = env.ledger().timestamp();
        let res = env.as_contract(&cid, || {
            burn_auction::create_auction(&env, &admin, 0, 0, 1_000_000, 100_000, now + 10, now + 3_600)
        });
        assert_eq!(res, Err(Error::InvalidAmount));
    }

    // ── price at start / end ──────────────────────────────────────────────────

    #[test]
    fn price_at_start_equals_start_price() {
        let (env, cid, admin) = setup();
        let (id, start, _) = make_auction(&env, &cid, &admin);
        env.ledger().with_mut(|l| l.timestamp = start);
        let price = env.as_contract(&cid, || burn_auction::get_current_price(&env, id).unwrap());
        assert_eq!(price, 1_000_000);
    }

    #[test]
    fn price_at_end_equals_reserve_price() {
        let (env, cid, admin) = setup();
        let (id, _, end) = make_auction(&env, &cid, &admin);
        env.ledger().with_mut(|l| l.timestamp = end);
        let price = env.as_contract(&cid, || burn_auction::get_current_price(&env, id).unwrap());
        assert_eq!(price, 100_000);
    }

    // ── place_bid ─────────────────────────────────────────────────────────────

    #[test]
    fn bid_at_reserve_price_accepted() {
        let (env, cid, admin) = setup();
        let (id, _, end) = make_auction(&env, &cid, &admin);
        // At end - 1 the price is >= reserve; use reserve directly
        env.ledger().with_mut(|l| l.timestamp = end - 1);
        let bidder = Address::generate(&env);
        let res = env.as_contract(&cid, || {
            let current = burn_auction::get_current_price(&env, id).unwrap();
            burn_auction::place_bid(&env, &bidder, id, current)
        });
        assert!(res.is_ok());
    }

    #[test]
    fn bid_above_current_price_accepted() {
        let (env, cid, admin) = setup();
        let (id, start, _) = make_auction(&env, &cid, &admin);
        env.ledger().with_mut(|l| l.timestamp = start);
        let bidder = Address::generate(&env);
        // Overpay — settlement is the current price, not bid amount
        let settlement = env.as_contract(&cid, || {
            burn_auction::place_bid(&env, &bidder, id, 2_000_000).unwrap()
        });
        assert_eq!(settlement, 1_000_000);
    }

    #[test]
    fn bid_below_reserve_rejected() {
        let (env, cid, admin) = setup();
        let (id, start, _) = make_auction(&env, &cid, &admin);
        env.ledger().with_mut(|l| l.timestamp = start);
        let bidder = Address::generate(&env);
        let res = env.as_contract(&cid, || burn_auction::place_bid(&env, &bidder, id, 1));
        assert_eq!(res, Err(Error::InsufficientFee));
    }

    #[test]
    fn bid_on_expired_auction_rejected() {
        let (env, cid, admin) = setup();
        let (id, _, end) = make_auction(&env, &cid, &admin);
        env.ledger().with_mut(|l| l.timestamp = end + 1);
        let bidder = Address::generate(&env);
        let res = env.as_contract(&cid, || burn_auction::place_bid(&env, &bidder, id, 1_000_000));
        assert_eq!(res, Err(Error::InvalidTimeWindow));
    }

    // ── cancel_auction ────────────────────────────────────────────────────────

    #[test]
    fn admin_can_cancel_open_auction() {
        let (env, cid, admin) = setup();
        let (id, _, _) = make_auction(&env, &cid, &admin);
        let res = env.as_contract(&cid, || burn_auction::cancel_auction(&env, &admin, id));
        assert!(res.is_ok());
    }

    #[test]
    fn non_admin_cannot_cancel_before_expiry() {
        let (env, cid, admin) = setup();
        let (id, _, _) = make_auction(&env, &cid, &admin);
        let other = Address::generate(&env);
        let res = env.as_contract(&cid, || burn_auction::cancel_auction(&env, &other, id));
        assert_eq!(res, Err(Error::Unauthorized));
    }

    #[test]
    fn anyone_can_cancel_expired_auction() {
        let (env, cid, admin) = setup();
        let (id, _, end) = make_auction(&env, &cid, &admin);
        env.ledger().with_mut(|l| l.timestamp = end + 1);
        let anyone = Address::generate(&env);
        let res = env.as_contract(&cid, || burn_auction::cancel_auction(&env, &anyone, id));
        assert!(res.is_ok());
    }

    // ── update_reserve_price ─────────────────────────────────────────────────

    #[test]
    fn lower_reserve_price_accepted() {
        let (env, cid, admin) = setup();
        let (id, _, _) = make_auction(&env, &cid, &admin);
        let res = env.as_contract(&cid, || {
            burn_auction::update_reserve_price(&env, &admin, id, 50_000)
        });
        assert!(res.is_ok());
    }

    #[test]
    fn higher_reserve_price_rejected() {
        let (env, cid, admin) = setup();
        let (id, _, _) = make_auction(&env, &cid, &admin);
        let res = env.as_contract(&cid, || {
            burn_auction::update_reserve_price(&env, &admin, id, 200_000)
        });
        assert_eq!(res, Err(Error::InvalidParameters));
    }
}
