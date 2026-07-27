import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { GranularityToggle } from '../GranularityToggle';

describe('GranularityToggle', () => {
  it('should render all granularity options', () => {
    const handleChange = vi.fn();
    render(
      <GranularityToggle
        value="daily"
        onChange={handleChange}
      />
    );

    expect(screen.getByText('Hourly')).toBeInTheDocument();
    expect(screen.getByText('Daily')).toBeInTheDocument();
    expect(screen.getByText('Weekly')).toBeInTheDocument();
  });

  it('should highlight active granularity', () => {
    const handleChange = vi.fn();
    render(
      <GranularityToggle
        value="daily"
        onChange={handleChange}
      />
    );

    const dailyButton = screen.getByText('Daily').closest('button');
    expect(dailyButton).toHaveClass('bg-blue-600');
  });

  it('should call onChange when granularity is clicked', async () => {
    const handleChange = vi.fn();
    const user = userEvent.setup();

    render(
      <GranularityToggle
        value="daily"
        onChange={handleChange}
      />
    );

    await user.click(screen.getByText('Weekly'));
    expect(handleChange).toHaveBeenCalledWith('weekly');
  });

  it('should switch between hourly and daily', async () => {
    const handleChange = vi.fn();
    const user = userEvent.setup();

    render(
      <GranularityToggle
        value="hourly"
        onChange={handleChange}
      />
    );

    const hourlyButton = screen.getByText('Hourly').closest('button');
    expect(hourlyButton).toHaveClass('bg-blue-600');

    await user.click(screen.getByText('Daily'));
    expect(handleChange).toHaveBeenCalledWith('daily');
  });

  it('should switch between daily and weekly', async () => {
    const handleChange = vi.fn();
    const user = userEvent.setup();

    render(
      <GranularityToggle
        value="daily"
        onChange={handleChange}
      />
    );

    const dailyButton = screen.getByText('Daily').closest('button');
    expect(dailyButton).toHaveClass('bg-blue-600');

    await user.click(screen.getByText('Weekly'));
    expect(handleChange).toHaveBeenCalledWith('weekly');
  });

  it('should switch between weekly and hourly', async () => {
    const handleChange = vi.fn();
    const user = userEvent.setup();

    render(
      <GranularityToggle
        value="weekly"
        onChange={handleChange}
      />
    );

    const weeklyButton = screen.getByText('Weekly').closest('button');
    expect(weeklyButton).toHaveClass('bg-blue-600');

    await user.click(screen.getByText('Hourly'));
    expect(handleChange).toHaveBeenCalledWith('hourly');
  });

  it('should apply custom className', () => {
    const handleChange = vi.fn();
    const { container } = render(
      <GranularityToggle
        value="daily"
        onChange={handleChange}
        className="custom-class"
      />
    );

    const wrapper = container.querySelector('.custom-class');
    expect(wrapper).toBeInTheDocument();
  });

  it('should maintain selection across re-renders', () => {
    const handleChange = vi.fn();
    const { rerender } = render(
      <GranularityToggle
        value="hourly"
        onChange={handleChange}
      />
    );

    let hourlyButton = screen.getByText('Hourly').closest('button');
    expect(hourlyButton).toHaveClass('bg-blue-600');

    rerender(
      <GranularityToggle
        value="hourly"
        onChange={handleChange}
      />
    );

    hourlyButton = screen.getByText('Hourly').closest('button');
    expect(hourlyButton).toHaveClass('bg-blue-600');
  });
});
