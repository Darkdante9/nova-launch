import { useEffect, useState, useCallback } from 'react';
import type { VaultProjection } from '../types';

/**
 * GraphQL subscription payload for real-time vault balance updates
 */
interface VaultBalanceChangedPayload {
  vaultId: number;
  newBalance: string;
  txHash: string;
  timestamp: string;
}

/**
 * Subscribe to real-time vault balance updates via GraphQL WebSocket
 *
 * This hook manages the WebSocket connection and automatically updates
 * vault data when deposits or withdrawals occur.
 */
export function useVaultBalanceSubscription(
  vaultIds: number[],
  onBalanceChanged?: (vaultId: number, newBalance: string) => void
) {
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(() => {
    if (vaultIds.length === 0) return;

    const wsUrl = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/graphql`;
    let ws: WebSocket | null = null;

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        setIsConnected(true);
        setError(null);

        // Send connection init
        ws?.send(
          JSON.stringify({
            type: 'connection_init',
            payload: {},
          })
        );

        // Subscribe to vault balance changes for each vault
        vaultIds.forEach((vaultId, index) => {
          const subscriptionId = `vault_${vaultId}_${index}`;
          ws?.send(
            JSON.stringify({
              id: subscriptionId,
              type: 'start',
              payload: {
                query: `
                  subscription VaultBalanceChanged($vaultId: Int!) {
                    vaultBalanceChanged(vaultId: $vaultId) {
                      vaultId
                      newBalance
                      txHash
                      timestamp
                    }
                  }
                `,
                variables: { vaultId },
              },
            })
          );
        });
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          if (message.type === 'connection_ack') {
            // Connection acknowledged
            return;
          }

          if (message.type === 'data' && message.payload?.data?.vaultBalanceChanged) {
            const data = message.payload.data.vaultBalanceChanged as VaultBalanceChangedPayload;
            onBalanceChanged?.(data.vaultId, data.newBalance);
          }

          if (message.type === 'error') {
            console.error('GraphQL subscription error:', message.payload);
            setError('Subscription error');
          }
        } catch (err) {
          console.error('Failed to parse WebSocket message:', err);
        }
      };

      ws.onerror = () => {
        setIsConnected(false);
        setError('Connection failed');
      };

      ws.onclose = () => {
        setIsConnected(false);
      };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect');
      setIsConnected(false);
    }

    return () => {
      if (ws) {
        ws.close();
      }
      setIsConnected(false);
    };
  }, [vaultIds, onBalanceChanged]);

  useEffect(() => {
    const cleanup = connect();
    return cleanup;
  }, [connect]);

  return { isConnected, error };
}
