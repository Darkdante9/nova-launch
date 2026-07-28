#![no_std]

mod delegation;
mod events;
mod settlement;
mod storage;
mod types;

use soroban_sdk::{contract, contractimpl, Address, Env, String};
use types::{
    DelegationRecord, Disbursement, Error,
    GovernanceProposal, ProposalStatus, ProposalVote,
    VoteError, FinalizationError,
};

#[contract]
pub struct GovernanceContract;

#[contractimpl]
impl GovernanceContract {
    pub fn initialize(env: Env, admin: Address, total_supply: i128) -> Result<(), Error> {
        if storage::has_admin(&env) {
            return Err(Error::AlreadyInitialized);
        }
        if total_supply <= 0 {
            return Err(Error::InvalidParameters);
        }
        storage::set_admin(&env, &admin);
        storage::set_total_supply(&env, total_supply);
        storage::set_proposal_count(&env, 0);
        Ok(())
    }

    pub fn delegate(env: Env, delegator: Address, delegatee: Address) -> Result<(), Error> {
        delegation::delegate(&env, delegator, delegatee)
    }

    pub fn undelegate(env: Env, delegator: Address) -> Result<(), Error> {
        delegation::undelegate(&env, delegator)
    }

    pub fn get_vote_power(env: Env, address: Address) -> i128 {
        delegation::get_vote_power(&env, &address)
    }

    pub fn get_delegation(env: Env, delegator: Address) -> Option<DelegationRecord> {
        delegation::get_delegation(&env, &delegator)
    }

    pub fn get_balance(env: Env, holder: Address) -> i128 {
        storage::get_balance(&env, &holder)
    }

    pub fn take_snapshot(env: Env, address: Address) -> Result<(), Error> {
        delegation::take_snapshot(&env, &address)
    }

    pub fn get_snapshot_power(env: Env, address: Address, ledger: u32) -> Result<i128, Error> {
        delegation::get_snapshot_power(&env, &address, ledger)
    }

