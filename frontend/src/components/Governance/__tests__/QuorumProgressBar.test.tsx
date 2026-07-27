import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QuorumProgressBar } from '../QuorumProgressBar';

describe('QuorumProgressBar', () => {
    it('renders with correct vote counts', () => {
        render(<QuorumProgressBar votesFor="300" votesAgainst="100" quorum="500" />);
        expect(screen.getByTestId('quorum-progress-bar')).toBeDefined();
        expect(screen.getByText(/400 \/ 500/)).toBeDefined();
    });

    it('shows quorum reached when total >= quorum', () => {
        render(<QuorumProgressBar votesFor="400" votesAgainst="200" quorum="500" />);
        expect(screen.getByText(/✓/)).toBeDefined();
    });

    it('fills bar proportionally', () => {
        render(<QuorumProgressBar votesFor="250" votesAgainst="0" quorum="500" />);
        const fill = screen.getByTestId('quorum-bar-fill');
        expect(fill.style.width).toBe('50%');
    });

    it('clamps bar at 100% when votes exceed quorum', () => {
        render(<QuorumProgressBar votesFor="800" votesAgainst="200" quorum="500" />);
        const fill = screen.getByTestId('quorum-bar-fill');
        expect(fill.style.width).toBe('100%');
    });

    it('renders 0% when no votes', () => {
        render(<QuorumProgressBar votesFor="0" votesAgainst="0" quorum="500" />);
        const fill = screen.getByTestId('quorum-bar-fill');
        expect(fill.style.width).toBe('0%');
    });

    it('handles zero quorum without crashing', () => {
        render(<QuorumProgressBar votesFor="100" votesAgainst="50" quorum="0" />);
        expect(screen.getByTestId('quorum-progress-bar')).toBeDefined();
    });
});
