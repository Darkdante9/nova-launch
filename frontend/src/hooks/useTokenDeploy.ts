import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppError, ConfirmationStep, ConfirmationStepResponse, DeploymentResult, DeploymentStatus, TokenDeployParams, TokenInfo, WalletState } from '../types';
import { ErrorCode } from '../types';
import { createError, ErrorHandler, getErrorMessage } from '../utils/errors';
import {
    isValidDescription,
    isValidImageFile,
    validateTokenParams,
} from '../utils/validation';
import { IPFSService, isValidIpfsUri } from '../services/IPFSService';
import { StellarService } from '../services/stellar.service';
import { TransactionHistoryStorage, transactionHistoryStorage } from '../services/TransactionHistoryStorage';
import { getDeploymentFeeBreakdown } from '../utils/feeCalculation';
import { analytics, AnalyticsEvent } from '../services/analytics';
import { useAnalytics } from './useAnalytics';
import { getConfirmationStep } from '../services/deploymentStatusApi';
import { DeploymentRecoveryStorage } from '../services/DeploymentRecoveryStorage';

const STATUS_MESSAGES: Record<DeploymentStatus, string> = {
    idle: '',
    uploading: 'Uploading metadata to IPFS...',
    deploying: 'Building transaction, requesting signature, and submitting to Stellar...',
    success: 'Deployment complete.',
    error: 'Deployment failed.',
};

interface UseTokenDeployOptions {
    maxRetries?: number;
    retryDelay?: number;
    baseFee?: number;
    metadataFee?: number;
}

