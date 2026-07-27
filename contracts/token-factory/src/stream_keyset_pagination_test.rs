//! Tests for keyset (cursor-based) stream pagination.
//!
//! `stream_pagination_test.rs` covers the legacy offset-based
//! `get_streams_page`-style semantics, which drift when streams are created
//! concurrently with paging (see issue #1386). This module exercises the
//! new `(created_ledger, stream_id)` keyset cursor, exposed publicly via
//! `TokenFactory::list_streams_paginated` and internally via
//! `pagination::list_streams_paginated`.

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod stream_keyset_pagination_tests {
    use crate::pagination;
    use crate::streaming;
    use crate::storage;
    use crate::types::{StreamParams, TokenInfo};
    use soroban_sdk::{testutils::{Address as _, Ledger}, Address, Env, String};

    /// Sets up a bare environment (no deployed contract needed: `streaming`
    /// and `pagination` are plain module functions operating on `env`
    /// storage directly, mirroring the pattern used by
    /// `stream_lifecycle_integration_test.rs`).
    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let creator = Address::generate(&env);

        storage::set_admin(&env, &admin);
        storage::set_paused(&env, false);

        let token_info = TokenInfo {
            address: Address::generate(&env),
            creator: creator.clone(),
            name: String::from_str(&env, "Test Token"),
            symbol: String::from_str(&env, "TST"),
            decimals: 7,
            total_supply: 1_000_000_0000000,
            initial_supply: 1_000_000_0000000,
            max_supply: None,
            total_burned: 0,
            burn_count: 0,
            metadata_uri: None,
            metadata_version: 0,
            created_at: env.ledger().timestamp(),
            is_paused: false,
            clawback_enabled: false,
            freeze_enabled: false,
        };
        storage::set_token_info(&env, 0, &token_info);

        (env, admin, creator)
    }

    /// Creates a stream at the given ledger sequence number, returning its id.
    fn create_stream_at_ledger(env: &Env, creator: &Address, recipient: &Address, ledger_seq: u32) -> u64 {
        env.ledger().set_sequence_number(ledger_seq);
        let params = StreamParams {
            recipient: recipient.clone(),
            token_index: 0,
            total_amount: 1_000_0000000,
            start_time: 100,
            end_time: 200,
            cliff_time: 100,
        };
        streaming::create_stream(env, creator, &params).unwrap()
    }

    #[test]
    fn test_first_page_no_cursor() {
        let (env, _admin, creator) = setup();
        let recipient = Address::generate(&env);

        for i in 0..5u32 {
            create_stream_at_ledger(&env, &creator, &recipient, 100 + i);
        }

        let page = pagination::list_streams_paginated(&env, &creator, None, 3);
        assert_eq!(page.streams.len(), 3);
        assert!(page.has_more);
        assert!(page.next_cursor.is_some());

        // Ascending order by (created_ledger, stream_id): ids 0,1,2
        assert_eq!(page.streams.get(0).unwrap().id, 0);
        assert_eq!(page.streams.get(1).unwrap().id, 1);
        assert_eq!(page.streams.get(2).unwrap().id, 2);

        let cursor = page.next_cursor.unwrap();
        assert_eq!(cursor.stream_id, 2);
        assert_eq!(cursor.created_ledger, 102);
    }

    #[test]
    fn test_second_page_continues_without_overlap_or_gap() {
        let (env, _admin, creator) = setup();
        let recipient = Address::generate(&env);

        for i in 0..5u32 {
            create_stream_at_ledger(&env, &creator, &recipient, 100 + i);
        }

        let page1 = pagination::list_streams_paginated(&env, &creator, None, 3);
        assert_eq!(page1.streams.len(), 3);
        assert!(page1.has_more);

        let page2 = pagination::list_streams_paginated(&env, &creator, page1.next_cursor, 3);
        assert_eq!(page2.streams.len(), 2);
        assert!(!page2.has_more);
        assert!(page2.next_cursor.is_none());

        // No overlap, no gap: page2 picks up exactly where page1 left off.
        assert_eq!(page2.streams.get(0).unwrap().id, 3);
        assert_eq!(page2.streams.get(1).unwrap().id, 4);

        // Combined pages cover all 5 streams exactly once.
        let mut all_ids = soroban_sdk::Vec::new(&env);
        for s in page1.streams.iter() {
            all_ids.push_back(s.id);
        }
        for s in page2.streams.iter() {
            all_ids.push_back(s.id);
        }
        assert_eq!(all_ids.len(), 5);
        for i in 0..5u64 {
            assert_eq!(all_ids.get(i as u32).unwrap(), i);
        }
    }

    #[test]
    fn test_new_stream_inserted_between_pages_is_not_skipped_or_duplicated() {
        // This is the exact scenario offset pagination gets wrong: a new
        // stream is created *after* page 1 is fetched but *before* page 2
        // is fetched. Keyset pagination must still resume cleanly.
        let (env, _admin, creator) = setup();
        let recipient = Address::generate(&env);

        for i in 0..3u32 {
            create_stream_at_ledger(&env, &creator, &recipient, 100 + i);
        }

        let page1 = pagination::list_streams_paginated(&env, &creator, None, 2);
        assert_eq!(page1.streams.len(), 2);
        assert!(page1.has_more);

        // Simulate a concurrent insert between page fetches.
        create_stream_at_ledger(&env, &creator, &recipient, 103);

        let page2 = pagination::list_streams_paginated(&env, &creator, page1.next_cursor, 10);
        // Stream 2 (already existed) plus the newly inserted stream 3.
        assert_eq!(page2.streams.len(), 2);
        assert!(!page2.has_more);
        assert_eq!(page2.streams.get(0).unwrap().id, 2);
        assert_eq!(page2.streams.get(1).unwrap().id, 3);
    }

    #[test]
    fn test_last_page_has_more_false_and_next_cursor_none() {
        let (env, _admin, creator) = setup();
        let recipient = Address::generate(&env);

        for i in 0..4u32 {
            create_stream_at_ledger(&env, &creator, &recipient, 100 + i);
        }

        // Exactly enough room for the remaining streams.
        let page = pagination::list_streams_paginated(&env, &creator, None, 10);
        assert_eq!(page.streams.len(), 4);
        assert!(!page.has_more);
        assert!(page.next_cursor.is_none());
    }

    #[test]
    fn test_empty_result_for_owner_with_no_streams() {
        let (env, _admin, _creator) = setup();
        let owner_without_streams = Address::generate(&env);

        let page = pagination::list_streams_paginated(&env, &owner_without_streams, None, 10);
        assert_eq!(page.streams.len(), 0);
        assert!(!page.has_more);
        assert!(page.next_cursor.is_none());
    }

    #[test]
    fn test_limit_is_clamped_to_max_50() {
        let (env, _admin, creator) = setup();
        let recipient = Address::generate(&env);

        for i in 0..60u32 {
            create_stream_at_ledger(&env, &creator, &recipient, 100 + i);
        }

        let page = pagination::list_streams_paginated(&env, &creator, None, 1000);
        assert_eq!(page.streams.len(), 50);
        assert!(page.has_more);
    }

    #[test]
    fn test_limit_zero_clamped_to_minimum_one() {
        let (env, _admin, creator) = setup();
        let recipient = Address::generate(&env);
        create_stream_at_ledger(&env, &creator, &recipient, 100);

        let page = pagination::list_streams_paginated(&env, &creator, None, 0);
        assert_eq!(page.streams.len(), 1);
    }

    #[test]
    fn test_streams_from_other_owners_are_excluded() {
        let (env, _admin, creator) = setup();
        let other_creator = Address::generate(&env);
        let recipient = Address::generate(&env);

        create_stream_at_ledger(&env, &creator, &recipient, 100);
        create_stream_at_ledger(&env, &other_creator, &recipient, 101);
        create_stream_at_ledger(&env, &creator, &recipient, 102);

        let page = pagination::list_streams_paginated(&env, &creator, None, 10);
        assert_eq!(page.streams.len(), 2);
        for s in page.streams.iter() {
            assert_eq!(s.creator, creator);
        }
    }

    #[test]
    fn test_contract_entry_point_matches_module_function() {
        // Smoke test the public TokenFactory::list_streams_paginated entry
        // point end-to-end through a deployed contract instance.
        let env = Env::default();
        env.mock_all_auths();

        let contract_id = env.register_contract(None, crate::TokenFactory);
        let client = crate::TokenFactoryClient::new(&env, &contract_id);

        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        client.initialize(&admin, &treasury, &1_000_000, &500_000);

        let creator = Address::generate(&env);
        let recipient = Address::generate(&env);

        env.as_contract(&contract_id, || {
            let token_info = TokenInfo {
                address: Address::generate(&env),
                creator: creator.clone(),
                name: String::from_str(&env, "Test Token"),
                symbol: String::from_str(&env, "TST"),
                decimals: 7,
                total_supply: 1_000_000_0000000,
                initial_supply: 1_000_000_0000000,
                max_supply: None,
                total_burned: 0,
                burn_count: 0,
                metadata_uri: None,
                metadata_version: 0,
                created_at: env.ledger().timestamp(),
                is_paused: false,
                clawback_enabled: false,
                freeze_enabled: false,
            };
            storage::set_token_info(&env, 0, &token_info);

            for i in 0..3u32 {
                create_stream_at_ledger(&env, &creator, &recipient, 100 + i);
            }
        });

        let page = client.list_streams_paginated(&creator, &None, &2);
        assert_eq!(page.streams.len(), 2);
        assert!(page.has_more);
        assert_eq!(page.streams.get(0).unwrap().id, 0);
        assert_eq!(page.streams.get(1).unwrap().id, 1);

        let page2 = client.list_streams_paginated(&creator, &page.next_cursor, &2);
        assert_eq!(page2.streams.len(), 1);
        assert!(!page2.has_more);
        assert_eq!(page2.streams.get(0).unwrap().id, 2);
    }
}