    pub fn set_balance(
        env: Env,
        admin: Address,
        holder: Address,
        new_balance: i128,
    ) -> Result<(), Error> {
        if storage::is_paused(&env) {
            return Err(Error::ContractPaused);
        }
        admin.require_auth();
        let stored_admin = storage::get_admin(&env);
        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }
        if new_balance < 0 {
            return Err(Error::InvalidParameters);
        }
        let old_balance = storage::get_balance(&env, &holder);
        let delta = new_balance
            .checked_sub(old_balance)
            .ok_or(Error::ArithmeticError)?;
        storage::set_balance(&env, &holder, new_balance);
        if let Some(ref record) = storage::get_delegation(&env, &holder) {
            let delegatee = record.delegatee.clone();
            let current_power = storage::get_vote_power(&env, &delegatee);
            let new_power = current_power
                .checked_add(delta)
                .ok_or(Error::ArithmeticError)?;
            storage::set_vote_power(&env, &delegatee, new_power.max(0));
        } else {
            let current_power = storage::get_vote_power(&env, &holder);
            let new_power = current_power
                .checked_add(delta)
                .ok_or(Error::ArithmeticError)?;
            storage::set_vote_power(&env, &holder, new_power.max(0));
        }
        Ok(())
    }

    pub fn transfer_admin(
        env: Env,
        current_admin: Address,
        new_admin: Address,
    ) -> Result<(), Error> {
        current_admin.require_auth();
        let stored_admin = storage::get_admin(&env);
        if current_admin != stored_admin {
            return Err(Error::Unauthorized);
        }
        if new_admin == current_admin {
            return Err(Error::InvalidParameters);
        }
        storage::set_admin(&env, &new_admin);
        events::emit_admin_transfer(&env, &current_admin, &new_admin);
        Ok(())
    }

    pub fn pause(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        let stored_admin = storage::get_admin(&env);
        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }
        storage::set_paused(&env, true);
        events::emit_pause_changed(&env, &admin, true);
        Ok(())
    }

    pub fn unpause(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        let stored_admin = storage::get_admin(&env);
        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }
        storage::set_paused(&env, false);
        events::emit_pause_changed(&env, &admin, false);
        Ok(())
    }

    pub fn is_paused(env: Env) -> bool {
        storage::is_paused(&env)
    }

    // Proposals

    pub fn create_proposal(
        env: Env,
        creator: Address,
        description: String,
        payload: soroban_sdk::Bytes,
        voting_period: u64,
        quorum: i128,
        threshold_percent: u32,
    ) -> Result<u32, Error> {
        creator.require_auth();

        // Bounds validation — reject malformed proposals before any storage write
        if threshold_percent > 100 {
            return Err(Error::InvalidParameters);
        }
        if quorum <= 0 {
            return Err(Error::InvalidParameters);
        }
        if voting_period == 0 {
            return Err(Error::InvalidParameters);
        }

        let proposal_id = storage::get_proposal_count(&env);
        let voting_end = env.ledger().timestamp() + voting_period;
        let proposal = GovernanceProposal {
            id: proposal_id,
            creator: creator.clone(),
            description,
            voting_end,
            quorum,
            threshold_percent,
            votes_for: 0,
            votes_against: 0,
            payload,
            status: ProposalStatus::Active,
            disbursement: None,
        };
        storage::set_proposal(&env, proposal_id, &proposal);
        storage::set_proposal_count(&env, proposal_id + 1);
        Ok(proposal_id)
    }

    /// Admin-only: configure the deployed token-factory contract this
    /// governance instance is authorized to disburse treasury payouts
    /// through via the two-phase settlement protocol (#1624).
    pub fn set_token_factory(env: Env, admin: Address, token_factory: Address) -> Result<(), Error> {
        admin.require_auth();
        let stored_admin = storage::get_admin(&env);
        if admin != stored_admin {
            return Err(Error::Unauthorized);
        }
        storage::set_token_factory(&env, &token_factory);
        Ok(())
    }

    /// Attach a treasury payout to an active proposal, to be disbursed
    /// through token-factory's prepare/commit settlement protocol when the
    /// proposal executes. Only the proposal's creator may attach a
    /// disbursement, only while the proposal is still `Active`, and only
    /// once per proposal.
    pub fn attach_disbursement(
        env: Env,
        creator: Address,
        proposal_id: u32,
        recipient: Address,
        token_index: u32,
        amount: i128,
    ) -> Result<(), FinalizationError> {
        creator.require_auth();
        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(FinalizationError::ProposalNotFound)?;
        if proposal.creator != creator {
            return Err(FinalizationError::ProposalNotFound);
        }
        if proposal.status != ProposalStatus::Active {
            return Err(FinalizationError::AlreadyFinalized);
        }
        if proposal.disbursement.is_some() {
            return Err(FinalizationError::DisbursementAlreadyAttached);
        }
        proposal.disbursement = Some(Disbursement {
            recipient,
            token_index,
            amount,
        });
        storage::set_proposal(&env, proposal_id, &proposal);
        Ok(())
    }

    /// Execute a passed proposal (atomically with state change).
    ///
    /// If the proposal carries a `disbursement`, it is settled through
    /// token-factory's two-phase prepare/commit protocol *before* the
    /// proposal is marked `Executed` (#1624) — a failed commit auto-aborts
    /// the reservation and leaves the proposal `Passed` (retryable) rather
    /// than silently losing the payout.
    pub fn execute_proposal(env: Env, proposal_id: u32) -> Result<(), FinalizationError> {
        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(FinalizationError::ProposalNotFound)?;

        if proposal.status == ProposalStatus::Executed {
            return Err(FinalizationError::AlreadyExecuted);
        }

        if proposal.status != ProposalStatus::Passed {
            return Err(FinalizationError::ProposalNotPassed);
        }

        if let Some(disbursement) = proposal.disbursement.clone() {
            let token_factory = storage::get_token_factory(&env)
                .ok_or(FinalizationError::TokenFactoryNotConfigured)?;
            settlement::execute_disbursement(&env, &token_factory, proposal_id, &disbursement)?;
        }

        // Only set once settlement (if any) is confirmed committed.
        proposal.status = ProposalStatus::Executed;
        storage::set_proposal(&env, proposal_id, &proposal);

        // Emit execution event (actual side effects would be triggered here or by caller)
        env.events().publish(
            (soroban_sdk::symbol_short!("exec_prop"), proposal_id),
            proposal.description,
        );

        Ok(())
    }

    pub fn cast_vote(
        env: Env,
        voter: Address,
        proposal_id: u32,
        in_favor: bool,
    ) -> Result<(), VoteError> {
        voter.require_auth();
        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(VoteError::ProposalNotFound)?;
        if proposal.status != ProposalStatus::Active {
            return Err(VoteError::ProposalNotActive);
        }
        if env.ledger().timestamp() > proposal.voting_end {
            return Err(VoteError::VotingPeriodEnded);
        }
        if storage::has_voted(&env, proposal_id, &voter) {
            return Err(VoteError::AlreadyVoted);
        }
        let weight = {
            let vp = storage::get_vote_power(&env, &voter);
            if vp > 0 {
                vp
            } else {
                let bal = storage::get_balance(&env, &voter);
                if bal <= 0 {
                    return Err(VoteError::InsufficientBalance);
                }
                bal
            }
        };
        let vote = ProposalVote {
            voter: voter.clone(),
            proposal_id,
            weight,
            in_favor,
        };
        storage::set_vote(&env, proposal_id, &voter, &vote);
        if in_favor {
            proposal.votes_for = proposal.votes_for
                .checked_add(weight)
                .ok_or(VoteError::Overflow)?;
        } else {
            proposal.votes_against = proposal.votes_against
                .checked_add(weight)
                .ok_or(VoteError::Overflow)?;
        }
        storage::set_proposal(&env, proposal_id, &proposal);
        Ok(())
    }

    pub fn has_voted(env: Env, proposal_id: u32, voter: Address) -> bool {
        storage::has_voted(&env, proposal_id, &voter)
    }

    pub fn finalize_proposal(
        env: Env,
        proposal_id: u32,
    ) -> Result<ProposalStatus, FinalizationError> {
        let mut proposal = storage::get_proposal(&env, proposal_id)
            .ok_or(FinalizationError::ProposalNotFound)?;
        if proposal.status != ProposalStatus::Active {
            return Err(FinalizationError::AlreadyFinalized);
        }
        if env.ledger().timestamp() <= proposal.voting_end {
            return Err(FinalizationError::VotingPeriodNotEnded);
        }
        let total_votes = proposal
            .votes_for
            .checked_add(proposal.votes_against)
            .ok_or(FinalizationError::ArithmeticOverflow)?;
        let final_status = if total_votes < proposal.quorum {
            ProposalStatus::Failed
        } else {
            let threshold_votes = total_votes
                .checked_mul(proposal.threshold_percent as i128)
                .ok_or(FinalizationError::ArithmeticOverflow)?
                / 100;
            if proposal.votes_for > threshold_votes {
                ProposalStatus::Passed
            } else {
                ProposalStatus::Rejected
            }
        };
        proposal.status = final_status.clone();
        storage::set_proposal(&env, proposal_id, &proposal);
        Ok(final_status)
    }

    pub fn get_proposal(env: Env, proposal_id: u32) -> Option<GovernanceProposal> {
        storage::get_proposal(&env, proposal_id)
    }

    pub fn get_proposal_vote(env: Env, proposal_id: u32, voter: Address) -> Option<ProposalVote> {
        storage::get_vote(&env, proposal_id, &voter)
    }
}

#[cfg(test)]
mod governance_test;

#[cfg(test)]
mod governance_property_test;

#[cfg(test)]
mod governance_bounds_test;
