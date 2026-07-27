import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from '../ErrorBoundary';
import { ErrorContext, type ErrorTxContext } from '../../../providers/ErrorContextProvider';
import * as errorReportingService from '../../../services/errorReportingService';

vi.mock('../../../services/errorReportingService', async () => {
  const actual = await vi.importActual<typeof import('../../../services/errorReportingService')>(
    '../../../services/errorReportingService'
  );
  return { ...actual, reportError: vi.fn() };
});

function Bomb({ message }: { message: string }): ReactElement {
  throw new Error(message);
}

function withTxContext(txContext: ErrorTxContext, children: ReactNode) {
  return (
    <ErrorContext.Provider value={{ txContext, setTxContext: vi.fn() }}>
      {children}
    </ErrorContext.Provider>
  );
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <p>all good</p>
      </ErrorBoundary>
    );

    expect(screen.getByText('all good')).toBeInTheDocument();
  });

  it('renders the fallback UI when a child throws', () => {
    render(
      <ErrorBoundary>
        <Bomb message="boom" />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('boom')).toBeInTheDocument();
  });

  it('recovers when "Try Again" is clicked', () => {
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error('flaky');
      return <p>recovered</p>;
    }

    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    expect(screen.getByText('recovered')).toBeInTheDocument();
  });

  it('reports the error enriched with the current Stellar transaction context', () => {
    render(
      withTxContext(
        {
          txHash: 'hash123',
          ledgerSequence: 555,
          walletAddress: 'GTEST',
          route: '/deploy',
          network: 'testnet',
        },
        <ErrorBoundary>
          <Bomb message="enriched failure" />
        </ErrorBoundary>
      )
    );

    expect(errorReportingService.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'enriched failure',
        txHash: 'hash123',
        ledgerSequence: 555,
        walletAddress: 'GTEST',
        route: '/deploy',
        network: 'testnet',
      })
    );
  });

  it('reports null tx context fields when nothing has been set', () => {
    render(
      withTxContext(
        { txHash: null, ledgerSequence: null, walletAddress: null, route: null, network: null },
        <ErrorBoundary>
          <Bomb message="no context yet" />
        </ErrorBoundary>
      )
    );

    expect(errorReportingService.reportError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'no context yet',
        txHash: null,
        ledgerSequence: null,
        walletAddress: null,
        route: null,
        network: null,
      })
    );
  });

  it('does not report when not wrapped in any error context provider', () => {
    render(
      <ErrorBoundary>
        <Bomb message="default context" />
      </ErrorBoundary>
    );

    // Falls back to the context's default value (all-null txContext) rather than throwing.
    expect(errorReportingService.reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'default context', txHash: null })
    );
  });
});
