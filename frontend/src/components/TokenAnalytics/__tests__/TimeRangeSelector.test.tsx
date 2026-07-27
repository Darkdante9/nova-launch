import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { TimeRangeSelector, type TimeRange } from '../TimeRangeSelector';

describe('TimeRangeSelector', () => {
  it('should render preset buttons', () => {
    const handleChange = vi.fn();
    render(
      <TimeRangeSelector
        value={{ preset: '7d' }}
        onChange={handleChange}
      />
    );

    expect(screen.getByText('Last 24h')).toBeInTheDocument();
    expect(screen.getByText('Last 7d')).toBeInTheDocument();
    expect(screen.getByText('Last 30d')).toBeInTheDocument();
    expect(screen.getByText('Last 90d')).toBeInTheDocument();
    expect(screen.getByText('All Time')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  it('should highlight active preset', () => {
    const handleChange = vi.fn();
    render(
      <TimeRangeSelector
        value={{ preset: '30d' }}
        onChange={handleChange}
      />
    );

    const button30d = screen.getByText('Last 30d').closest('button');
    expect(button30d).toHaveClass('bg-blue-600');
  });

  it('should call onChange when preset is clicked', async () => {
    const handleChange = vi.fn();
    const user = userEvent.setup();

    render(
      <TimeRangeSelector
        value={{ preset: '7d' }}
        onChange={handleChange}
      />
    );

    await user.click(screen.getByText('Last 90d'));
    expect(handleChange).toHaveBeenCalledWith({ preset: '90d' });
  });

  it('should show custom date inputs when Custom is clicked', async () => {
    const handleChange = vi.fn();
    const user = userEvent.setup();

    render(
      <TimeRangeSelector
        value={{ preset: '7d' }}
        onChange={handleChange}
      />
    );

    await user.click(screen.getByText('Custom'));
    await waitFor(() => {
      expect(screen.getByLabelText('Start Date')).toBeInTheDocument();
      expect(screen.getByLabelText('End Date')).toBeInTheDocument();
    });
  });

  it('should allow custom date selection', async () => {
    const handleChange = vi.fn();
    const user = userEvent.setup();

    render(
      <TimeRangeSelector
        value={{ preset: '7d' }}
        onChange={handleChange}
      />
    );

    await user.click(screen.getByText('Custom'));

    const startInput = screen.getByLabelText('Start Date') as HTMLInputElement;
    const endInput = screen.getByLabelText('End Date') as HTMLInputElement;

    await user.clear(startInput);
    await user.type(startInput, '2024-01-01');

    await user.clear(endInput);
    await user.type(endInput, '2024-01-31');

    await user.click(screen.getByText('Apply'));

    expect(handleChange).toHaveBeenCalledWith({
      preset: 'custom',
      startDate: '2024-01-01',
      endDate: '2024-01-31',
    });
  });

  it('should validate that start date is before end date', async () => {
    const handleChange = vi.fn();
    const user = userEvent.setup();
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});

    render(
      <TimeRangeSelector
        value={{ preset: '7d' }}
        onChange={handleChange}
      />
    );

    await user.click(screen.getByText('Custom'));

    const startInput = screen.getByLabelText('Start Date') as HTMLInputElement;
    const endInput = screen.getByLabelText('End Date') as HTMLInputElement;

    await user.clear(startInput);
    await user.type(startInput, '2024-01-31');

    await user.clear(endInput);
    await user.type(endInput, '2024-01-01');

    await user.click(screen.getByText('Apply'));

    expect(alertSpy).toHaveBeenCalledWith('Start date must be before end date');
    expect(handleChange).not.toHaveBeenCalled();

    alertSpy.mockRestore();
  });

  it('should cancel custom date selection', async () => {
    const handleChange = vi.fn();
    const user = userEvent.setup();

    render(
      <TimeRangeSelector
        value={{ preset: '7d' }}
        onChange={handleChange}
      />
    );

    await user.click(screen.getByText('Custom'));
    await user.click(screen.getByText('Cancel'));

    expect(handleChange).not.toHaveBeenCalled();
  });

  it('should display preset label when not in custom mode', () => {
    const handleChange = vi.fn();

    render(
      <TimeRangeSelector
        value={{ preset: '30d' }}
        onChange={handleChange}
      />
    );

    expect(screen.getByText('Preset: Last 30d')).toBeInTheDocument();
  });

  it('should handle all-time preset', async () => {
    const handleChange = vi.fn();
    const user = userEvent.setup();

    render(
      <TimeRangeSelector
        value={{ preset: '7d' }}
        onChange={handleChange}
      />
    );

    await user.click(screen.getByText('All Time'));

    expect(handleChange).toHaveBeenCalledWith({ preset: 'all-time' });
  });

  it('should restore custom values when switching back to custom', async () => {
    const handleChange = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(
      <TimeRangeSelector
        value={{ preset: 'custom', startDate: '2024-01-01', endDate: '2024-01-31' }}
        onChange={handleChange}
      />
    );

    await user.click(screen.getByText('Custom'));

    const startInput = screen.getByLabelText('Start Date') as HTMLInputElement;
    expect(startInput.value).toBe('2024-01-01');
  });
});
