import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WalletSelector } from '../WalletSelector';

const mockWallets = [
    { id: 'freighter', name: 'Freighter', isAvailable: true, icon: '', url: 'https://freighter.app/' },
    { id: 'lobstr', name: 'Lobstr', isAvailable: false, icon: '', url: 'https://lobstr.co/' },
    { id: 'albedo', name: 'Albedo', isAvailable: true, icon: '', url: 'https://albedo.link/' },
    { id: 'xbull', name: 'xBull', isAvailable: false, icon: '', url: 'https://xbull.app/' },
];

vi.mock('../../../services/walletKit', () => ({
    getSupportedWallets: vi.fn(() => Promise.resolve(mockWallets)),
    WALLET_TYPE_MAP: {
        freighter: 'freighter',
        lobstr: 'lobstr',
        albedo: 'albedo',
        xbull: 'xbull',
    },
}));

describe('WalletSelector', () => {
    const onClose = vi.fn();
    const onSelect = vi.fn(() => Promise.resolve());

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('renders nothing when closed', () => {
        const { container } = render(
            <WalletSelector isOpen={false} onClose={onClose} onSelect={onSelect} isConnecting={false} />
        );
        expect(container.firstChild).toBeNull();
    });

    it('renders wallet list when open', async () => {
        render(
            <WalletSelector isOpen={true} onClose={onClose} onSelect={onSelect} isConnecting={false} />
        );

        await waitFor(() => {
            expect(screen.getByText('Freighter')).toBeInTheDocument();
            expect(screen.getByText('Lobstr')).toBeInTheDocument();
            expect(screen.getByText('Albedo')).toBeInTheDocument();
            expect(screen.getByText('xBull')).toBeInTheDocument();
        });
    });

    it('shows "Installed" for available wallets and "Not installed" for others', async () => {
        render(
            <WalletSelector isOpen={true} onClose={onClose} onSelect={onSelect} isConnecting={false} />
        );

        await waitFor(() => {
            const installed = screen.getAllByText('Installed');
            expect(installed).toHaveLength(2); // Freighter + Albedo

            const notInstalled = screen.getAllByText('Not installed');
            expect(notInstalled).toHaveLength(2); // Lobstr + xBull
        });
    });

    it('calls onSelect with walletId and walletType when installed wallet is clicked', async () => {
        render(
            <WalletSelector isOpen={true} onClose={onClose} onSelect={onSelect} isConnecting={false} />
        );

        await waitFor(() => screen.getByText('Freighter'));

        fireEvent.click(screen.getByLabelText('Connect with Freighter'));

        await waitFor(() => {
            expect(onSelect).toHaveBeenCalledWith('freighter', 'freighter');
        });
    });

    it('opens install URL instead of calling onSelect when wallet is not installed', async () => {
        const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

        render(
            <WalletSelector isOpen={true} onClose={onClose} onSelect={onSelect} isConnecting={false} />
        );

        await waitFor(() => screen.getByText('Lobstr'));

        fireEvent.click(screen.getByLabelText('Get Lobstr — opens installation page'));

        expect(openSpy).toHaveBeenCalledWith('https://lobstr.co/', '_blank', 'noopener,noreferrer');
        expect(onSelect).not.toHaveBeenCalled();

        openSpy.mockRestore();
    });

    it('calls onClose when backdrop is clicked', async () => {
        render(
            <WalletSelector isOpen={true} onClose={onClose} onSelect={onSelect} isConnecting={false} />
        );

        await waitFor(() => screen.getByText('Freighter'));

        // Click the backdrop (first child of the outermost div)
        const dialog = screen.getByRole('dialog');
        const backdrop = dialog.querySelector('[aria-hidden="true"]') as HTMLElement;
        fireEvent.click(backdrop);

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when Escape key is pressed', async () => {
        render(
            <WalletSelector isOpen={true} onClose={onClose} onSelect={onSelect} isConnecting={false} />
        );

        await waitFor(() => screen.getByText('Freighter'));

        fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('calls onClose when close button is clicked', async () => {
        render(
            <WalletSelector isOpen={true} onClose={onClose} onSelect={onSelect} isConnecting={false} />
        );

        await waitFor(() => screen.getByText('Freighter'));

        fireEvent.click(screen.getByLabelText('Close wallet selector'));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('disables all wallet buttons while connecting', async () => {
        render(
            <WalletSelector isOpen={true} onClose={onClose} onSelect={onSelect} isConnecting={true} />
        );

        await waitFor(() => screen.getByText('Freighter'));

        const freighterBtn = screen.getByLabelText('Connect with Freighter');
        expect(freighterBtn).toBeDisabled();
    });

    it('has accessible dialog attributes', async () => {
        render(
            <WalletSelector isOpen={true} onClose={onClose} onSelect={onSelect} isConnecting={false} />
        );

        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveAttribute('aria-modal', 'true');
        expect(dialog).toHaveAttribute('aria-labelledby', 'wallet-selector-title');

        await waitFor(() => {
            expect(screen.getByText('Connect Wallet')).toBeInTheDocument();
        });
    });
});
