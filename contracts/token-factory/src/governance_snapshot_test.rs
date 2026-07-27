//! Governance Proposal State Snapshot Tests (#1383)
//!
//! Verifies the `snapshot_proposals(env, admin)` entry point, the automatic
//! ledger-based trigger (every `SNAPSHOT_INTERVAL_LEDGERS` ledgers), and the
//! `ProposalStateSnapshot` (`prop_snap`) event schema emitted by both paths.
//!
//! Run with: `cargo test -p token-factory governance_snapshot`

#[cfg(test)]
mod governance_snapshot_tests {
    use soroban_sdk::{
        symbol_short,
        testutils::{Address as _, Events, Ledger},
        xdr::{ContractEventBody, ScVal},
        Address, Bytes, Env, FromVal, Symbol, TryFromVal, TryIntoVal, Val,
    };
    use crate::{
        governance,
        storage,
        timelock::{create_proposal, finalize_proposal, vote_proposal},
        types::{ActionType, Error, ProposalState, VoteChoice},
        TokenFactory,
    };

    /// Decode the (topics, data) of every event into SDK `Val`s, regardless
    /// of the soroban-sdk version's raw-events representation.
    fn decode_events(env: &Env) -> std::vec::Vec<(std::vec::Vec<Val>, Val)> {
        env.events()
            .all()
            .events()
            .iter()
            .filter_map(|raw| match &raw.body {
                ContractEventBody::V0(body) => {
                    let topics: std::vec::Vec<Val> = body
                        .topics
                        .iter()
                        .map(|t: &ScVal| Val::try_from_val(env, t).unwrap())
                        .collect();
                    let data: Val = Val::try_from_val(env, &body.data).unwrap();
                    Some((topics, data))
                }
            })
            .collect()
    }

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let contract_id = env.register_contract(None, TokenFactory);
        let admin = Address::generate(&env);
        let treasury = Address::generate(&env);
        env.as_contract(&contract_id, || {
            storage::set_admin(&env, &admin);
            storage::set_treasury(&env, &treasury);
            storage::set_base_fee(&env, 1_000_000);
            storage::set_metadata_fee(&env, 500_000);
            crate::timelock::initialize_timelock(&env, Some(3_600)).unwrap();
            governance::initialize_governance(&env, Some(30), Some(51)).unwrap();
        });
        (env, contract_id, admin)
    }

    /// Create a proposal whose voting window is already open at the current
    /// ledger timestamp, so `vote_proposal` calls in tests don't need to
    /// fast-forward time separately from the ledger sequence.
    fn create_open_proposal(env: &Env, admin: &Address) -> u64 {
        let now = env.ledger().timestamp();
        create_proposal(
            env,
            admin,
            ActionType::FeeChange,
            Bytes::new(env),
            now,
            now + 86_500,
            now + 90_100,
        )
        .unwrap()
    }

    /// Returns true if the decoded event's first topic is the `prop_snap`
    /// symbol and its second topic matches `proposal_id`.
    fn is_snapshot_event_for(env: &Env, topics: &[Val], proposal_id: u64) -> bool {
        if topics.len() != 2 {
            return false;
        }
        let name_matches = Symbol::try_from_val(env, &topics[0])
            .map(|s| s == symbol_short!("prop_snap"))
            .unwrap_or(false);
        if !name_matches {
            return false;
        }
        u64::try_from_val(env, &topics[1])
            .map(|id| id == proposal_id)
            .unwrap_or(false)
    }

    /// Find the most recent `prop_snap` event for `proposal_id` and return
    /// its decoded payload: (status, yes_votes, no_votes, quorum_required, ledger).
    fn last_snapshot_event(
        env: &Env,
        proposal_id: u64,
    ) -> Option<(ProposalState, i128, i128, i128, u32)> {
        let mut found = None;
        for (topics, data) in decode_events(env) {
            if is_snapshot_event_for(env, &topics, proposal_id) {
                found = Some(FromVal::from_val(env, &data));
            }
        }
        found
    }

    fn count_snapshot_events(env: &Env, proposal_id: u64) -> usize {
        decode_events(env)
            .iter()
            .filter(|(topics, _)| is_snapshot_event_for(env, topics, proposal_id))
            .count()
    }

    // ── snapshot_proposals: manual entry point ─────────────────────────────

    #[test]
    fn test_snapshot_proposals_emits_event_for_active_proposal() {
        let (env, cid, admin) = setup();
        let pid = env.as_contract(&cid, || create_open_proposal(&env, &admin));

        let snapshotted = env
            .as_contract(&cid, || governance::snapshot_proposals(&env, &admin))
            .unwrap();

        assert_eq!(snapshotted, 1, "exactly one active proposal should be snapshotted");
        assert_eq!(count_snapshot_events(&env, pid), 1);
    }

    #[test]
    fn test_snapshot_contains_correct_accumulated_vote_counts() {
        let (env, cid, admin) = setup();
        let pid = env.as_contract(&cid, || create_open_proposal(&env, &admin));

        env.as_contract(&cid, || {
            for _ in 0..5 {
                vote_proposal(&env, &Address::generate(&env), pid, VoteChoice::For).unwrap();
            }
            for _ in 0..2 {
                vote_proposal(&env, &Address::generate(&env), pid, VoteChoice::Against).unwrap();
            }
        });

        env.as_contract(&cid, || governance::snapshot_proposals(&env, &admin)).unwrap();

        let (status, yes_votes, no_votes, _quorum_required, ledger) =
            last_snapshot_event(&env, pid).expect("snapshot event must be emitted");

        assert_eq!(status, ProposalState::Active);
        assert_eq!(yes_votes, 5, "yes_votes must equal accumulated For votes");
        assert_eq!(no_votes, 2, "no_votes must equal accumulated Against votes");
        assert_eq!(ledger, env.ledger().sequence());
    }

    #[test]
    fn test_snapshot_quorum_required_matches_governance_formula() {
        let (env, cid, admin) = setup();
        let pid = env.as_contract(&cid, || create_open_proposal(&env, &admin));

        env.as_contract(&cid, || {
            for _ in 0..3 {
                vote_proposal(&env, &Address::generate(&env), pid, VoteChoice::For).unwrap();
            }
        });

        let expected_quorum_required = env.as_contract(&cid, || {
            let proposal = storage::get_proposal(&env, pid).unwrap();
            governance::compute_quorum_required(&env, &proposal)
        });

        env.as_contract(&cid, || governance::snapshot_proposals(&env, &admin)).unwrap();

        let (_, _, _, quorum_required, _) =
            last_snapshot_event(&env, pid).expect("snapshot event must be emitted");

        assert_eq!(
            quorum_required, expected_quorum_required,
            "snapshot quorum_required must never diverge from the governance module's own computation"
        );
    }

    #[test]
    fn test_snapshot_proposals_skips_terminal_state_proposals() {
        let (env, cid, admin) = setup();
        let pid = env.as_contract(&cid, || create_open_proposal(&env, &admin));

        // Move past the voting window and finalize — with no votes, quorum is
        // not met, so the proposal transitions to a terminal Failed state.
        env.ledger().with_mut(|li| li.timestamp += 90_000);
        env.as_contract(&cid, || {
            finalize_proposal(&env, pid).unwrap();
            let p = storage::get_proposal(&env, pid).unwrap();
            assert_eq!(p.state, ProposalState::Failed);
        });

        let snapshotted = env
            .as_contract(&cid, || governance::snapshot_proposals(&env, &admin))
            .unwrap();

        assert_eq!(
            snapshotted, 0,
            "terminal-state proposals must not receive snapshots"
        );
        assert_eq!(count_snapshot_events(&env, pid), 0);
    }

    #[test]
    fn test_snapshot_proposals_covers_multiple_active_proposals() {
        let (env, cid, admin) = setup();
        let pid1 = env.as_contract(&cid, || create_open_proposal(&env, &admin));
        let pid2 = env.as_contract(&cid, || create_open_proposal(&env, &admin));

        let snapshotted = env
            .as_contract(&cid, || governance::snapshot_proposals(&env, &admin))
            .unwrap();

        assert_eq!(snapshotted, 2);
        assert_eq!(count_snapshot_events(&env, pid1), 1);
        assert_eq!(count_snapshot_events(&env, pid2), 1);
    }

    #[test]
    fn test_snapshot_proposals_unauthorized_caller_rejected() {
        let (env, cid, admin) = setup();
        env.as_contract(&cid, || create_open_proposal(&env, &admin));

        let attacker = Address::generate(&env);
        let result = env.as_contract(&cid, || governance::snapshot_proposals(&env, &attacker));

        assert_eq!(result, Err(Error::Unauthorized));
    }

    #[test]
    fn test_snapshot_proposals_idempotent_can_be_called_repeatedly() {
        let (env, cid, admin) = setup();
        let pid = env.as_contract(&cid, || create_open_proposal(&env, &admin));

        env.as_contract(&cid, || {
            governance::snapshot_proposals(&env, &admin).unwrap();
            governance::snapshot_proposals(&env, &admin).unwrap();
            governance::snapshot_proposals(&env, &admin).unwrap();
        });

        // Each call should emit exactly one more snapshot event; no event is
        // lost or duplicated beyond the number of calls made.
        assert_eq!(count_snapshot_events(&env, pid), 3);
    }

    // ── Automatic ledger-based trigger ──────────────────────────────────────

    #[test]
    fn test_auto_snapshot_does_not_fire_before_interval_elapses() {
        let (env, cid, admin) = setup();
        let pid = env.as_contract(&cid, || create_open_proposal(&env, &admin));

        // create_proposal's own auto-snapshot check fires at ledger 0 with no
        // prior snapshot (0 - 0 >= 1000 is false unless current ledger is
        // already >= 1000), so a fresh env at the default sequence should not
        // have triggered one yet via creation. Advance by less than the
        // 1000-ledger interval and vote — still should not trigger.
        env.ledger().with_mut(|li| li.sequence_number += 500);
        env.as_contract(&cid, || {
            vote_proposal(&env, &Address::generate(&env), pid, VoteChoice::For).unwrap();
        });

        assert_eq!(
            count_snapshot_events(&env, pid),
            0,
            "auto-snapshot must not fire before SNAPSHOT_INTERVAL_LEDGERS have elapsed"
        );
    }

    #[test]
    fn test_auto_snapshot_fires_after_interval_elapses_on_vote() {
        let (env, cid, admin) = setup();
        let pid = env.as_contract(&cid, || create_open_proposal(&env, &admin));

        env.ledger()
            .with_mut(|li| li.sequence_number += governance::SNAPSHOT_INTERVAL_LEDGERS);
        env.as_contract(&cid, || {
            vote_proposal(&env, &Address::generate(&env), pid, VoteChoice::For).unwrap();
        });

        assert_eq!(
            count_snapshot_events(&env, pid),
            1,
            "voting after the interval elapses must trigger exactly one auto-snapshot"
        );

        let (_, yes_votes, _, _, ledger) =
            last_snapshot_event(&env, pid).expect("auto-snapshot event must be emitted");
        assert_eq!(yes_votes, 1);
        assert_eq!(ledger, env.ledger().sequence());
    }

    #[test]
    fn test_auto_snapshot_fires_on_proposal_creation_when_due() {
        let (env, cid, admin) = setup();

        // Advance the ledger far enough that a brand new proposal (whose
        // last-snapshot-ledger defaults to 0) is immediately due.
        env.ledger()
            .with_mut(|li| li.sequence_number += governance::SNAPSHOT_INTERVAL_LEDGERS);

        let pid = env.as_contract(&cid, || create_open_proposal(&env, &admin));

        assert_eq!(
            count_snapshot_events(&env, pid),
            1,
            "create_proposal must trigger an auto-snapshot when the interval has already elapsed"
        );
    }

    #[test]
    fn test_auto_snapshot_does_not_double_fire_within_same_interval() {
        let (env, cid, admin) = setup();
        let pid = env.as_contract(&cid, || create_open_proposal(&env, &admin));

        env.ledger()
            .with_mut(|li| li.sequence_number += governance::SNAPSHOT_INTERVAL_LEDGERS);
        env.as_contract(&cid, || {
            vote_proposal(&env, &Address::generate(&env), pid, VoteChoice::For).unwrap();
        });
        assert_eq!(count_snapshot_events(&env, pid), 1);

        // A second vote shortly after (well within the next interval) must
        // not trigger a second auto-snapshot.
        env.ledger().with_mut(|li| li.sequence_number += 10);
        env.as_contract(&cid, || {
            vote_proposal(&env, &Address::generate(&env), pid, VoteChoice::Against).unwrap();
        });
        assert_eq!(
            count_snapshot_events(&env, pid),
            1,
            "auto-snapshot must not fire again until another full interval elapses"
        );
    }

    #[test]
    fn test_auto_snapshot_fires_again_after_second_interval() {
        let (env, cid, admin) = setup();
        let pid = env.as_contract(&cid, || create_open_proposal(&env, &admin));

        env.ledger()
            .with_mut(|li| li.sequence_number += governance::SNAPSHOT_INTERVAL_LEDGERS);
        env.as_contract(&cid, || {
            vote_proposal(&env, &Address::generate(&env), pid, VoteChoice::For).unwrap();
        });
        assert_eq!(count_snapshot_events(&env, pid), 1);

        env.ledger()
            .with_mut(|li| li.sequence_number += governance::SNAPSHOT_INTERVAL_LEDGERS);
        env.as_contract(&cid, || {
            vote_proposal(&env, &Address::generate(&env), pid, VoteChoice::For).unwrap();
        });
        assert_eq!(
            count_snapshot_events(&env, pid),
            2,
            "a second full interval must trigger another auto-snapshot"
        );
    }

    // ── Snapshot/event-stream consistency ───────────────────────────────────

    #[test]
    fn test_snapshot_matches_get_vote_counts() {
        let (env, cid, admin) = setup();
        let pid = env.as_contract(&cid, || create_open_proposal(&env, &admin));

        env.as_contract(&cid, || {
            for _ in 0..4 {
                vote_proposal(&env, &Address::generate(&env), pid, VoteChoice::For).unwrap();
            }
            for _ in 0..1 {
                vote_proposal(&env, &Address::generate(&env), pid, VoteChoice::Against).unwrap();
            }
        });

        let (votes_for, votes_against, _) = env
            .as_contract(&cid, || crate::timelock::get_vote_counts(&env, pid))
            .unwrap();

        env.as_contract(&cid, || governance::snapshot_proposals(&env, &admin)).unwrap();
        let (_, yes_votes, no_votes, _, _) =
            last_snapshot_event(&env, pid).expect("snapshot event must be emitted");

        assert_eq!(
            yes_votes, votes_for,
            "snapshot yes_votes must never diverge from the proposal's persisted vote tally"
        );
        assert_eq!(
            no_votes, votes_against,
            "snapshot no_votes must never diverge from the proposal's persisted vote tally"
        );
    }

    // ── Event schema: parseable by the backend governanceEventParser ───────

    #[test]
    fn test_snapshot_event_topic_schema() {
        let (env, cid, admin) = setup();
        let pid = env.as_contract(&cid, || create_open_proposal(&env, &admin));
        env.as_contract(&cid, || governance::snapshot_proposals(&env, &admin)).unwrap();

        let (topics, data) = decode_events(&env)
            .into_iter()
            .find(|(topics, _)| is_snapshot_event_for(&env, topics, pid))
            .expect("prop_snap event must be present");

        // Topics: (event_name, proposal_id) — exactly 2, matching the
        // documented schema in events.rs::emit_proposal_state_snapshot.
        assert_eq!(topics.len(), 2, "prop_snap must have exactly 2 topics");
        let topic_proposal_id: u64 = u64::try_from_val(&env, &topics[1]).unwrap();
        assert_eq!(topic_proposal_id, pid);

        // Payload must decode as (status, yes_votes, no_votes, quorum_required, ledger)
        // — the exact shape the backend governanceEventParser/mapper expects.
        let (_status, yes_votes, no_votes, quorum_required, ledger): (
            ProposalState,
            i128,
            i128,
            i128,
            u32,
        ) = FromVal::from_val(&env, &data);
        assert_eq!(yes_votes, 0);
        assert_eq!(no_votes, 0);
        assert!(quorum_required >= 0);
        assert_eq!(ledger, env.ledger().sequence());
    }

    #[test]
    fn test_snapshot_event_name_within_symbol_short_limit() {
        // symbol_short! requires <= 9 ASCII chars; guard against regression.
        let name = "prop_snap";
        assert!(name.len() <= 9, "prop_snap must fit within symbol_short! limits");
        let _ = symbol_short!("prop_snap");
    }
}
