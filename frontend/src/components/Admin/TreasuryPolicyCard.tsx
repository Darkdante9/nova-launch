/**
 * TreasuryPolicyCard
 * Read-only display of treasury policy state with editable daily cap wired
 * to PUT /api/admin/treasury/policy.
 */
import React, { useEffect, useState } from 'react';
import type { TreasuryPolicy } from '../../types/admin';

interface Props {
  policy: TreasuryPolicy;
  onSave?: (policy: { dailyCap: string }) => Promise<void>;
}

function stroopsToXlm(stroops: bigint): string {
  return (Number(stroops) / 10_000_000).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 7,
  });
}

function CapacityBar({ used, total }: { used: bigint; total: bigint }) {
  const pct = total > 0n ? Math.min(100, Math.round(Number((used * 100n) / total))) : 0;
  const color = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-yellow-500' : 'bg-green-500';
  return (
    <div className="mt-1">
      <div className="flex justify-between text-xs text-gray-500 mb-1">
        <span>{stroopsToXlm(used)} XLM used</span>
        <span>{pct}%</span>
      </div>
      <div className="w-full bg-gray-200 rounded-full h-2">
        <div className={`${color} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function TreasuryPolicyCard({ policy, onSave }: Props) {
  const [editing, setEditing] = useState(false);
  const [dailyCap, setDailyCap] = useState(policy.dailyCap.toString());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Fetch current policy from backend on mount
  useEffect(() => {
    fetch('/api/admin/treasury/policy', {
      headers: { Authorization: `Bearer ${localStorage.getItem('adminToken') ?? ''}` },
    })
      .then((r) => r.ok ? r.json() : null)
      .then((body) => {
        if (body?.data?.dailyCap) setDailyCap(body.data.dailyCap);
      })
      .catch(() => { /* fallback to prop values */ });
  }, []);

  const handleSave = async () => {
    const prevCap = policy.dailyCap.toString();
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch('/api/admin/treasury/policy', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('adminToken') ?? ''}`,
        },
        body: JSON.stringify({ dailyCap }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      await onSave?.({ dailyCap });
      setEditing(false);
    } catch (err) {
      setDailyCap(prevCap);
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const displayCap = BigInt(dailyCap || '0');

  return (
    <div className="bg-white rounded-lg shadow-md border border-gray-200">
      <div className="px-6 py-4 border-b border-gray-200 flex items-center gap-2">
        <span className="text-lg">🏦</span>
        <h3 className="text-lg font-semibold text-gray-900">Treasury Policy</h3>
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
        {/* Daily cap */}
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Daily Cap</p>
          {editing ? (
            <input
              type="text"
              value={dailyCap}
              onChange={(e) => /^\d*$/.test(e.target.value) && setDailyCap(e.target.value)}
              className="mt-0.5 w-full border border-gray-300 rounded px-2 py-1 text-sm font-mono"
              aria-label="Daily cap in stroops"
              placeholder="Stroops (integer)"
            />
          ) : (
            <p className="text-xl font-mono font-semibold text-gray-900 mt-0.5">
              {stroopsToXlm(displayCap)} XLM
            </p>
          )}
        </div>

        {/* Usage bar */}
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Today's Usage
          </p>
          <CapacityBar used={policy.withdrawnToday} total={displayCap} />
          <p className="text-sm text-gray-600 mt-2">
            <span className="font-medium text-green-700">
              {stroopsToXlm(policy.remainingCapacity)} XLM
            </span>{' '}
            remaining today
          </p>
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
                onClick={() => { setEditing(false); setSaveError(null); setDailyCap(policy.dailyCap.toString()); }}
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

        {/* Allowlist */}
        <div>
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            Allowed Recipients ({policy.allowedRecipients.length})
          </p>
          {policy.allowedRecipients.length === 0 ? (
            <p className="text-sm text-gray-400 italic">No recipients allowlisted</p>
          ) : (
            <ul className="space-y-1 max-h-40 overflow-y-auto">
              {policy.allowedRecipients.map((addr) => (
                <li
                  key={addr}
                  className="text-xs font-mono bg-gray-50 border border-gray-200 rounded px-3 py-1.5 text-gray-700 truncate"
                  title={addr}
                >
                  {addr}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Privileged action notice */}
        <div className="rounded-md bg-amber-50 border border-amber-200 px-4 py-3 flex gap-2 items-start">
          <span className="text-amber-500 mt-0.5">⚠️</span>
          <p className="text-xs text-amber-800">
            Withdrawals and allowlist changes are privileged operations. They require admin
            authentication and are subject to the timelock delay.
          </p>
        </div>
      </div>
    </div>
  );
}
