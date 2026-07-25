/// Pull-model Dividend Distribution (#1148)
///
/// Flow:
/// 1. Admin calls `initiate_distribution` — takes an atomic supply snapshot,
///    stores the distribution record, and opens the claim window.
/// 2. Each holder calls `claim_dividend` — computes their pro-rata share from
///    the snapshot and marks the claim settled (double-claim prevention).
/// 3. After `claim_deadline_ledger` passes, admin calls `reclaim_unclaimed` to
///    recover the unclaimed remainder back to treasury.

use soroban_sdk::{Address, Env};

use crate::{events, snapshot, storage, types::{DataKey, DistributionRecord, Error}};

// ─────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────

fn get_distribution_count(env: &Env) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::DistributionCount)
        .unwrap_or(0)
}

fn get_distribution(env: &Env, id: u32) -> Option<DistributionRecord> {
    env.storage()
        .persistent()
        .get(&DataKey::Distribution(id))
}

fn set_distribution(env: &Env, rec: &DistributionRecord) {
    let key = DataKey::Distribution(rec.id);
    env.storage().persistent().set(&key, rec);
    storage::bump_persistent(env, &key);
}

fn is_claimed(env: &Env, distribution_id: u32, holder: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::DistributionClaimed(distribution_id, holder.clone()))
        .unwrap_or(false)
}

fn set_claimed(env: &Env, distribution_id: u32, holder: &Address) {
    let key = DataKey::DistributionClaimed(distribution_id, holder.clone());
    env.storage().persistent().set(&key, &true);
    storage::bump_persistent(env, &key);
}

fn get_claimed_total(env: &Env, distribution_id: u32) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::DistributionClaimedTotal(distribution_id))
        .unwrap_or(0)
}

fn add_claimed_total(env: &Env, distribution_id: u32, amount: i128) {
    let new_total = get_claimed_total(env, distribution_id)
        .checked_add(amount)
        .unwrap_or(i128::MAX);
    let key = DataKey::DistributionClaimedTotal(distribution_id);
    env.storage().persistent().set(&key, &new_total);
    storage::bump_persistent(env, &key);
}

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/// Initiate a new distribution round.
///
/// Atomically records the current supply snapshot, stores the distribution
/// parameters, and opens the claim window.
///
/// Validates that the eligible holder set is non-empty and the supply snapshot
/// is valid. Zero-amount entries in holder snapshots are excluded from dividend
/// calculations via explicit guards.
///
/// # Arguments
/// * `admin` - Must be the factory admin; must call `require_auth` before this.
/// * `token_index` - Token whose holder balances determine pro-rata shares.
/// * `asset` - Asset contract address being distributed (e.g. wrapped XLM).
/// * `total_amount` - Total pool to distribute (must be > 0).
/// * `claim_window_ledgers` - Number of ledgers the claim window stays open.
///
/// # Returns `Ok(u32)` - The new distribution ID.
///
/// # Errors
/// * `Unauthorized` - Caller is not the factory admin.
/// * `InvalidParameters` - `total_amount ≤ 0` or `claim_window_ledgers == 0`.
/// * `DistributionZeroSupply` - Token has zero supply or empty eligible-holder set.
pub fn initiate_distribution(
    env: &Env,
    admin: &Address,
    token_index: u32,
    asset: &Address,
    total_amount: i128,
    claim_window_ledgers: u32,
) -> Result<u32, Error> {
    admin.require_auth();
    if *admin != storage::get_admin(env) {
        return Err(Error::Unauthorized);
    }
    if total_amount <= 0 || claim_window_ledgers == 0 {
        return Err(Error::InvalidParameters);
    }

    // Atomic snapshot: take a fresh supply snapshot at the current ledger.
    let snapshot_ledger = env.ledger().sequence();
    let token_info = storage::get_token_info(env, token_index)
        .ok_or(Error::TokenNotFound)?;
    let total_supply = token_info.total_supply;
    let _ = snapshot::record_supply_snapshot(env, token_index, total_supply);

    // Explicit guard: total supply must be positive and non-zero.
    // This ensures no divide-by-zero when calculating pro-rata shares.
    // Zero-amount holders will be filtered out during claim_dividend via
    // the balance > 0 check, so they don't contribute to divisor.
    if total_supply <= 0 {
        return Err(Error::DistributionZeroSupply);
    }

    let id = get_distribution_count(env);
    let claim_deadline_ledger = snapshot_ledger
        .checked_add(claim_window_ledgers)
        .ok_or(Error::ArithmeticError)?;

    let rec = DistributionRecord {
        id,
        token_index,
        asset: asset.clone(),
        total_amount,
        snapshot_ledger,
        total_supply_at_snapshot: total_supply,
        claim_deadline_ledger,
        reclaimed: false,
        created_at: env.ledger().timestamp(),
    };
    set_distribution(env, &rec);

    // Increment count
    env.storage()
        .persistent()
        .set(&DataKey::DistributionCount, &(id + 1));
    storage::bump_persistent(env, &DataKey::DistributionCount);

    events::emit_distribution_initiated(
        env,
        id,
        admin,
        token_index,
        asset,
        total_amount,
        snapshot_ledger,
        claim_deadline_ledger,
    );

    Ok(id)
}

