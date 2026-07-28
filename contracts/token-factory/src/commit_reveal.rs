//! Commit-Reveal Randomness Scheme for Front-Running-Resistant Auction Tie-Breaking
//!
//! Bidders submit a hashed commitment during the bidding window, then reveal the
//! pre-image during a separate reveal window. The final tie-break seed is derived
//! from the hash-chain of all valid reveals, so no single participant can
//! unilaterally determine the outcome.
//!
//! ## Windows
//! ```text
//! 0 ──── commit_start ──── commit_end / reveal_start ──── reveal_end
//!          [commit window]                [reveal window]
//! ```
//!
//! ## Forfeiture Rule
//! A bidder who commits but never reveals forfeits their slot; they are excluded
//! from tie-break resolution. No refund advantage is granted to non-revealers.
//!
//! ## Tie-Break Randomness Derivation
//! ```text
//! seed = H(reveal_1 || reveal_2 || ... || reveal_n)
//! ```
//! The hash-chain is applied in deterministic submission order (commitment index).

use soroban_sdk::{contracttype, Address, BytesN, Env, Vec};
use crate::types::{DataKey, Error};

// ─── Constants ────────────────────────────────────────────────────────────────

/// Minimum commit window duration (seconds)
pub const MIN_COMMIT_WINDOW: u64 = 60;
/// Maximum commit window duration (seconds)
pub const MAX_COMMIT_WINDOW: u64 = 7 * 24 * 3_600; // 7 days
/// Minimum reveal window duration (seconds)
pub const MIN_REVEAL_WINDOW: u64 = 60;
/// Maximum reveal window duration (seconds)
pub const MAX_REVEAL_WINDOW: u64 = 7 * 24 * 3_600; // 7 days
/// Maximum number of bidders in a single commit-reveal session
pub const MAX_BIDDERS: u32 = 200;

// ─── Types ────────────────────────────────────────────────────────────────────

/// Status of a commit-reveal session
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitRevealStatus {
    /// Commit window is open
    Committing = 0,
    /// Reveal window is open
    Revealing = 1,
    /// Randomness has been finalised; session is terminal
    Finalised = 2,
    /// Session was cancelled (e.g., no valid reveals)
    Cancelled = 3,
}

/// A single bidder's commitment record
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitRecord {
    /// Bidder address
    pub bidder: Address,
    /// SHA-256 commitment: H(pre_image)
    pub commitment: BytesN<32>,
    /// Ledger timestamp of commit
    pub committed_at: u64,
    /// Whether the pre-image was successfully revealed
    pub revealed: bool,
    /// The revealed pre-image (only valid when `revealed == true`)
    pub pre_image: Option<BytesN<32>>,
    /// Ledger timestamp of reveal (0 if not yet revealed)
    pub revealed_at: u64,
    /// Sequential index within this session (0-based)
    pub index: u32,
}

/// A commit-reveal session
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitRevealSession {
    /// Unique session ID
    pub id: u64,
    /// Auction ID this session is associated with
    pub auction_id: u64,
    /// When bidders may start committing
    pub commit_start: u64,
    /// When the commit window closes
    pub commit_end: u64,
    /// When the reveal window opens (== commit_end)
    pub reveal_start: u64,
    /// When the reveal window closes
    pub reveal_end: u64,
    /// Current session status
    pub status: CommitRevealStatus,
    /// Number of commitments submitted
    pub commit_count: u32,
    /// Number of valid reveals
    pub reveal_count: u32,
    /// Final tie-break seed (only set after finalisation)
    pub final_seed: Option<BytesN<32>>,
    /// Session creator (admin)
    pub creator: Address,
    /// Ledger timestamp the session was created
    pub created_at: u64,
}

// ─── Storage keys (extend DataKey via module-level fns) ──────────────────────

fn session_key(session_id: u64) -> DataKey {
    DataKey::CommitRevealSession(session_id)
}

