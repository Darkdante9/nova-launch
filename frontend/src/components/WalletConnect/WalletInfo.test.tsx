import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WalletInfo } from "./WalletInfo";
import type { WalletState } from "../../types";

vi.mock("../../services/wallet", () => ({
    WalletService: {
        getBalance: vi.fn(() => Promise.resolve("125.5000000")),
    },
}));

vi.mock("../../../vite-env.d.ts", () => ({}));

const mockWallet: WalletState = {
    connected: true,
    address: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    network: "testnet",
};

describe("WalletInfo", () => {
    const mockDisconnect = vi.fn();

    beforeEach(() => {
        vi.clearAllMocks();
        Object.assign(navigator, {
            clipboard: { writeText: vi.fn(() => Promise.resolve()) },
        });
        // Reset env default
        (import.meta.env as Record<string, unknown>).VITE_NETWORK = "testnet";
    });

    it("renders nothing when wallet is not connected", () => {
        const disconnectedWallet: WalletState = {
            connected: false,
            address: null,
            network: "testnet",
        };
        const { container } = render(
            <WalletInfo wallet={disconnectedWallet} onDisconnect={mockDisconnect} />
        );
        expect(container.firstChild).toBeNull();
    });

    it("displays truncated wallet address", () => {
        render(<WalletInfo wallet={mockWallet} onDisconnect={mockDisconnect} />);
        expect(screen.getByText("GBBD47...FLA5")).toBeInTheDocument();
    });

    it("shows the full address in a tooltip on hover", async () => {
        render(<WalletInfo wallet={mockWallet} onDisconnect={mockDisconnect} />);
        const truncated = screen.getByText("GBBD47...FLA5");
        fireEvent.mouseEnter(truncated.parentElement!);
        await waitFor(() => {
            expect(screen.getByRole("tooltip")).toHaveTextContent(mockWallet.address!);
        });
    });

    it("displays XLM balance after loading", async () => {
        render(<WalletInfo wallet={mockWallet} onDisconnect={mockDisconnect} />);
        await waitFor(() => {
            expect(screen.getByText(/125\.50/)).toBeInTheDocument();
            expect(screen.getByText("XLM")).toBeInTheDocument();
        });
    });

    it("copies address to clipboard when copy button is clicked", async () => {
        render(<WalletInfo wallet={mockWallet} onDisconnect={mockDisconnect} />);
        const copyButton = screen.getByLabelText("Copy address to clipboard");
        fireEvent.click(copyButton);
        await waitFor(() => {
            expect(navigator.clipboard.writeText).toHaveBeenCalledWith(mockWallet.address);
        });
        await waitFor(() => {
            expect(screen.getByLabelText("Address copied")).toBeInTheDocument();
        });
    });

    it("calls onDisconnect when disconnect button is clicked", () => {
        render(<WalletInfo wallet={mockWallet} onDisconnect={mockDisconnect} />);
        const disconnectButton = screen.getByLabelText("Disconnect wallet");
        fireEvent.click(disconnectButton);
        expect(mockDisconnect).toHaveBeenCalledTimes(1);
    });

    it("has proper accessibility attributes", () => {
        render(<WalletInfo wallet={mockWallet} onDisconnect={mockDisconnect} />);
        expect(screen.getByRole("region", { name: "Wallet information" })).toBeInTheDocument();
        expect(screen.getByLabelText("Disconnect wallet")).toBeInTheDocument();
        expect(screen.getByLabelText("Copy address to clipboard")).toBeInTheDocument();
    });

    it("shows loading indicator while fetching balance", () => {
        render(<WalletInfo wallet={mockWallet} onDisconnect={mockDisconnect} />);
        expect(screen.getByText("Loading...")).toBeInTheDocument();
    });

    // ── Network mismatch banner tests ──────────────────────────────────────

    it("does NOT show mismatch banner when wallet network matches app network", () => {
        (import.meta.env as Record<string, unknown>).VITE_NETWORK = "testnet";
        render(<WalletInfo wallet={mockWallet} onDisconnect={mockDisconnect} />);
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("shows mismatch banner when wallet network differs from app network", () => {
        (import.meta.env as Record<string, unknown>).VITE_NETWORK = "mainnet";
        render(<WalletInfo wallet={mockWallet} onDisconnect={mockDisconnect} />);
        const banner = screen.getByRole("alert");
        expect(banner).toBeInTheDocument();
        expect(banner).toHaveTextContent("testnet");
        expect(banner).toHaveTextContent("mainnet");
        expect(banner).toHaveTextContent("Please switch networks in your wallet before continuing.");
    });

    it("hides the banner when dismiss button is clicked", () => {
        (import.meta.env as Record<string, unknown>).VITE_NETWORK = "mainnet";
        render(<WalletInfo wallet={mockWallet} onDisconnect={mockDisconnect} />);
        expect(screen.getByRole("alert")).toBeInTheDocument();
        const dismissBtn = screen.getByLabelText("Dismiss network mismatch warning");
        fireEvent.click(dismissBtn);
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("banner is case-insensitive when comparing networks", () => {
        (import.meta.env as Record<string, unknown>).VITE_NETWORK = "TESTNET";
        render(<WalletInfo wallet={mockWallet} onDisconnect={mockDisconnect} />);
        // wallet.network is "testnet", VITE_NETWORK is "TESTNET" — should NOT show banner
        expect(screen.queryByRole("alert")).toBeNull();
    });

});
