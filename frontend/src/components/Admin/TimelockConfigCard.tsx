/**
 * TimelockConfigCard
 * Displays timelock configuration and any pending scheduled change.
 * Supports editing minDelay/maxDelay via backend API.
 */
import React, { useEffect, useState } from 'react';
import type { TimelockConfig, PendingChange } from '../../types/admin';

interface Props {
  config: TimelockConfig;
  pendingChange: PendingChange | null;
  onSave?: (config: { minDelay: number; maxDelay: number }) => Promise<void>;
}

function formatDelay(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function PendingChangeRow({ change }: { change: PendingChange }) {
  const now = Math.floor(Date.now() / 1000);
  const ready = now >= change.executeAfter;
  const eta = change.executeAfter - now;

  return (
    <div
      className={`rounded-md border px-4 py-3 ${
        ready
          ? 'bg-red-50 border-red-300'
          : 'bg-yellow-50 border-yellow-300'
      }`}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold text-gray-800">
          {change.changeType}
        </span>
        {ready ? (
          <span className="text-xs font-medium bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
            🔴 Executable now
          </span>
        ) : (
          <span className="text-xs font-medium bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full">
            ⏳ Ready in {formatDelay(eta)}
          </span>
        )}
      </div>
      {change.description && (
        <p className="text-xs text-gray-600">{change.description}</p>
      )}
      <p className="text-xs text-gray-400 mt-1">
        Execute after:{' '}
        {new Date(change.executeAfter * 1000).toLocaleString()}
      </p>
      {ready && (
        <p className="text-xs text-red-700 font-medium mt-2">
          ⚠️ This change is ready to execute. Only the admin can trigger execution.
        </p>
      )}
    </div>
  );
}

export function TimelockConfigCard({ config, pendingChange, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [minDelay, setMinDelay] = useState(config.minDelay);
  const [maxDelay, setMaxDelay] = useState(config.maxDelay);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Fetch current config from backend on mount
  useEffect(() => {
    fetch('/api/admin/governance/timelock', {
      headers: { Authorization: `Bearer ${localStorage.getItem('adminToken') ?? ''}` },
    })
      .then((r) => r.ok ? r.json() : null)
      .then((body) => {
        if (body?.data) {
          setMinDelay(body.data.minDelay);
          setMaxDelay(body.data.maxDelay);
        }
      })
      .catch(() => { /* fallback to prop values */ });
  }, []);

  const handleSave = async () => {
    const prev = { minDelay: config.minDelay, maxDelay: config.maxDelay };
    setSaving(true);
    setSaveError(null);
    // Optimistic update — values already in state
    try {
      const res = await fetch('/api/admin/governance/timelock', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('adminToken') ?? ''}`,
        },
        body: JSON.stringify({ minDelay, maxDelay }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      await onSave?.({ minDelay, maxDelay });
      setEditing(false);
    } catch (err) {
      // Rollback
      setMinDelay(prev.minDelay);
      setMaxDelay(prev.maxDelay);
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white rounded-lg shadow-md border border-gray-200">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
        <span className="text-lg">⏱️</span>
        <h3 className="text-lg font-semibold text-gray-900">Timelock</h3>
        {editing ? (
          <span className="ml-auto text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium">
            Editing
          </span>
        ) : (
          <span className="ml-auto text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
            Read-only
          </span>
        )}
      </div>

      <div className="p-6 space-y-5">
        {/* Delay range */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Min Delay</p>
            {editing ? (
              <input
                type="number"
                min={0}
                value={minDelay}
                onChange={(e) => setMinDelay(Number(e.target.value))}
                className="mt-0.5 w-full border border-gray-300 rounded px-2 py-1 text-sm font-mono"
                aria-label="Min delay in seconds"
              />
            ) : (
              <p className="text-xl font-mono font-semibold text-gray-900 mt-0.5">
                {formatDelay(minDelay)}
              </p>
            )}
          </div>
          <div>
            <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Max Delay</p>
            {editing ? (
              <input
                type="number"
                min={0}
                value={maxDelay}
                onChange={(e) => setMaxDelay(Number(e.target.value))}
                className="mt-0.5 w-full border border-gray-300 rounded px-2 py-1 text-sm font-mono"
                aria-label="Max delay in seconds"
              />
            ) : (
              <p className="text-xl font-mono font-semibold text-gray-900 mt-0.5">
                {formatDelay(maxDelay)}
              </p>
            )}
          </div>
        </div>

        {saveError && (
          <p className="text-xs text-red-600" role="alert">{saveError}</p>
        )}

        {/* Edit/Save controls */}
        <div className="flex gap-2">
          {editing ? (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                className="text-xs px-3 py-1.5 rounded border border-blue-400 text-blue-700 bg-blue-50 hover:bg-blue-100 font-medium disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={() => { setEditing(false); setSaveError(null); setMinDelay(config.minDelay); setMaxDelay(config.maxDelay); }}
                disabled={saving}
                className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 font-medium disabled:opacity-50"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setEditing(true)}
              className="text-xs px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 font-medium"
            >
              Edit
            </button>
          )}
        </div>

        {/* Pending change */}
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            Pending Change
          </p>
          {pendingChange ? (
            <PendingChangeRow change={pendingChange} />
          ) : (
            <p className="text-sm text-gray-400 italic">No pending changes</p>
          )}
        </div>

        {/* Privileged action notice */}
        <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 flex gap-2 items-start">
          <span className="text-amber-500 mt-0.5">⚠️</span>
          <p className="text-xs text-amber-800">
            Scheduling, executing, and cancelling changes are privileged operations requiring
            explicit admin confirmation.
          </p>
        </div>
      </div>
    </div>
  );
}
