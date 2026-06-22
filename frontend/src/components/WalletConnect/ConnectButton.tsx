import { useState, useCallback } from "react";
import { LoadingButton } from "../UI";
import { Button } from "../UI/Button";
import { useToast } from "../../hooks/useToast";
import { WalletSelector } from "./WalletSelector";
import type { WalletType } from "../../types";

interface ConnectButtonProps {
  onConnect?: (publicKey: string) => void;
  onError?: (error: Error) => void;
  className?: string;
  /** Called when the user selects a wallet from the modal. */
  onWalletSelect?: (walletId: string, walletType: WalletType) => Promise<void>;
  isConnecting?: boolean;
}

export function ConnectButton({
  onConnect,
  onError,
  className = "",
  onWalletSelect,
  isConnecting: externalConnecting,
}: ConnectButtonProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const { success, error: errorToast, info } = useToast();

  const isActuallyConnecting = externalConnecting ?? isLoading;

  const handleOpenSelector = useCallback(() => {
    setError(null);
    setIsSelectorOpen(true);
  }, []);

  const handleWalletSelect = useCallback(
    async (walletId: string, walletType: WalletType) => {
      try {
        setIsLoading(true);
        setError(null);

        if (onWalletSelect) {
          await onWalletSelect(walletId, walletType);
          // If onWalletSelect resolves, the parent controls connection state
          return;
        }

        // Standalone mode: use window.freighter for backward compat when no handler is wired
        if (walletId === "freighter") {
          const win = window as unknown as Record<string, any>;
          if (!win.freighter) {
            const msg = "Freighter wallet not installed. Please install the Freighter extension.";
            setError(msg);
            errorToast(msg);
            onError?.(new Error(msg));
            return;
          }
          const response = await win.freighter.requestPublicKey();
          if (response?.publicKey) {
            setIsConnected(true);
            setPublicKey(response.publicKey);
            setIsSelectorOpen(false);
            success(`Wallet connected: ${response.publicKey.slice(0, 8)}...`);
            onConnect?.(response.publicKey);
          }
        }
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to connect wallet. Please try again.";
        setError(msg);
        errorToast(msg);
        onError?.(err instanceof Error ? err : new Error(msg));
      } finally {
        setIsLoading(false);
      }
    },
    [onWalletSelect, onConnect, onError, success, errorToast]
  );

  const handleDisconnect = useCallback(() => {
    setIsConnected(false);
    setPublicKey(null);
    setError(null);
    info("Wallet disconnected");
  }, [info]);

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {isConnected && publicKey ? (
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="md"
            className="hidden sm:inline-flex cursor-default"
            aria-label={`Connected wallet: ${publicKey}`}
            title={publicKey}
            disabled
          >
            {publicKey.slice(0, 8)}...{publicKey.slice(-8)}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            className="sm:hidden cursor-default"
            aria-label="Connected wallet"
            title={publicKey}
            disabled
          >
            Connected
          </Button>
          <Button
            onClick={handleDisconnect}
            variant="outline"
            size="md"
            className="hidden sm:inline-flex"
            aria-label="Disconnect wallet"
          >
            Disconnect
          </Button>
          <Button
            onClick={handleDisconnect}
            variant="outline"
            size="sm"
            className="sm:hidden"
            aria-label="Disconnect wallet"
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <LoadingButton
          onClick={handleOpenSelector}
          loading={isActuallyConnecting}
          loadingText="Connecting..."
          size="md"
          aria-label={isActuallyConnecting ? "Connecting..." : "Connect Wallet"}
          aria-describedby={error ? "wallet-error" : undefined}
        >
          Connect Wallet
        </LoadingButton>
      )}

      {error && (
        <div
          id="wallet-error"
          className="text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2"
          role="alert"
          aria-live="polite"
        >
          <p className="font-medium">Connection Error</p>
          <p className="text-xs mt-1">{error}</p>
          {error.includes("Freighter") && (
            <a
              href="https://freighter.app/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-red-700 hover:text-red-800 underline text-xs mt-2 inline-block"
              aria-label="Install Freighter wallet"
            >
              Install Freighter →
            </a>
          )}
        </div>
      )}

      <WalletSelector
        isOpen={isSelectorOpen}
        onClose={() => setIsSelectorOpen(false)}
        onSelect={handleWalletSelect}
        isConnecting={isActuallyConnecting}
      />
    </div>
  );
}