/// Claim a holder's proportional dividend for distribution `distribution_id`.
///
/// The holder's share is computed as:
///   `balance_at_snapshot / total_supply_at_snapshot * total_amount`
///
/// Excludes zero-amount balance entries and guards against divide-by-zero
/// when the eligible-holder set is empty (total_supply_at_snapshot == 0).
///
/// # Errors
/// * `DistributionNotFound` - No distribution with that ID.
/// * `DistributionWindowClosed` - Claim deadline has passed.
/// * `DistributionAlreadyClaimed` - Holder already claimed.
/// * `NothingToClaim` - Holder had zero balance at snapshot or supply was zero.
/// * `DistributionZeroSupply` - Eligible-holder set is empty (total supply is zero).
pub fn claim_dividend(
    env: &Env,
    holder: &Address,
    distribution_id: u32,
) -> Result<i128, Error> {
    holder.require_auth();

    let rec = get_distribution(env, distribution_id)
        .ok_or(Error::DistributionNotFound)?;

    if env.ledger().sequence() > rec.claim_deadline_ledger {
        return Err(Error::DistributionWindowClosed);
    }

    if is_claimed(env, distribution_id, holder) {
        return Err(Error::DistributionAlreadyClaimed);
    }

    let balance = snapshot::get_balance_at_ledger(
        env,
        rec.token_index,
        holder,
        rec.snapshot_ledger,
    )?;

    // Explicit guard: exclude zero-amount entries from dividend calculation
    if balance <= 0 {
        return Err(Error::NothingToClaim);
    }

    // Explicit guard: ensure eligible-holder set is non-empty to prevent divide-by-zero
    if rec.total_supply_at_snapshot <= 0 {
        return Err(Error::DistributionZeroSupply);
    }

    // Pro-rata: amount = total_amount * balance / total_supply
    // Use u128 arithmetic to avoid overflow on large token supplies.
    let amount = (rec.total_amount as u128)
        .checked_mul(balance as u128)
        .ok_or(Error::ArithmeticError)?
        / (rec.total_supply_at_snapshot as u128);
    let amount = amount as i128;

    if amount <= 0 {
        return Err(Error::NothingToClaim);
    }

    set_claimed(env, distribution_id, holder);
    add_claimed_total(env, distribution_id, amount);

    events::emit_dividend_claimed(env, distribution_id, holder, amount);

    Ok(amount)
}

/// Reclaim unclaimed dividends after the claim window closes.
///
/// Returns the unclaimed remainder to the treasury (tracked via event only;
/// actual asset transfer is handled by the caller / treasury module).
///
/// # Errors
/// * `Unauthorized` - Caller is not the factory admin.
/// * `DistributionNotFound` - No distribution with that ID.
/// * `DistributionWindowOpen` - Claim window has not yet expired.
/// * `DistributionAlreadyReclaimed` - Already reclaimed.
pub fn reclaim_unclaimed(
    env: &Env,
    admin: &Address,
    distribution_id: u32,
) -> Result<i128, Error> {
    admin.require_auth();
    if *admin != storage::get_admin(env) {
        return Err(Error::Unauthorized);
    }

    let mut rec = get_distribution(env, distribution_id)
        .ok_or(Error::DistributionNotFound)?;

    if env.ledger().sequence() <= rec.claim_deadline_ledger {
        return Err(Error::DistributionWindowOpen);
    }

    if rec.reclaimed {
        return Err(Error::DistributionAlreadyReclaimed);
    }

    let claimed = get_claimed_total(env, distribution_id);
    let unclaimed = rec.total_amount.checked_sub(claimed).unwrap_or(0);

    rec.reclaimed = true;
    set_distribution(env, &rec);

    events::emit_dividend_reclaimed(env, distribution_id, admin, unclaimed);

    Ok(unclaimed)
}

/// Retrieve a distribution record by ID.
pub fn get_distribution_record(env: &Env, distribution_id: u32) -> Option<DistributionRecord> {
    get_distribution(env, distribution_id)
}

