import { useState, useCallback, useEffect } from 'react';

type Network = 'testnet' | 'mainnet';

const NETWORK_STORAGE_KEY = 'nova_network_preference';

function getStoredNetwork(): Network {
    try {
        const stored = localStorage.getItem(NETWORK_STORAGE_KEY);
        if (stored === 'mainnet' || stored === 'testnet') {
            return stored;
        }
    } catch {
        // localStorage may be unavailable
    }
    return 'testnet';
}

export function useNetwork() {
    const [network, setNetworkState] = useState<Network>(getStoredNetwork);
    const [isChanging, setIsChanging] = useState(false);
    // Latest Stellar ledger sequence this client has observed. There's no
    // background poller (yet) — callers that learn the current ledger from a
    // transaction response or Horizon call feed it back via setLedgerSequence.
    const [ledgerSequence, setLedgerSequence] = useState<number | null>(null);

    useEffect(() => {
        try {
            localStorage.setItem(NETWORK_STORAGE_KEY, network);
        } catch {
            // localStorage may be unavailable
        }
    }, [network]);

    const setNetwork = useCallback((newNetwork: Network) => {
        setIsChanging(true);
        setNetworkState(newNetwork);
        setTimeout(() => setIsChanging(false), 300);
    }, []);

    const toggleNetwork = useCallback(() => {
        setNetwork(network === 'testnet' ? 'mainnet' : 'testnet');
    }, [network, setNetwork]);

    return {
        network,
        setNetwork,
        toggleNetwork,
        isTestnet: network === 'testnet',
        isMainnet: network === 'mainnet',
        isChanging,
        ledgerSequence,
        setLedgerSequence,
    };
}
