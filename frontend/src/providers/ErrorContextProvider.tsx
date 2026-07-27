import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

/**
 * Stellar transaction context attached to error reports. Deliberately a
 * narrow, explicit whitelist — never add free-form/arbitrary fields here,
 * since this object is sent to the backend on every caught render error.
 * Never include private keys, seed phrases, or signed transaction payloads.
 */
export interface ErrorTxContext {
  txHash: string | null;
  ledgerSequence: number | null;
  walletAddress: string | null;
  route: string | null;
  network: string | null;
}

export interface ErrorContextValue {
  txContext: ErrorTxContext;
  /** Merge new fields into the current context. Pass `null` to clear a field. */
  setTxContext: (patch: Partial<ErrorTxContext>) => void;
}

const EMPTY_TX_CONTEXT: ErrorTxContext = {
  txHash: null,
  ledgerSequence: null,
  walletAddress: null,
  route: null,
  network: null,
};

export const ErrorContext = createContext<ErrorContextValue>({
  txContext: EMPTY_TX_CONTEXT,
  setTxContext: () => {},
});

export function useErrorContext(): ErrorContextValue {
  return useContext(ErrorContext);
}

export function ErrorContextProvider({ children }: { children: ReactNode }) {
  const [txContext, setTxContextState] = useState<ErrorTxContext>(EMPTY_TX_CONTEXT);

  const setTxContext = useCallback((patch: Partial<ErrorTxContext>) => {
    setTxContextState((prev) => ({ ...prev, ...patch }));
  }, []);

  const value = useMemo(() => ({ txContext, setTxContext }), [txContext, setTxContext]);

  return <ErrorContext.Provider value={value}>{children}</ErrorContext.Provider>;
}
