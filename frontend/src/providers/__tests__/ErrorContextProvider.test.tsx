import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ErrorContextProvider, useErrorContext } from '../ErrorContextProvider';

describe('ErrorContextProvider', () => {
  it('defaults every tx context field to null', () => {
    const { result } = renderHook(() => useErrorContext(), {
      wrapper: ErrorContextProvider,
    });

    expect(result.current.txContext).toEqual({
      txHash: null,
      ledgerSequence: null,
      walletAddress: null,
      route: null,
      network: null,
    });
  });

  it('merges patches into the existing context rather than replacing it', () => {
    const { result } = renderHook(() => useErrorContext(), {
      wrapper: ErrorContextProvider,
    });

    act(() => {
      result.current.setTxContext({ walletAddress: 'GTEST', network: 'testnet' });
    });
    act(() => {
      result.current.setTxContext({ txHash: 'hash1' });
    });

    expect(result.current.txContext).toMatchObject({
      walletAddress: 'GTEST',
      network: 'testnet',
      txHash: 'hash1',
    });
  });

  it('returns a no-op setter when used outside a provider', () => {
    const { result } = renderHook(() => useErrorContext());

    expect(() => result.current.setTxContext({ txHash: 'x' })).not.toThrow();
    expect(result.current.txContext.txHash).toBeNull();
  });
});