export function useTokenDeploy(wallet: WalletState, options: UseTokenDeployOptions = {}) {
    const { network, address } = wallet;
    const { maxRetries = 3, retryDelay = 2000, baseFee, metadataFee } = options;
    const [status, setStatus] = useState<DeploymentStatus>('idle');
    const [error, setError] = useState<AppError | null>(null);
    const [retryCount, setRetryCount] = useState(0);
    const [lastParams, setLastParams] = useState<TokenDeployParams | null>(null);
    const [uploadedMetadataUri, setUploadedMetadataUri] = useState<string | null>(null);
    const [feeBumpAvailable, setFeeBumpAvailable] = useState<boolean>(false);
    const [confirmationStep, setConfirmationStep] = useState<ConfirmationStep | null>(null);
    const [confirmations, setConfirmations] = useState<{ current: number; total: number } | null>(null);
    const pollingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pollingStartRef = useRef<number | null>(null);
    const pollingTxHashRef = useRef<string | null>(null);

    const stellarService = useMemo(() => new StellarService(network), [network]);
    const ipfsService = useMemo(() => new IPFSService(), []);
    const { trackTokenDeployed, trackTokenDeployFailed } = useAnalytics();

    // Stop polling when component unmounts or txHash changes
    useEffect(() => {
        return () => {
            if (pollingRef.current) {
                clearTimeout(pollingRef.current);
                pollingRef.current = null;
            }
        };
    }, []);

    function stopPolling() {
        if (pollingRef.current) {
            clearTimeout(pollingRef.current);
            pollingRef.current = null;
        }
        pollingStartRef.current = null;
        pollingTxHashRef.current = null;
    }

    function scheduleNextPoll(txHash: string, pollFn: () => void, attempt: number) {
        // 2s base interval; after 60s switch to exponential backoff capped at 30s
        const elapsed = pollingStartRef.current ? Date.now() - pollingStartRef.current : 0;
        let interval: number;
        if (elapsed < 60_000) {
            interval = 2_000;
        } else {
            interval = Math.min(2_000 * Math.pow(1.5, attempt - 30), 30_000);
        }
        pollingRef.current = setTimeout(pollFn, interval);
    }

    function startPolling(txHash: string, network: 'testnet' | 'mainnet') {
        stopPolling();
        pollingStartRef.current = Date.now();
        pollingTxHashRef.current = txHash;
        setConfirmationStep('submitted');
        setConfirmations(null);

        let attempt = 0;

        const poll = async () => {
            // Guard: only poll for the current txHash
            if (pollingTxHashRef.current !== txHash) return;

            attempt++;
            try {
                const result: ConfirmationStepResponse = await getConfirmationStep(txHash, network);
                if (pollingTxHashRef.current !== txHash) return; // stale

                setConfirmationStep(result.step);
                if (result.confirmations !== undefined) {
                    setConfirmations({ current: result.confirmations, total: result.totalConfirmations });
                }

                if (result.step === 'finalized') {
                    stopPolling();
                    return;
                }

                scheduleNextPoll(txHash, poll, attempt);
            } catch {
                if (pollingTxHashRef.current !== txHash) return;
                // On error, keep polling with backoff
                scheduleNextPoll(txHash, poll, attempt);
            }
        };

        poll();
    }

    useEffect(() => {
        if ((status === 'uploading' || status === 'deploying') && lastParams) {
            if (address !== lastParams.adminWallet || !wallet.connected) {
                const appError = createError(ErrorCode.WALLET_NOT_CONNECTED, 'Wallet disconnected or changed during deployment. Please try again.');
                setError(appError);
                setStatus('error');
            }
        } else if (status === 'error' && (!wallet.connected || address !== lastParams?.adminWallet)) {
            // Reset if they change wallet after an error to avoid confusion
            setStatus('idle');
            setError(null);
            setRetryCount(0);
            setLastParams(null);
        }
    }, [wallet.connected, address, network, status, lastParams]);

    const deploy = async (params: TokenDeployParams): Promise<DeploymentResult> => {
        setError(null);
        // Only reset status if not already in a process or if it's a fresh start
        if (status !== 'uploading' && status !== 'deploying') {
            setStatus('idle');
        }
        setLastParams(params);
        
        // If it's a new set of params (not a retry), reset retry count and uploaded URI
        if (lastParams && (params.name !== lastParams.name || params.symbol !== lastParams.symbol)) {
            setRetryCount(0);
            setUploadedMetadataUri(null);
        }

        if (!params.adminWallet) {
            const appError = createError(ErrorCode.WALLET_NOT_CONNECTED, 'Connect your wallet before deploying.');
            setError(appError);
            setStatus('error');
            throw appError;
        }

        // Track initiation (no PII). Do NOT include wallet or addresses.
        try {
            analytics.track('token_deploy_initiated', {
                network,
                name_length: params.name ? params.name.length : 0,
                symbol: params.symbol || '',
                decimals: params.decimals || 0,
                has_metadata: Boolean(params.metadata || params.metadataUri),
            });
        } catch {}

        const validation = validateTokenParams(params);
        if (!validation.valid) {
            const details = Object.values(validation.errors).join(' ');
            const appError = createError(ErrorCode.INVALID_INPUT, details);
            setError(appError);
            setStatus('error');
            try {
                analytics.track(AnalyticsEvent.TOKEN_DEPLOY_FAILED, {
                    network,
                    errorCode: appError.code,
                });
            } catch {}
            throw appError;
        }

        let metadataUri = params.metadataUri || uploadedMetadataUri;
        if (params.metadata && !metadataUri) {
            const imageValidation = isValidImageFile(params.metadata.image);
            if (!imageValidation.valid) {
                const appError = createError(
                    ErrorCode.INVALID_INPUT,
                    imageValidation.error || 'Invalid metadata image'
                );
                setError(appError);
                setStatus('error');
                throw appError;
            }

            if (!isValidDescription(params.metadata.description)) {
                const appError = createError(
                    ErrorCode.INVALID_INPUT,
                    'Metadata description must be 500 characters or fewer'
                );
                setError(appError);
                setStatus('error');
                throw appError;
            }

    setStatus('uploading');
            try {
                metadataUri = await ipfsService.uploadMetadata(
                    params.metadata.image,
                    params.metadata.description,
                    params.name
                );
                if (!isValidIpfsUri(metadataUri)) {
                    throw new Error('IPFS upload returned an invalid URI');
                }
                setUploadedMetadataUri(metadataUri);
            } catch (uploadError) {
                ErrorHandler.handle(uploadError instanceof Error ? uploadError : new Error(getErrorMessage(uploadError)), {
                    action: 'upload-metadata',
                    feature: 'token-deploy',
                });
                const appError = createError(ErrorCode.IPFS_UPLOAD_FAILED, getErrorMessage(uploadError));
                setError(appError);
                setStatus('error');
                try {
                    analytics.track(AnalyticsEvent.TOKEN_DEPLOY_FAILED, {
                        network,
                        errorCode: appError.code,
                    });
                } catch {}
                throw appError;
            }
        }

        setStatus('deploying');

        // Check fee-bump availability for low-balance users (non-fatal)
        try {
            const apiBase = network === 'testnet' ? 'http://localhost:3001' : '';
            const feeResp = await fetch(`${apiBase}/api/stellar/fee-estimate`);
            if (feeResp.ok) {
                const feeData = await feeResp.json();
                setFeeBumpAvailable(feeData.data?.feeBumpAvailable ?? false);
            }
        } catch {
            // Non-fatal: fee-bump check failure does not block deployment
        }

        // Check if factory is paused before attempting deployment
        try {
            const isPaused = await stellarService.isPaused();
            if (isPaused) {
                const appError = createError(
                    ErrorCode.CONTRACT_ERROR,
                    'Protocol is currently paused for maintenance',
                    `The factory contract on ${network} is paused. Please try again later or contact support.`
                );
                setError(appError);
                setStatus('error');
                try {
                    analytics.track(AnalyticsEvent.TOKEN_DEPLOY_FAILED, {
                        network,
                        errorCode: appError.code,
                        reason: 'protocol_paused',
                    });
                } catch {}
                throw appError;
            }
        } catch (pauseCheckError) {
            // If pause check fails, log but continue (fail open to avoid blocking users)
            console.warn('Failed to check pause state, continuing with deployment:', pauseCheckError);
        }

        try {
            const feeBreakdown = getDeploymentFeeBreakdown(Boolean(metadataUri));
            const feePayment = BigInt(Math.round(feeBreakdown.totalFee * 10_000_000));
            const serviceResult = await stellarService.deployToken({
                ...params,
                metadataUri,
                creatorAddress: params.adminWallet,
                feePayment,
            });
            const result: DeploymentResult = {
                tokenAddress: serviceResult.tokenAddress,
                transactionHash: serviceResult.transactionHash,
                totalFee: String(feeBreakdown.totalFee),
                timestamp: Date.now(),
                metadataUrl: metadataUri,
            };
            
            // Checkpoint: Contract call submitted (tx hash obtained)
            const checkpoint = DeploymentRecoveryStorage.loadCheckpoint();
            if (checkpoint) {
              checkpoint.step = 'contract_submitted';
              checkpoint.transactionHash = serviceResult.transactionHash;
              checkpoint.feePaidXlm = String(feeBreakdown.totalFee);
              DeploymentRecoveryStorage.saveCheckpoint(checkpoint);
            }

            // Start progressive confirmation polling
            startPolling(serviceResult.transactionHash, network);
            
            try {
                analytics.track(AnalyticsEvent.TOKEN_DEPLOYED, {
                    network,
                    name_length: params.name ? params.name.length : 0,
                    symbol: params.symbol || '',
                    decimals: params.decimals || 0,
                });
            } catch {}
            
            // Save optimistic record to local storage
            // Backend sync will happen via useTransactionHistory
            saveDeploymentRecord(params, result, metadataUri);
            
            setStatus('success');
            trackTokenDeployed(params.symbol, network);
            
            // Clear checkpoint on final success
            DeploymentRecoveryStorage.clearCheckpoint();
            
            return result;
        } catch (deployError) {
            ErrorHandler.handle(deployError instanceof Error ? deployError : new Error(getErrorMessage(deployError)), {
                action: 'deploy-token',
                feature: 'token-deploy',
                metadata: {
                    name: params.name,
                    symbol: params.symbol,
                    hasMetadata: Boolean(metadataUri),
                },
            });
            const appError = mapDeploymentError(deployError);
            try {
                analytics.track(AnalyticsEvent.TOKEN_DEPLOY_FAILED, {
                    network,
                    errorCode: appError.code,
                });
            } catch {}
            setError(appError);
            setStatus('error');
            trackTokenDeployFailed(appError.message, network);
            throw appError;
        }
    };

    const reset = () => {
        stopPolling();
        setStatus('idle');
        setError(null);
        setRetryCount(0);
        setLastParams(null);
        setConfirmationStep(null);
        setConfirmations(null);
    };

    const retry = async (): Promise<DeploymentResult | null> => {
        if (!lastParams) {
            const appError = createError(ErrorCode.INVALID_INPUT, 'No previous deployment to retry');
            setError(appError);
            return null;
        }

        if (retryCount >= maxRetries) {
            const appError = createError(
                ErrorCode.TRANSACTION_FAILED,
                `Maximum retry attempts (${maxRetries}) reached`
            );
            setError(appError);
            return null;
        }

        setRetryCount(prev => prev + 1);
        
        // Add delay before retry
        if (retryDelay > 0) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
        
        return deploy(lastParams);
    };

    return {
        deploy,
        retry,
        reset,
        status,
        statusMessage: STATUS_MESSAGES[status],
        isDeploying: status === 'uploading' || status === 'deploying',
        error,
        retryCount,
        canRetry: retryCount < maxRetries && lastParams !== null && status === 'error',
        feeBumpAvailable,
        confirmationStep,
        confirmations,
    };
}

