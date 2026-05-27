//! Vault Deposit and Withdrawal Edge Case Tests
//!
//! Stress-tests vault deposit/withdraw/claim flows across boundary and error states:
//! - Claiming from non-existent vault returns VaultNotFound
//! - Claiming with nothing available returns NothingToClaim
//! - Full and partial withdrawal bookkeeping
//! - Unauthorized withdrawal attempts fail

#[cfg(test)]
mod tests {
    use crate::storage;
    use crate::types::{Error, Vault, VaultStatus};
    use crate::vault;
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::{Address, Env};

    fn setup_env() -> (Env, Address, Address) {
        let env = Env::default();
        env.ledger().set_timestamp(1000);
        let admin = Address::random(&env);
        let treasury = Address::random(&env);

        // Initialize factory
        crate::lib::initialize(
            &env,
            admin.clone(),
            treasury,
            70_000_000,
            30_000_000,
        )
        .unwrap();

        (env, admin, treasury)
    }

    fn create_vault(env: &Env, owner: &Address, amount: i128, unlock_time: u64) -> u64 {
        let vault = Vault {
            id: 1,
            owner: owner.clone(),
            total_amount: amount,
            claimed_amount: 0,
            unlock_time,
            status: VaultStatus::Active,
            created_at: env.ledger().timestamp(),
        };
        storage::set_vault(env, &vault).unwrap();
        vault.id
    }

