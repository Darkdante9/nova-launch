import React from 'react';
import { Button } from '../UI/Button';

export type Granularity = 'hourly' | 'daily' | 'weekly';

interface GranularityToggleProps {
  value: Granularity;
  onChange: (granularity: Granularity) => void;
  className?: string;
}

const OPTIONS: Array<{ label: string; value: Granularity }> = [
  { label: 'Hourly', value: 'hourly' },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
];

export function GranularityToggle({ value, onChange, className = '' }: GranularityToggleProps) {
  return (
    <div className={`p-4 bg-gray-50 rounded-lg border border-gray-200 ${className}`}>
      <p className="text-sm font-medium text-gray-700 mb-2">Granularity</p>
      <div className="flex gap-2">
        {OPTIONS.map((option) => (
          <Button
            key={option.value}
            size="sm"
            variant={value === option.value ? 'primary' : 'outline'}
            onClick={() => onChange(option.value)}
            className="text-xs"
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
