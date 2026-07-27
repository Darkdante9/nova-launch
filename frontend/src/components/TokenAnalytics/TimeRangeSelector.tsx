import React, { useEffect, useState } from 'react';
import { Input } from '../UI/Input';
import { Button } from '../UI/Button';

export type TimeRangePreset = '24h' | '7d' | '30d' | '90d' | 'all-time' | 'custom';

export interface TimeRange {
  preset: TimeRangePreset;
  startDate?: string; // ISO date YYYY-MM-DD
  endDate?: string;   // ISO date YYYY-MM-DD
}

interface TimeRangeSelectorProps {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
  className?: string;
}

const PRESETS: Array<{ label: string; value: TimeRangePreset }> = [
  { label: 'Last 24h', value: '24h' },
  { label: 'Last 7d', value: '7d' },
  { label: 'Last 30d', value: '30d' },
  { label: 'Last 90d', value: '90d' },
  { label: 'All Time', value: 'all-time' },
];

function getDateRangeFromPreset(preset: TimeRangePreset): { start?: Date; end?: Date } {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const end = new Date(today);

  switch (preset) {
    case '24h': {
      const start = new Date(end);
      start.setDate(start.getDate() - 1);
      return { start, end };
    }
    case '7d': {
      const start = new Date(end);
      start.setDate(start.getDate() - 7);
      return { start, end };
    }
    case '30d': {
      const start = new Date(end);
      start.setDate(start.getDate() - 30);
      return { start, end };
    }
    case '90d': {
      const start = new Date(end);
      start.setDate(start.getDate() - 90);
      return { start, end };
    }
    case 'all-time':
      return { end };
    case 'custom':
      return {};
  }
}

function dateToString(date: Date): string {
  return date.toISOString().split('T')[0];
}

export function TimeRangeSelector({ value, onChange, className = '' }: TimeRangeSelectorProps) {
  const [showCustom, setShowCustom] = useState(value.preset === 'custom');
  const [customStart, setCustomStart] = useState(value.startDate || dateToString(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
  const [customEnd, setCustomEnd] = useState(value.endDate || dateToString(new Date()));

  const handlePresetClick = (preset: TimeRangePreset) => {
    setShowCustom(false);
    onChange({ preset });
  };

  const handleCustomApply = () => {
    if (customStart && customEnd) {
      if (new Date(customStart) > new Date(customEnd)) {
        alert('Start date must be before end date');
        return;
      }
      onChange({
        preset: 'custom',
        startDate: customStart,
        endDate: customEnd,
      });
      setShowCustom(false);
    }
  };

  const isPresetActive = (preset: TimeRangePreset) => value.preset === preset;

  return (
    <div className={`space-y-4 p-4 bg-gray-50 rounded-lg border border-gray-200 ${className}`}>
      <div>
        <p className="text-sm font-medium text-gray-700 mb-2">Time Range</p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((preset) => (
            <Button
              key={preset.value}
              size="sm"
              variant={isPresetActive(preset.value) ? 'primary' : 'outline'}
              onClick={() => handlePresetClick(preset.value)}
              className="text-xs"
            >
              {preset.label}
            </Button>
          ))}
          <Button
            size="sm"
            variant={value.preset === 'custom' ? 'primary' : 'outline'}
            onClick={() => setShowCustom(!showCustom)}
            className="text-xs"
          >
            Custom
          </Button>
        </div>
      </div>

      {showCustom && (
        <div className="pt-2 border-t border-gray-200 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Input
              type="date"
              label="Start Date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              max={customEnd}
            />
            <Input
              type="date"
              label="End Date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              min={customStart}
              max={dateToString(new Date())}
            />
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={handleCustomApply}>
              Apply
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowCustom(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {value.preset !== 'custom' && (
        <p className="text-xs text-gray-500">
          {value.preset === 'all-time'
            ? 'Showing all available data'
            : `Preset: ${PRESETS.find((p) => p.value === value.preset)?.label}`}
        </p>
      )}
    </div>
  );
}