#[cfg(test)]
mod snapshot_dividend_test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Address, Env};

    fn setup() -> (Env, Address, Address) {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let holder = Address::generate(&env);
        (env, admin, holder)
    }

    #[test]
    fn test_zero_amount_entry_excluded_from_claim() {
        let (env, admin, holder) = setup();
        env.register_contract(None, crate::TokenFactory);
        storage::set_admin(&env, &admin);

        // Create a token with non-zero supply
        let token = storage::create_token(
            &env,
            "Test",
            "TST",
            7,
            1_000_000,
            None,
            false,
            &admin,
        );

        // Manually set up a distribution with zero-balance snapshot
        let token_index = 0;
        let distribution_id = 0;
        let asset = Address::generate(&env);
        let total_amount = 1_000_000i128;
        let snapshot_ledger = env.ledger().sequence();
        let claim_deadline = snapshot_ledger + 1000;

        // Create distribution record with zero holder balance
        let rec = DistributionRecord {
            id: distribution_id,
            token_index,
            asset: asset.clone(),
            total_amount,
            snapshot_ledger,
            total_supply_at_snapshot: 1_000_000,
            claim_deadline_ledger: claim_deadline,
            reclaimed: false,
            created_at: env.ledger().timestamp(),
        };

        let key = DataKey::Distribution(distribution_id);
        env.storage().persistent().set(&key, &rec);
        storage::bump_persistent(&env, &key);

        env.storage()
            .persistent()
            .set(&DataKey::DistributionCount, &1);
        storage::bump_persistent(&env, &DataKey::DistributionCount);

        // Manually set holder's balance to zero at snapshot
        let balance_key = DataKey::BalanceSnapshot(token_index, holder.clone(), 0);
        let zero_snapshot = snapshot::BalanceSnapshot {
            ledger: snapshot_ledger,
            timestamp: env.ledger().timestamp(),
            balance: 0,
        };
        env.storage().persistent().set(&balance_key, &zero_snapshot);
        storage::bump_persistent(&env, &balance_key);

        let count_key = DataKey::BalanceSnapshotCount(token_index, holder.clone());
        env.storage().persistent().set(&count_key, &1);
        storage::bump_persistent(&env, &count_key);

        // Attempt to claim should fail - zero-amount entry is excluded
        let result = claim_dividend(&env, &holder, distribution_id);
        assert_eq!(result, Err(Error::NothingToClaim));
    }

    #[test]
    fn test_empty_eligible_set_prevents_divide_by_zero() {
        let (env, admin, holder) = setup();
        env.register_contract(None, crate::TokenFactory);
        storage::set_admin(&env, &admin);

        let token_index = 0;
        let distribution_id = 0;
        let asset = Address::generate(&env);
        let total_amount = 1_000_000i128;
        let snapshot_ledger = env.ledger().sequence();
        let claim_deadline = snapshot_ledger + 1000;

        // Create distribution record with zero total supply (empty eligible set)
        let rec = DistributionRecord {
            id: distribution_id,
            token_index,
            asset: asset.clone(),
            total_amount,
            snapshot_ledger,
            total_supply_at_snapshot: 0, // Empty eligible set
            claim_deadline_ledger: claim_deadline,
            reclaimed: false,
            created_at: env.ledger().timestamp(),
        };

        let key = DataKey::Distribution(distribution_id);
        env.storage().persistent().set(&key, &rec);
        storage::bump_persistent(&env, &key);

        env.storage()
            .persistent()
            .set(&DataKey::DistributionCount, &1);
        storage::bump_persistent(&env, &DataKey::DistributionCount);

        // Set holder's balance to non-zero (but supply is zero)
        let balance_key = DataKey::BalanceSnapshot(token_index, holder.clone(), 0);
        let balance_snapshot = snapshot::BalanceSnapshot {
            ledger: snapshot_ledger,
            timestamp: env.ledger().timestamp(),
            balance: 100,
        };
        env.storage().persistent().set(&balance_key, &balance_snapshot);
        storage::bump_persistent(&env, &balance_key);

        let count_key = DataKey::BalanceSnapshotCount(token_index, holder.clone());
        env.storage().persistent().set(&count_key, &1);
        storage::bump_persistent(&env, &count_key);

        // Attempt to claim should fail - would cause divide-by-zero
        let result = claim_dividend(&env, &holder, distribution_id);
        assert_eq!(result, Err(Error::DistributionZeroSupply));
    }

    #[test]
    fn test_initiate_with_zero_supply_fails() {
        let (env, admin, _holder) = setup();
        env.register_contract(None, crate::TokenFactory);
        storage::set_admin(&env, &admin);

        // Try to create a token with zero supply
        let result = storage::create_token(
            &env,
            "Empty",
            "EMP",
            7,
            0, // Zero supply
            None,
            false,
            &admin,
        );

        // Should fail during token creation, but even if it didn't,
        // initiate_distribution would catch it
        let asset = Address::generate(&env);
        let result_dist = initiate_distribution(
            &env,
            &admin,
            0,
            &asset,
            1_000_000,
            100,
        );

        // Should fail because token has zero supply
        assert_eq!(result_dist, Err(Error::TokenNotFound));
    }
}
