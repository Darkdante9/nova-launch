/**
 * QuorumProgressBar
 * Displays how close the total votes are to reaching the quorum threshold.
 */

interface QuorumProgressBarProps {
    votesFor: string;
    votesAgainst: string;
    quorum: string;
}

export function QuorumProgressBar({ votesFor, votesAgainst, quorum }: QuorumProgressBarProps) {
    const total = parseInt(votesFor) + parseInt(votesAgainst);
    const quorumTarget = parseInt(quorum);
    const percentage = quorumTarget > 0 ? Math.min((total / quorumTarget) * 100, 100) : 0;
    const reached = total >= quorumTarget;

    return (
        <div data-testid="quorum-progress-bar">
            <div className="flex items-center justify-between text-sm mb-1">
                <span className="text-gray-600 font-medium">Quorum Progress</span>
                <span className={reached ? 'text-green-600 font-medium' : 'text-gray-500'}>
                    {total} / {quorum} {reached && '✓'}
                </span>
            </div>
            <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
                <div
                    className={`h-full rounded-full transition-all duration-300 ${reached ? 'bg-green-500' : 'bg-blue-500'}`}
                    style={{ width: `${percentage}%` }}
                    data-testid="quorum-bar-fill"
                />
            </div>
        </div>
    );
}

export default QuorumProgressBar;
