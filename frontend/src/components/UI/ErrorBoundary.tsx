import { Component } from 'react';
import type { ContextType, ErrorInfo, ReactNode } from 'react';
import { Button } from './Button';
import { ErrorContext } from '../../providers/ErrorContextProvider';
import { buildErrorReportPayload, reportError } from '../../services/errorReportingService';

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    // Lets componentDidCatch read the Stellar transaction context set by
    // ErrorContextProvider (which must wrap this boundary — see main.tsx).
    public static contextType = ErrorContext;
    public declare context: ContextType<typeof ErrorContext>;

    public state: State = {
        hasError: false,
        error: null,
    };

    public static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('ErrorBoundary caught an error:', error, errorInfo);

        const txContext = this.context?.txContext;
        if (txContext) {
            reportError(
                buildErrorReportPayload(error, errorInfo.componentStack ?? undefined, txContext)
            );
        }
    }

    private handleReset = () => {
        this.setState({ hasError: false, error: null });
    };

    public render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            return (
                <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
                    <div className="max-w-md w-full bg-white rounded-lg shadow-lg p-6">
                        <div className="mb-4">
                            <h1 className="text-2xl font-bold text-red-600 mb-2">Something went wrong</h1>
                            <p className="text-gray-700 mb-4">
                                {this.state.error?.message || 'An unexpected error occurred'}
                            </p>
                        </div>
                        <div className="flex justify-center gap-2">
                            <Button onClick={this.handleReset} className="flex-1">
                                Try Again
                            </Button>
                            <Button onClick={() => window.location.reload()} variant="outline" className="flex-1">
                                Reload
                            </Button>
                        </div>
                    </div>
                </div>
            );
        }

        return this.props.children;
    }
}
