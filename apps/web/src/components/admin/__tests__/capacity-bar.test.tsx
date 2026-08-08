import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CapacityBar, capacityLevel } from '@/components/admin/capacity-bar';

/**
 * Used, allocated and free are three different numbers, and the failure mode this bar exists
 * to prevent is an admin reading one of them as another — the tests below check the figures
 * independently of the bar's shape, since a screen reader (and a reviewer skimming text) never
 * sees the shape at all.
 */

const mb = (value: number) => `${value} MB`;

describe('capacityLevel', () => {
  it('escalates at the thresholds it is given', () => {
    expect(capacityLevel(0.4, 0.8, 0.95)).toBe('normal');
    expect(capacityLevel(0.85, 0.8, 0.95)).toBe('warning');
    expect(capacityLevel(0.99, 0.8, 0.95)).toBe('critical');
  });

  it('treats the threshold itself as already past it', () => {
    expect(capacityLevel(0.8, 0.8, 0.95)).toBe('warning');
    expect(capacityLevel(0.95, 0.8, 0.95)).toBe('critical');
  });
});

describe('CapacityBar', () => {
  it('is a meter, and reads out used, allocated and free as one accessible string', () => {
    render(
      <CapacityBar allocated={3072} format={mb} label="Memory" total={8192} used={2048} />,
    );

    const meter = screen.getByRole('meter', { name: 'Memory' });
    expect(meter).toHaveAttribute('aria-valuenow', '3072');
    expect(meter).toHaveAttribute('aria-valuemax', '8192');
    expect(meter).toHaveAttribute(
      'aria-valuetext',
      '2048 MB used, 3072 MB allocated, 5120 MB free of 8192 MB — 38% allocated',
    );
  });

  it('prints all three figures as text, never only as a bar', () => {
    render(<CapacityBar allocated={3072} format={mb} label="Memory" total={8192} used={2048} />);

    expect(screen.getByText(/2048 MB used/)).toBeInTheDocument();
    expect(screen.getByText(/3072 MB allocated/)).toBeInTheDocument();
    expect(screen.getByText(/5120 MB free/)).toBeInTheDocument();
  });

  it('names each segment in a legend, not only by colour', () => {
    render(<CapacityBar allocated={3072} format={mb} label="Memory" total={8192} used={2048} />);

    expect(screen.getByText('Used')).toBeInTheDocument();
    expect(screen.getByText('Allocated')).toBeInTheDocument();
    expect(screen.getByText('Free')).toBeInTheDocument();
  });

  it('warns in words at the warning threshold, not only in colour', () => {
    render(
      <CapacityBar
        allocated={6600}
        criticalAt={0.95}
        format={mb}
        label="Memory"
        total={8192}
        used={6000}
        warnAt={0.8}
      />,
    );

    expect(screen.getByText(/filling up/i)).toBeInTheDocument();
  });

  it('says full at the critical threshold, not only in colour', () => {
    render(
      <CapacityBar allocated={7900} format={mb} label="Memory" total={8192} used={7800} />,
    );

    expect(screen.getByText(/^full/i)).toBeInTheDocument();
  });

  it('clamps a stale reading where used would otherwise outrun allocated', () => {
    render(<CapacityBar allocated={1000} format={mb} label="Disk" total={4000} used={2000} />);

    const meter = screen.getByRole('meter', { name: 'Disk' });
    // Allocated cannot legitimately be less than used, so the display floors allocated at
    // used rather than drawing a bar where "used" overshoots the paler "allocated" layer.
    expect(meter).toHaveAttribute('aria-valuenow', '2000');
    expect(screen.getByText(/2000 MB allocated/)).toBeInTheDocument();
  });

  it('refuses to draw a bar against a total that was never detected', () => {
    render(<CapacityBar allocated={0} format={mb} label="Disk" total={0} used={0} />);

    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByText(/not detected a capacity figure/i)).toBeInTheDocument();
  });

  it('shows the reason instead of a bar when the figure is unavailable', () => {
    render(
      <CapacityBar
        allocated={0}
        format={mb}
        label="Ports"
        total={0}
        unavailable="Only administrators can see this node's port range."
        used={0}
      />,
    );

    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByText(/only administrators can see/i)).toBeInTheDocument();
  });

  it('keeps its loading shape without rendering a meter', () => {
    render(<CapacityBar allocated={0} format={mb} isLoading label="Memory" total={0} used={0} />);

    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });
});
