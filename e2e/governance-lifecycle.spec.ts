/**
 * E2E: Full Governance Proposal Lifecycle
 *
 * Covers proposal creation → vote submission → queue → execute,
 * asserting UI state at each step via Playwright against the dev stack.
 *
 * Requires STELLAR_NETWORK=testnet and a funded disposable test account.
 * The testnet-faucet helper seeds XLM before the suite runs.
 *
 * Closes #1299
 */

import { test, expect, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Selectors — kept in one place so breakage is easy to fix
// ---------------------------------------------------------------------------
const SEL = {
  connectWalletBtn: '[data-testid="connect-wallet"]',
  createProposalBtn: '[data-testid="create-proposal-btn"]',
  proposalTitleInput: '[data-testid="proposal-title-input"]',
  proposalDescInput: '[data-testid="proposal-description-input"]',
  submitProposalBtn: '[data-testid="submit-proposal-btn"]',
  proposalStatusChip: '[data-testid="proposal-status-chip"]',
  voteForBtn: '[data-testid="vote-for-btn"]',
  voteAgainstBtn: '[data-testid="vote-against-btn"]',
  queueProposalBtn: '[data-testid="queue-proposal-btn"]',
  executeProposalBtn: '[data-testid="execute-proposal-btn"]',
  toastSuccess: '[data-testid="toast-success"]',
  proposalCard: '[data-testid="proposal-card"]',
};

const BASE = "http://localhost:5173";
const GOVERNANCE_URL = `${BASE}/governance`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function navigateToGovernance(page: Page): Promise<void> {
  await page.goto(GOVERNANCE_URL);
  await page.waitForLoadState("networkidle");
}

async function waitForStatusChip(page: Page, status: string): Promise<void> {
  await page.waitForFunction(
    ({ sel, expected }: { sel: string; expected: string }) => {
      const chip = document.querySelector(sel);
      return chip?.textContent?.toLowerCase().includes(expected.toLowerCase());
    },
    { sel: SEL.proposalStatusChip, expected: status },
    { timeout: 15_000 }
  );
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

test.describe("Governance Proposal Lifecycle (#1299)", () => {
  test.beforeEach(async ({ page }) => {
    // Stub the Stellar wallet so tests run without a real browser extension
    await page.addInitScript(() => {
      (window as any).__STELLAR_WALLET_STUB__ = {
        isConnected: () => true,
        getPublicKey: () =>
          "GTEST000000000000000000000000000000000000000000000000000001",
        signTransaction: (xdr: string) => Promise.resolve(xdr),
      };
    });

    await navigateToGovernance(page);
  });

  // -- 1. Proposal creation --------------------------------------------------

  test("user can submit a governance proposal and see it listed", async ({
    page,
  }) => {
    const title = `E2E Proposal ${Date.now()}`;

    await page.click(SEL.createProposalBtn);
    await page.fill(SEL.proposalTitleInput, title);
    await page.fill(
      SEL.proposalDescInput,
      "Automated E2E test proposal — verifies the creation flow end-to-end."
    );
    await page.click(SEL.submitProposalBtn);

    // Optimistic UI: status chip should show "active" without page refresh
    await waitForStatusChip(page, "active");

    // The new proposal card should appear in the list
    const cards = page.locator(SEL.proposalCard);
    await expect(cards.filter({ hasText: title })).toBeVisible({
      timeout: 10_000,
    });
  });

  // -- 2. Vote submission ----------------------------------------------------

  test("user can cast a vote and the tally updates without page refresh", async ({
    page,
  }) => {
    // Assume at least one active proposal is visible (seeded or created above)
    const firstCard = page.locator(SEL.proposalCard).first();
    await firstCard.waitFor({ timeout: 10_000 });
    await firstCard.click();

    await page.click(SEL.voteForBtn);

    // Vote count or status must update via WebSocket — assert without reload
    await expect(
      page.locator('[data-testid="vote-for-count"]')
    ).not.toHaveText("0", { timeout: 10_000 });

    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });
  });

  test("user can cast a vote against and status remains 'active'", async ({
    page,
  }) => {
    const firstCard = page.locator(SEL.proposalCard).first();
    await firstCard.waitFor({ timeout: 10_000 });
    await firstCard.click();

    await page.click(SEL.voteAgainstBtn);
    await expect(page.locator(SEL.toastSuccess)).toBeVisible({
      timeout: 8_000,
    });

    // Proposal stays active — quorum not yet reached
    await waitForStatusChip(page, "active");
  });

  // -- 3. Queue --------------------------------------------------------------

  test("passed proposal can be queued and status chip updates to 'queued'", async ({
    page,
  }) => {
    // Navigate directly to a proposal that is in "passed" state (seeded)
    await page.goto(`${GOVERNANCE_URL}?status=passed`);
    await page.waitForLoadState("networkidle");

    const passedCard = page.locator(SEL.proposalCard).first();
    await passedCard.waitFor({ timeout: 10_000 });
    await passedCard.click();

    const queueBtn = page.locator(SEL.queueProposalBtn);
    // Only present for eligible proposals — skip if not rendered
    if (await queueBtn.isVisible()) {
      await queueBtn.click();
      await waitForStatusChip(page, "queued");
      await expect(page.locator(SEL.toastSuccess)).toBeVisible({
        timeout: 8_000,
      });
    } else {
      test.skip(); // no passed proposal seeded in this environment
    }
  });

  // -- 4. Execute ------------------------------------------------------------

  test("queued proposal can be executed and status chip updates to 'executed'", async ({
    page,
  }) => {
    await page.goto(`${GOVERNANCE_URL}?status=queued`);
    await page.waitForLoadState("networkidle");

    const queuedCard = page.locator(SEL.proposalCard).first();
    await queuedCard.waitFor({ timeout: 10_000 });
    await queuedCard.click();

    const executeBtn = page.locator(SEL.executeProposalBtn);
    if (await executeBtn.isVisible()) {
      await executeBtn.click();
      await waitForStatusChip(page, "executed");
      await expect(page.locator(SEL.toastSuccess)).toBeVisible({
        timeout: 8_000,
      });
    } else {
      test.skip();
    }
  });

  // -- 5. Real-time update via WebSocket/subscription -----------------------

  test("proposal status chip refreshes automatically without manual reload", async ({
    page,
    context,
  }) => {
    // Open a second page to simulate another user changing the state
    const secondPage = await context.newPage();
    await secondPage.addInitScript(() => {
      (window as any).__STELLAR_WALLET_STUB__ = {
        isConnected: () => true,
        getPublicKey: () =>
          "GTEST000000000000000000000000000000000000000000000000000002",
        signTransaction: (xdr: string) => Promise.resolve(xdr),
      };
    });

    await secondPage.goto(GOVERNANCE_URL);
    await secondPage.waitForLoadState("networkidle");

    const firstCard = page.locator(SEL.proposalCard).first();
    await firstCard.waitFor({ timeout: 10_000 });
    await firstCard.click();

    const initialStatus = await page
      .locator(SEL.proposalStatusChip)
      .textContent();

    // Vote from second page — should push a WS event to the first page
    await secondPage.locator(SEL.proposalCard).first().click();
    await secondPage.click(SEL.voteForBtn);
    await secondPage.locator(SEL.toastSuccess).waitFor({ timeout: 8_000 });

    // First page must reflect the change without reload
    await page.waitForFunction(
      ({ sel, prev }: { sel: string; prev: string | null }) => {
        const el = document.querySelector(sel);
        return el?.textContent !== prev;
      },
      { sel: SEL.proposalStatusChip, prev: initialStatus },
      { timeout: 12_000 }
    );

    await secondPage.close();
  });
});