/**
 * Save deployment record to local storage (optimistic update)
 * Backend sync will reconcile this later
 */
function saveDeploymentRecord(
    params: TokenDeployParams,
    result: DeploymentResult,
    metadataUri?: string
): void {
    const token: TokenInfo = {
        address: result.tokenAddress,
        name: params.name,
        symbol: params.symbol,
        decimals: params.decimals,
        totalSupply: params.initialSupply,
        creator: params.adminWallet,
        metadataUri,
        deployedAt: result.timestamp,
        transactionHash: result.transactionHash,
    };

    try {
        TransactionHistoryStorage.getInstance().addToken(params.adminWallet, token);
    } catch {
        // Storage quota exceeded — non-fatal, deployment already succeeded
    }
    // Use the new TransactionHistoryStorage service
    transactionHistoryStorage.addToken(params.adminWallet, token);
}

function mapDeploymentError(error: unknown): AppError {
    const message = getErrorMessage(error);
    const normalizedMessage = message.toLowerCase();

    if (normalizedMessage.includes('wallet') || normalizedMessage.includes('sign')) {
        return createError(ErrorCode.WALLET_REJECTED, message);
    }

    if (normalizedMessage.includes('network')) {
        return createError(ErrorCode.NETWORK_ERROR, message);
    }

    if (normalizedMessage.includes('simulate') || normalizedMessage.includes('transaction')) {
        return createError(ErrorCode.TRANSACTION_FAILED, message);
    }

    return createError(ErrorCode.TRANSACTION_FAILED, message);
}