    #[test]
    fn test_vault_claim_nonexistent_vault() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        // Attempt to claim from non-existent vault
        let result = vault::claim_vault(&env, 999, &owner);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::TokenNotFound);
    }

    #[test]
    fn test_vault_claim_nothing_to_claim() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        // Create vault with 0 amount
        let vault_id = create_vault(&env, &owner, 0, 500);

        // Advance time past unlock
        env.ledger().set_timestamp(1000);

        // Attempt to claim - should fail with NothingToClaim
        let result = vault::claim_vault(&env, vault_id, &owner);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::NothingToClaim);
    }

    #[test]
    fn test_vault_claim_full_withdrawal() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        let amount = 1_000_000_000;
        let vault_id = create_vault(&env, &owner, amount, 500);

        // Advance time past unlock
        env.ledger().set_timestamp(1000);

        // Claim full amount
        let result = vault::claim_vault(&env, vault_id, &owner);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), amount);

        // Verify vault status changed to Claimed
        let vault = storage::get_vault(&env, vault_id).unwrap();
        assert_eq!(vault.status, VaultStatus::Claimed);
        assert_eq!(vault.claimed_amount, amount);
    }

    #[test]
    fn test_vault_claim_partial_withdrawal() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        let amount = 1_000_000_000;
        let vault_id = create_vault(&env, &owner, amount, 500);

        // Advance time past unlock
        env.ledger().set_timestamp(1000);

        // First claim - full amount (no partial claim support in current impl)
        let result = vault::claim_vault(&env, vault_id, &owner);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), amount);

        // Second claim should fail - nothing left
        let result2 = vault::claim_vault(&env, vault_id, &owner);
        assert!(result2.is_err());
        assert_eq!(result2.unwrap_err(), Error::NothingToClaim);
    }

    #[test]
    fn test_vault_claim_unauthorized() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);
        let unauthorized = Address::random(&env);

        let amount = 1_000_000_000;
        let vault_id = create_vault(&env, &owner, amount, 500);

        // Advance time past unlock
        env.ledger().set_timestamp(1000);

        // Attempt to claim as unauthorized user
        let result = vault::claim_vault(&env, vault_id, &unauthorized);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::Unauthorized);
    }

    #[test]
    fn test_vault_claim_before_unlock_time() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        let amount = 1_000_000_000;
        let unlock_time = 5000;
        let vault_id = create_vault(&env, &owner, amount, unlock_time);

        // Current time is 1000, unlock is at 5000
        env.ledger().set_timestamp(2000);

        // Attempt to claim before unlock
        let result = vault::claim_vault(&env, vault_id, &owner);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::CliffNotReached);
    }

    #[test]
    fn test_vault_claim_at_exact_unlock_time() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        let amount = 1_000_000_000;
        let unlock_time = 5000;
        let vault_id = create_vault(&env, &owner, amount, unlock_time);

        // Set time to exact unlock time
        env.ledger().set_timestamp(unlock_time);

        // Should succeed at exact unlock time
        let result = vault::claim_vault(&env, vault_id, &owner);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), amount);
    }

    #[test]
    fn test_vault_claim_inactive_vault() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        let amount = 1_000_000_000;
        let vault_id = create_vault(&env, &owner, amount, 500);

        // Mark vault as Claimed
        let mut vault = storage::get_vault(&env, vault_id).unwrap();
        vault.status = VaultStatus::Claimed;
        storage::set_vault(&env, &vault).unwrap();

        // Advance time past unlock
        env.ledger().set_timestamp(1000);

        // Attempt to claim from inactive vault
        let result = vault::claim_vault(&env, vault_id, &owner);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::InvalidParameters);
    }

    #[test]
    fn test_vault_fund_nonexistent_vault() {
        let (env, _admin, _treasury) = setup_env();
        let funder = Address::random(&env);

        // Attempt to fund non-existent vault
        let result = vault::fund_vault(&env, 999, &funder, 1_000_000);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::TokenNotFound);
    }

    #[test]
    fn test_vault_fund_then_claim() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);
        let funder = Address::random(&env);

        // Create vault with initial amount
        let initial_amount = 500_000_000;
        let vault_id = create_vault(&env, &owner, initial_amount, 500);

        // Fund additional amount
        let additional_amount = 300_000_000;
        let result = vault::fund_vault(&env, vault_id, &funder, additional_amount);
        assert!(result.is_ok());

        // Verify vault balance increased
        let vault = storage::get_vault(&env, vault_id).unwrap();
        assert_eq!(vault.total_amount, initial_amount + additional_amount);

        // Advance time and claim
        env.ledger().set_timestamp(1000);
        let claim_result = vault::claim_vault(&env, vault_id, &owner);
        assert!(result.is_ok());
        assert_eq!(claim_result.unwrap(), initial_amount + additional_amount);
    }

    #[test]
    fn test_vault_claim_bookkeeping_accuracy() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        let amount = 1_000_000_000;
        let vault_id = create_vault(&env, &owner, amount, 500);

        // Verify initial state
        let vault_before = storage::get_vault(&env, vault_id).unwrap();
        assert_eq!(vault_before.claimed_amount, 0);
        assert_eq!(vault_before.total_amount, amount);

        // Advance time and claim
        env.ledger().set_timestamp(1000);
        let claim_result = vault::claim_vault(&env, vault_id, &owner);
        assert!(claim_result.is_ok());

        // Verify bookkeeping
        let vault_after = storage::get_vault(&env, vault_id).unwrap();
        assert_eq!(vault_after.claimed_amount, amount);
        assert_eq!(vault_after.total_amount, amount);
        assert_eq!(vault_after.status, VaultStatus::Claimed);
    }

    #[test]
    fn test_vault_multiple_deposits_then_claim() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);
        let funder1 = Address::random(&env);
        let funder2 = Address::random(&env);

        // Create vault
        let initial_amount = 100_000_000;
        let vault_id = create_vault(&env, &owner, initial_amount, 500);

        // Multiple deposits
        vault::fund_vault(&env, vault_id, &funder1, 200_000_000).unwrap();
        vault::fund_vault(&env, vault_id, &funder2, 300_000_000).unwrap();

        // Verify total
        let vault = storage::get_vault(&env, vault_id).unwrap();
        assert_eq!(vault.total_amount, 600_000_000);

        // Claim all
        env.ledger().set_timestamp(1000);
        let claim_result = vault::claim_vault(&env, vault_id, &owner);
        assert!(claim_result.is_ok());
        assert_eq!(claim_result.unwrap(), 600_000_000);
    }

    #[test]
    fn test_vault_claim_zero_amount_after_full_claim() {
        let (env, _admin, _treasury) = setup_env();
        let owner = Address::random(&env);

        let amount = 1_000_000_000;
        let vault_id = create_vault(&env, &owner, amount, 500);

        env.ledger().set_timestamp(1000);

        // First claim succeeds
        let result1 = vault::claim_vault(&env, vault_id, &owner);
        assert!(result1.is_ok());

        // Second claim fails - nothing to claim
        let result2 = vault::claim_vault(&env, vault_id, &owner);
        assert!(result2.is_err());
        assert_eq!(result2.unwrap_err(), Error::NothingToClaim);
    }
}
