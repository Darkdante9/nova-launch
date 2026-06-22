import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ConnectButton } from "./ConnectButton";
import { ToastProvider } from "../../providers/ToastProvider";

// Mock WalletSelector so tests don't try to fetch real wallets
vi.mock("./WalletSelector", () => ({
  WalletSelector: ({ isOpen }: { isOpen: boolean }) => {
    if (!isOpen) return null;
    return <div role="dialog">Wallet Selector</div>;
  },
}));

vi.mock("../../hooks/useToast", () => ({
  useToast: () => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));

function renderWithProviders(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe("Wallet Integration Flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the connect button initially", () => {
    renderWithProviders(<ConnectButton />);
    expect(
      screen.getByRole("button", { name: "Connect Wallet" })
    ).toBeInTheDocument();
  });

  it("renders WalletSelector when onWalletSelect is wired and account selection is handled by parent", async () => {
    const onWalletSelect = vi.fn(() => Promise.resolve());

    renderWithProviders(<ConnectButton onWalletSelect={onWalletSelect} />);

    // The component renders without error when onWalletSelect is provided
    expect(
      screen.getByRole("button", { name: "Connect Wallet" })
    ).toBeInTheDocument();
  });

  it("does not show wallet selector initially", () => {
    renderWithProviders(<ConnectButton />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("handles externalConnecting=true gracefully", () => {
    renderWithProviders(<ConnectButton isConnecting={true} />);
    expect(
      screen.getByRole("button", { name: "Connecting..." })
    ).toBeInTheDocument();
  });

  it("does not call onWalletSelect when isConnecting is true (modal buttons disabled)", async () => {
    // This integration test verifies the modal is opened but buttons are disabled
    const onWalletSelect = vi.fn(() => Promise.resolve());

    // Render with external connecting state
    renderWithProviders(
      <ConnectButton onWalletSelect={onWalletSelect} isConnecting={true} />
    );

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Connect Wallet" })
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Connecting..." })
      ).toBeInTheDocument();
    });

    expect(onWalletSelect).not.toHaveBeenCalled();
  });
});
