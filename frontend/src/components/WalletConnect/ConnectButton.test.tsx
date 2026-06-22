import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ConnectButton } from "./ConnectButton";

// Mock WalletSelector to avoid fetching wallets in unit tests
vi.mock("./WalletSelector", () => ({
  WalletSelector: ({
    isOpen,
    onClose,
    onSelect,
    isConnecting,
  }: {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (id: string, type: string) => Promise<void>;
    isConnecting: boolean;
  }) => {
    if (!isOpen) return null;
    return (
      <div role="dialog" aria-modal="true" aria-labelledby="wallet-selector-title">
        <h2 id="wallet-selector-title">Connect Wallet</h2>
        <button onClick={onClose} aria-label="Close wallet selector">
          Close
        </button>
        <button
          onClick={() => void onSelect("freighter", "freighter")}
          disabled={isConnecting}
          aria-label="Connect with Freighter"
        >
          Freighter
        </button>
        <button
          onClick={() =>
            window.open("https://lobstr.co/", "_blank", "noopener,noreferrer")
          }
          aria-label="Get Lobstr — opens installation page"
        >
          Lobstr (Not installed)
        </button>
      </div>
    );
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

describe("ConnectButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (typeof window !== "undefined") {
      const win = window as unknown as Record<string, unknown>;
      delete win.freighter;
    }
  });

  it("renders connect button in disconnected state", () => {
    render(<ConnectButton />);
    expect(
      screen.getByRole("button", { name: "Connect Wallet" })
    ).toBeInTheDocument();
  });

  it("opens wallet selector modal when Connect Wallet is clicked", () => {
    render(<ConnectButton />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Connect Wallet", { selector: "h2" })).toBeInTheDocument();
  });

  it("closes modal when close button inside selector is clicked", () => {
    render(<ConnectButton />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Close wallet selector"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows loading state when externalConnecting prop is true", () => {
    render(<ConnectButton isConnecting={true} />);
    expect(
      screen.getByRole("button", { name: "Connecting..." })
    ).toBeInTheDocument();
  });

  it("shows error when Freighter wallet is not installed (standalone mode)", async () => {
    render(<ConnectButton />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
    await waitFor(() => screen.getByLabelText("Connect with Freighter"));
    fireEvent.click(screen.getByLabelText("Connect with Freighter"));

    await waitFor(() => {
      expect(screen.getByText("Connection Error")).toBeInTheDocument();
      expect(
        screen.getByText(/Freighter wallet not installed/)
      ).toBeInTheDocument();
    });
  });

  it("displays Freighter installation link when not installed (standalone mode)", async () => {
    render(<ConnectButton />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
    await waitFor(() => screen.getByLabelText("Connect with Freighter"));
    fireEvent.click(screen.getByLabelText("Connect with Freighter"));

    await waitFor(() => {
      const link = screen.getByRole("link", { name: "Install Freighter wallet" });
      expect(link).toHaveAttribute("href", "https://freighter.app/");
      expect(link).toHaveAttribute("target", "_blank");
    });
  });

  it("calls onConnect callback when Freighter is installed (standalone mode)", async () => {
    const onConnect = vi.fn();
    const win = window as unknown as Record<string, unknown>;
    win.freighter = {
      requestPublicKey: vi.fn(() => Promise.resolve({ publicKey: "GB7Z" })),
    };

    render(<ConnectButton onConnect={onConnect} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
    await waitFor(() => screen.getByLabelText("Connect with Freighter"));
    fireEvent.click(screen.getByLabelText("Connect with Freighter"));

    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith("GB7Z");
    });
  });

  it("calls onWalletSelect when wired and a wallet is picked", async () => {
    const onWalletSelect = vi.fn(() => Promise.resolve());

    render(<ConnectButton onWalletSelect={onWalletSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
    await waitFor(() => screen.getByLabelText("Connect with Freighter"));
    fireEvent.click(screen.getByLabelText("Connect with Freighter"));

    await waitFor(() => {
      expect(onWalletSelect).toHaveBeenCalledWith("freighter", "freighter");
    });
  });

  it("shows disconnect button after Freighter connects (standalone mode)", async () => {
    const win = window as unknown as Record<string, unknown>;
    win.freighter = {
      requestPublicKey: vi.fn(() => Promise.resolve({ publicKey: "GB7ZXA" })),
    };

    render(<ConnectButton />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
    await waitFor(() => screen.getByLabelText("Connect with Freighter"));
    fireEvent.click(screen.getByLabelText("Connect with Freighter"));

    await waitFor(() => {
      const disconnectButtons = screen.getAllByRole("button", {
        name: "Disconnect wallet",
      });
      expect(disconnectButtons.length).toBeGreaterThan(0);
    });
  });

  it("disconnects wallet when disconnect button is clicked (standalone mode)", async () => {
    const win = window as unknown as Record<string, unknown>;
    win.freighter = {
      requestPublicKey: vi.fn(() => Promise.resolve({ publicKey: "GB7ZXA" })),
    };

    render(<ConnectButton />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
    await waitFor(() => screen.getByLabelText("Connect with Freighter"));
    fireEvent.click(screen.getByLabelText("Connect with Freighter"));

    await waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: "Disconnect wallet" }).length
      ).toBeGreaterThan(0);
    });

    const disconnectButtons = screen.getAllByRole("button", {
      name: "Disconnect wallet",
    });
    fireEvent.click(disconnectButtons[0]);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Connect Wallet" })
      ).toBeInTheDocument();
    });
  });

  it("has proper aria-label on connect button", () => {
    render(<ConnectButton />);
    expect(
      screen.getByRole("button", { name: "Connect Wallet" })
    ).toHaveAttribute("aria-label", "Connect Wallet");
  });

  it("shows Connecting... text and is disabled during connection (via externalConnecting)", () => {
    render(<ConnectButton isConnecting={true} />);
    const connectingButton = screen.getByRole("button", { name: "Connecting..." });
    expect(connectingButton).toBeDisabled();
  });

  it("displays error with aria-live for accessibility (standalone mode)", async () => {
    render(<ConnectButton />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
    await waitFor(() => screen.getByLabelText("Connect with Freighter"));
    fireEvent.click(screen.getByLabelText("Connect with Freighter"));

    await waitFor(() => {
      const errorDiv = screen.getByRole("alert");
      expect(errorDiv).toHaveAttribute("aria-live", "polite");
    });
  });

  it("responsive: shows shortened display on mobile after connect (standalone mode)", async () => {
    const win = window as unknown as Record<string, unknown>;
    win.freighter = {
      requestPublicKey: vi.fn(() =>
        Promise.resolve({
          publicKey: "GBBD47HRSOVUQY5RWABXBQXF2EHHFWWSWP2RGWQWZ2UGLJMVX3JBQNPM",
        })
      ),
    };

    render(<ConnectButton />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Wallet" }));
    await waitFor(() => screen.getByLabelText("Connect with Freighter"));
    fireEvent.click(screen.getByLabelText("Connect with Freighter"));

    await waitFor(() => {
      const mobileButton = screen.getByRole("button", { name: "Connected wallet" });
      expect(mobileButton).toHaveClass("sm:hidden");
    });
  });
});