fn commit_key(session_id: u64, index: u32) -> DataKey {
    DataKey::CommitRecord(session_id, index)
}

fn session_count_key() -> DataKey {
    DataKey::CommitRevealSessionCount
}

fn bidder_index_key(session_id: u64, bidder: &Address) -> DataKey {
    DataKey::CommitRevealBidderIndex(session_id, bidder.clone())
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// Create a new commit-reveal session (admin only).
///
/// # Arguments
/// * `env`          – Contract environment
/// * `admin`        – Must match stored admin
/// * `auction_id`   – Auction this session is tied to
/// * `commit_start` – Timestamp when commits open
/// * `commit_end`   – Timestamp when commits close
/// * `reveal_end`   – Timestamp when reveals close (reveal opens at commit_end)
///
/// # Returns
/// New session ID
///
/// # Errors
/// * `Error::Unauthorized`        – Caller is not admin
/// * `Error::InvalidTimeWindow`   – Window parameters are invalid
/// * `Error::ContractPaused`      – Contract is paused
pub fn create_commit_reveal_session(
    env: Env,
    admin: Address,
    auction_id: u64,
    commit_start: u64,
    commit_end: u64,
    reveal_end: u64,
) -> Result<u64, Error> {
    admin.require_auth();

    if crate::storage::is_paused(&env) {
        return Err(Error::ContractPaused);
    }

    let stored_admin = crate::storage::get_admin(&env);
    if admin != stored_admin {
        return Err(Error::Unauthorized);
    }

    // Validate window timing
    validate_windows(commit_start, commit_end, reveal_end)?;

    let count: u64 = env
        .storage()
        .persistent()
        .get(&session_count_key())
        .unwrap_or(0u64);
    let session_id = count + 1;

    let now = env.ledger().timestamp();

    let session = CommitRevealSession {
        id: session_id,
        auction_id,
        commit_start,
        commit_end,
        reveal_start: commit_end,
        reveal_end,
        status: CommitRevealStatus::Committing,
        commit_count: 0,
        reveal_count: 0,
        final_seed: None,
        creator: admin.clone(),
        created_at: now,
    };

    env.storage()
        .persistent()
        .set(&session_key(session_id), &session);
    env.storage()
        .persistent()
        .set(&session_count_key(), &session_id);

    env.events().publish(
        (soroban_sdk::symbol_short!("cr_create"), session_id),
        (admin, auction_id, commit_start, commit_end, reveal_end),
    );

    Ok(session_id)
}

/// Submit a commitment during the commit window.
///
/// `commitment` must equal `H(pre_image)` where H is SHA-256. The contract
/// stores the commitment only and does not know the pre-image until reveal.
///
/// # Errors
/// * `Error::CommitWindowClosed`   – Outside the commit window
/// * `Error::AlreadyCommitted`     – Bidder already committed in this session
/// * `Error::TooManyBidders`       – Session is at capacity
/// * `Error::InvalidParameters`    – Session not in Committing state
pub fn submit_commitment(
    env: Env,
    session_id: u64,
    bidder: Address,
    commitment: BytesN<32>,
) -> Result<u32, Error> {
    bidder.require_auth();

    let mut session = load_session(&env, session_id)?;

    let now = env.ledger().timestamp();

    // Enforce commit window
    if now < session.commit_start || now >= session.commit_end {
        return Err(Error::CommitWindowClosed);
    }

    if session.status != CommitRevealStatus::Committing {
        return Err(Error::InvalidParameters);
    }

    // Check duplicate
    if env
        .storage()
        .persistent()
        .has(&bidder_index_key(session_id, &bidder))
    {
        return Err(Error::AlreadyCommitted);
    }

    // Capacity guard
    if session.commit_count >= MAX_BIDDERS {
        return Err(Error::TooManyBidders);
    }

    let index = session.commit_count;
    let record = CommitRecord {
        bidder: bidder.clone(),
        commitment,
        committed_at: now,
        revealed: false,
        pre_image: None,
        revealed_at: 0,
        index,
    };

    env.storage()
        .persistent()
        .set(&commit_key(session_id, index), &record);
    env.storage()
        .persistent()
        .set(&bidder_index_key(session_id, &bidder), &index);

    session.commit_count += 1;
    env.storage()
        .persistent()
        .set(&session_key(session_id), &session);

    env.events().publish(
        (soroban_sdk::symbol_short!("cr_commit"), session_id),
        (bidder, index),
    );

    Ok(index)
}

/// Reveal the pre-image during the reveal window.
///
/// The contract verifies `H(pre_image) == commitment`. On success the record
/// is marked as revealed and contributes to the final seed.
///
/// # Errors
/// * `Error::RevealWindowClosed`   – Outside the reveal window
/// * `Error::AlreadyRevealed`      – Pre-image was already submitted
/// * `Error::CommitmentMismatch`   – H(pre_image) != stored commitment
/// * `Error::NoBidderCommitment`   – Bidder never committed
pub fn reveal_pre_image(
    env: Env,
    session_id: u64,
    bidder: Address,
    pre_image: BytesN<32>,
) -> Result<(), Error> {
    bidder.require_auth();

    let mut session = load_session(&env, session_id)?;

    let now = env.ledger().timestamp();

    // Enforce reveal window: must be after commit_end and before reveal_end
    if now < session.reveal_start || now >= session.reveal_end {
        return Err(Error::RevealWindowClosed);
    }

    // Transition status lazily from Committing → Revealing if needed
    if session.status == CommitRevealStatus::Committing {
        session.status = CommitRevealStatus::Revealing;
        env.storage()
            .persistent()
            .set(&session_key(session_id), &session);
    }

    if session.status != CommitRevealStatus::Revealing {
        return Err(Error::InvalidParameters);
    }

    // Lookup bidder index
    let index: u32 = env
        .storage()
        .persistent()
        .get(&bidder_index_key(session_id, &bidder))
        .ok_or(Error::NoBidderCommitment)?;

    let mut record: CommitRecord = env
        .storage()
        .persistent()
        .get(&commit_key(session_id, index))
        .ok_or(Error::NoBidderCommitment)?;

    if record.revealed {
        return Err(Error::AlreadyRevealed);
    }

    // Verify commitment: H(pre_image) must equal stored commitment
    let digest = env.crypto().sha256(&pre_image.into());
    let digest_bytes: BytesN<32> = digest.into();
    if digest_bytes != record.commitment {
        return Err(Error::CommitmentMismatch);
    }

    record.revealed = true;
    record.pre_image = Some(pre_image.clone());
    record.revealed_at = now;

    env.storage()
        .persistent()
        .set(&commit_key(session_id, index), &record);

    let mut session2 = load_session(&env, session_id)?;
    session2.reveal_count += 1;
    env.storage()
        .persistent()
        .set(&session_key(session_id), &session2);

    env.events().publish(
        (soroban_sdk::symbol_short!("cr_reveal"), session_id),
        (bidder, index),
    );

    Ok(())
}

/// Finalise the session and derive the combined tie-break seed.
///
/// Can be called by anyone after the reveal window closes. Iterates all
/// commitments in submission order and hash-chains only the revealed
/// pre-images. Bidders who never revealed are silently excluded (forfeited).
///
/// # Returns
/// The final 32-byte seed
///
/// # Errors
/// * `Error::RevealWindowOpen`  – Reveal window has not closed yet
/// * `Error::NoValidReveals`    – All bidders forfeited; cannot derive seed
/// * `Error::AlreadyFinalised`  – Session already finalised
pub fn finalise_session(env: Env, session_id: u64) -> Result<BytesN<32>, Error> {
    let mut session = load_session(&env, session_id)?;

    let now = env.ledger().timestamp();

    if now < session.reveal_end {
        return Err(Error::RevealWindowOpen);
    }

    if session.status == CommitRevealStatus::Finalised {
        return Err(Error::AlreadyFinalised);
    }

    if session.status == CommitRevealStatus::Cancelled {
        return Err(Error::InvalidParameters);
    }

    // Hash-chain over all revealed pre-images in submission order
    let seed = derive_seed(&env, &session)?;

    session.status = CommitRevealStatus::Finalised;
    session.final_seed = Some(seed.clone());
    env.storage()
        .persistent()
        .set(&session_key(session_id), &session);

    env.events().publish(
        (soroban_sdk::symbol_short!("cr_final"), session_id),
        (session.auction_id, seed.clone(), session.reveal_count),
    );

    Ok(seed)
}

/// Get a commit-reveal session by ID.
pub fn get_session(env: Env, session_id: u64) -> Option<CommitRevealSession> {
    env.storage()
        .persistent()
        .get(&session_key(session_id))
}

/// Get a commitment record by bidder address.
pub fn get_commitment(
    env: Env,
    session_id: u64,
    bidder: Address,
) -> Option<CommitRecord> {
    let index: u32 = env
        .storage()
        .persistent()
        .get(&bidder_index_key(session_id, &bidder))?;
    env.storage()
        .persistent()
        .get(&commit_key(session_id, index))
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

fn load_session(env: &Env, session_id: u64) -> Result<CommitRevealSession, Error> {
    env.storage()
        .persistent()
        .get(&session_key(session_id))
        .ok_or(Error::CommitRevealSessionNotFound)
}

fn validate_windows(commit_start: u64, commit_end: u64, reveal_end: u64) -> Result<(), Error> {
    if commit_end <= commit_start {
        return Err(Error::InvalidTimeWindow);
    }
    let commit_dur = commit_end - commit_start;
    if commit_dur < MIN_COMMIT_WINDOW || commit_dur > MAX_COMMIT_WINDOW {
        return Err(Error::InvalidTimeWindow);
    }
    if reveal_end <= commit_end {
        return Err(Error::InvalidTimeWindow);
    }
    let reveal_dur = reveal_end - commit_end;
    if reveal_dur < MIN_REVEAL_WINDOW || reveal_dur > MAX_REVEAL_WINDOW {
        return Err(Error::InvalidTimeWindow);
    }
    Ok(())
}

/// Derive the final seed by hash-chaining all valid (revealed) pre-images
/// in ascending commitment-index order.
///
/// ```text
/// state_0 = [0u8; 32]
/// state_i = H(state_{i-1} || pre_image_i)   for each revealed pre_image_i
/// seed    = state_n
/// ```
fn derive_seed(env: &Env, session: &CommitRevealSession) -> Result<BytesN<32>, Error> {
    let mut has_reveal = false;
    // 32-byte running state, initialised to zero
    let mut state: soroban_sdk::Bytes = soroban_sdk::Bytes::new(env);
    for _ in 0..32u32 {
        state.push_back(0u8);
    }

    for i in 0..session.commit_count {
        let record: CommitRecord = env
            .storage()
            .persistent()
            .get(&commit_key(session.id, i))
            .ok_or(Error::CommitRevealSessionNotFound)?;

        if !record.revealed {
            // Non-revealer is silently skipped (forfeited)
            continue;
        }

        let pre_image: BytesN<32> = record.pre_image.ok_or(Error::CommitRevealSessionNotFound)?;

        // Build state || pre_image
        let mut input: soroban_sdk::Bytes = state.clone();
        let pre_bytes: soroban_sdk::Bytes = pre_image.into();
        input.append(&pre_bytes);

        // state = H(input)
        let digest = env.crypto().sha256(&input);
        state = digest.into();
        has_reveal = true;
    }

    if !has_reveal {
        return Err(Error::NoValidReveals);
    }

    let seed: BytesN<32> = state
        .try_into()
        .map_err(|_| Error::CommitRevealSessionNotFound)?;
    Ok(seed)
}
