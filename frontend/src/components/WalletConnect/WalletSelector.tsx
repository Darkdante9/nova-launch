import { useEffect, useState, useCallback, useRef } from 'react';
import { X, ExternalLink } from 'lucide-react';
import { getSupportedWallets, WALLET_TYPE_MAP } from '../../services/walletKit';
import type { ISupportedWallet } from '@creit.tech/stellar-wallets-kit';
import type { WalletType } from '../../types';

/**
 * Wallet compatibility matrix for Nova Launch (Stellar Testnet & Mainnet):
 *
 * | Wallet    | Type          | Browser Extension | Mobile | Notes                          |
 * |-----------|---------------|-------------------|--------|--------------------------------|
 * | Freighter | Hot wallet    | Chrome, Firefox   | No     | Official Stellar Foundation    |
 * | Lobstr    | Hot wallet    | Chrome            | Yes    | Popular in Africa / EM markets |
 * | Albedo    | Bridge wallet | No extension      | Yes    | Web-based, no install needed   |
 * | xBull     | Hot wallet    | Chrome            | Yes    | Open source Stellar wallet     |
 */

interface WalletSelectorProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (walletId: string, walletType: WalletType) => Promise<void>;
    isConnecting: boolean;
}

interface WalletOption extends ISupportedWallet {
    walletType?: WalletType;
}

export function WalletSelector({ isOpen, onClose, onSelect, isConnecting }: WalletSelectorProps) {
    const [wallets, setWallets] = useState<WalletOption[]>([]);
    const [loadingWallets, setLoadingWallets] = useState(false);
    const [connectingId, setConnectingId] = useState<string | null>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    const closeBtnRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!isOpen) return;

        setLoadingWallets(true);
        getSupportedWallets()
            .then((supported) => {
                const mapped: WalletOption[] = supported.map((w) => ({
                    ...w,
                    walletType: WALLET_TYPE_MAP[w.id],
                }));
                setWallets(mapped);
            })
            .catch(() => setWallets([]))
            .finally(() => setLoadingWallets(false));
    }, [isOpen]);

    // Focus the close button when modal opens
    useEffect(() => {
        if (isOpen) {
            setTimeout(() => closeBtnRef.current?.focus(), 50);
        }
    }, [isOpen]);

    // Trap focus inside modal
    const handleKeyDown = useCallback(
        (e: React.KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        },
        [onClose]
    );

    const handleWalletSelect = useCallback(
        async (wallet: WalletOption) => {
            if (!wallet.walletType) return;

            if (!wallet.isAvailable) {
                window.open(wallet.url, '_blank', 'noopener,noreferrer');
                return;
            }

            setConnectingId(wallet.id);
            try {
                await onSelect(wallet.id, wallet.walletType);
            } finally {
                setConnectingId(null);
            }
        },
        [onSelect]
    );

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="wallet-selector-title"
            onKeyDown={handleKeyDown}
        >
            {/* Backdrop */}
            <div
                className="absolute inset-0 bg-black/50 backdrop-blur-sm"
                onClick={onClose}
                aria-hidden="true"
            />

            {/* Modal */}
            <div
                ref={dialogRef}
                className="relative z-10 w-full max-w-sm rounded-2xl bg-white shadow-2xl border border-gray-100"
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
                    <h2
                        id="wallet-selector-title"
                        className="text-base font-semibold text-gray-900"
                    >
                        Connect Wallet
                    </h2>
                    <button
                        ref={closeBtnRef}
                        onClick={onClose}
                        className="rounded-lg p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-400"
                        aria-label="Close wallet selector"
                        disabled={isConnecting}
                    >
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {/* Wallet list */}
                <div className="p-3 space-y-1" role="list" aria-label="Available wallets">
                    {loadingWallets ? (
                        <div className="flex items-center justify-center py-8 text-sm text-gray-500">
                            <svg className="animate-spin h-4 w-4 mr-2 text-blue-500" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                            </svg>
                            Detecting wallets...
                        </div>
                    ) : wallets.length === 0 ? (
                        <p className="text-sm text-gray-500 text-center py-8">No wallets found.</p>
                    ) : (
                        wallets.map((wallet) => {
                            const isThisConnecting = connectingId === wallet.id;
                            const isInstalled = wallet.isAvailable;

                            return (
                                <div key={wallet.id} role="listitem">
                                    <button
                                        onClick={() => void handleWalletSelect(wallet)}
                                        disabled={isConnecting}
                                        className={[
                                            'w-full flex items-center gap-3 rounded-xl px-3 py-3 text-left transition-all',
                                            'focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-1',
                                            isConnecting
                                                ? 'opacity-60 cursor-not-allowed'
                                                : 'hover:bg-gray-50 active:bg-gray-100 cursor-pointer',
                                        ].join(' ')}
                                        aria-label={
                                            isInstalled
                                                ? `Connect with ${wallet.name}`
                                                : `Get ${wallet.name} — opens installation page`
                                        }
                                        aria-busy={isThisConnecting}
                                    >
                                        {/* Icon */}
                                        <div className="flex-shrink-0 w-10 h-10 rounded-xl overflow-hidden border border-gray-100 bg-gray-50 flex items-center justify-center">
                                            {wallet.icon ? (
                                                <img
                                                    src={wallet.icon}
                                                    alt=""
                                                    className="w-8 h-8 object-contain"
                                                    aria-hidden="true"
                                                />
                                            ) : (
                                                <span className="text-lg font-bold text-gray-400">
                                                    {wallet.name[0]}
                                                </span>
                                            )}
                                        </div>

                                        {/* Name + status */}
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-medium text-gray-900 truncate">
                                                {wallet.name}
                                            </p>
                                            <p className="text-xs text-gray-500 mt-0.5">
                                                {isInstalled ? (
                                                    <span className="text-green-600 font-medium">Installed</span>
                                                ) : (
                                                    <span className="text-gray-400">Not installed</span>
                                                )}
                                            </p>
                                        </div>

                                        {/* Right side action */}
                                        <div className="flex-shrink-0">
                                            {isThisConnecting ? (
                                                <svg className="animate-spin h-4 w-4 text-blue-500" viewBox="0 0 24 24">
                                                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                                </svg>
                                            ) : !isInstalled ? (
                                                <ExternalLink className="w-4 h-4 text-gray-400" aria-hidden="true" />
                                            ) : null}
                                        </div>
                                    </button>
                                </div>
                            );
                        })
                    )}
                </div>

                {/* Footer note */}
                <p className="px-5 pb-4 text-xs text-gray-400 text-center">
                    Private keys never leave your wallet. Nova Launch is non-custodial.
                </p>
            </div>
        </div>
    );
}
