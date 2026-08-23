import { useId } from 'react';
import {
  LIMITS,
  formatCpu,
  formatMegabytes,
  type Blueprint,
  type ResourceLimits,
} from '@platter/shared';
import { Slider, SliderLabel } from '@/components/ui/slider';
import { cn } from '@/lib/utils';

/**
 * Memory, disk and CPU for a new server.
 *
 * Every bound here is real. The floor is the blueprint's own declared minimum — the API
 * refuses anything under it — and the ceiling is what the node actually has left, so the form
 * cannot offer an allocation that will be rejected on submit. Each control says what remains
 * on the node after the current choice, because "how much can I still give the next server" is
 * the question an operator is really answering.
 */

/** What the node has spare. `null` when the caller could not read it — members cannot. */
export interface ResourceCapacity {
  nodeName: string;
  memoryFreeMb: number;
  diskFreeMb: number;
  cpuCores: number;
}

/** The three figures this form owns. Swap, IO weight and the rest keep their API defaults. */
export type ResourceValue = Pick<ResourceLimits, 'memoryMb' | 'diskMb' | 'cpuCores'>;

export interface ResourceErrors {
  memoryMb?: string | undefined;
  diskMb?: string | undefined;
  cpuCores?: string | undefined;
}

const MEMORY_STEP_MB = 256;
const DISK_STEP_MB = 1024;
const CPU_STEP_CORES = 0.5;

/** A sensible ceiling when nothing tells us what the node has: eight times the recommendation. */
const MEMORY_HEADROOM_FACTOR = 8;
const DISK_HEADROOM_FACTOR = 8;
const CPU_FALLBACK_CORES = 8;

function floorTo(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function ceilTo(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

export interface Bound {
  min: number;
  max: number;
  step: number;
}

export interface ResourceBounds {
  memory: Bound;
  disk: Bound;
  cpu: Bound;
}

/**
 * The slider ranges. Exported so the page can clamp its state with exactly the same arithmetic
 * the controls use — two different clamps is how a form ends up submitting an out-of-range
 * value it never displayed.
 */
export function resourceBounds(
  blueprint: Pick<Blueprint, 'minMemoryMb' | 'recommendedMemoryMb' | 'minDiskMb'>,
  capacity: ResourceCapacity | null,
): ResourceBounds {
  const memoryMin = ceilTo(blueprint.minMemoryMb, MEMORY_STEP_MB);
  const memoryCeiling =
    capacity !== null
      ? capacity.memoryFreeMb
      : Math.min(blueprint.recommendedMemoryMb * MEMORY_HEADROOM_FACTOR, LIMITS.maxMemoryMb);

  const diskMin = ceilTo(blueprint.minDiskMb, DISK_STEP_MB);
  const diskCeiling =
    capacity !== null
      ? capacity.diskFreeMb
      : Math.min(blueprint.minDiskMb * DISK_HEADROOM_FACTOR, LIMITS.maxDiskMb);

  const cpuCeiling = capacity !== null ? capacity.cpuCores : CPU_FALLBACK_CORES;

  return {
    memory: {
      min: memoryMin,
      max: Math.max(
        memoryMin,
        floorTo(Math.min(memoryCeiling, LIMITS.maxMemoryMb), MEMORY_STEP_MB),
      ),
      step: MEMORY_STEP_MB,
    },
    disk: {
      min: diskMin,
      max: Math.max(diskMin, floorTo(Math.min(diskCeiling, LIMITS.maxDiskMb), DISK_STEP_MB)),
      step: DISK_STEP_MB,
    },
    cpu: {
      min: LIMITS.minCpuCores,
      max: Math.max(
        CPU_STEP_CORES,
        ceilTo(Math.min(cpuCeiling, LIMITS.maxCpuCores), CPU_STEP_CORES),
      ),
      step: CPU_STEP_CORES,
    },
  };
}

export function clampResources(value: ResourceValue, bounds: ResourceBounds): ResourceValue {
  return {
    memoryMb: Math.min(Math.max(value.memoryMb, bounds.memory.min), bounds.memory.max),
    diskMb: Math.min(Math.max(value.diskMb, bounds.disk.min), bounds.disk.max),
    cpuCores: Math.min(Math.max(value.cpuCores, bounds.cpu.min), bounds.cpu.max),
  };
}

/**
 * The blueprint's own recommendation, which is what the API would pick anyway. Disk has no
 * "recommended" figure — the blueprint declares only what the game needs.
 */
export function defaultResources(
  blueprint: Pick<Blueprint, 'minMemoryMb' | 'recommendedMemoryMb' | 'minDiskMb'>,
  capacity: ResourceCapacity | null,
): ResourceValue {
  const bounds = resourceBounds(blueprint, capacity);
  return clampResources(
    {
      memoryMb: blueprint.recommendedMemoryMb,
      diskMb: blueprint.minDiskMb,
      // 0 is "no quota". Capping CPU on a box with spare cores only makes the game stutter.
      cpuCores: 0,
    },
    bounds,
  );
}

interface ResourceSliderProps {
  label: string;
  /** Formatted for a human — `4 GB`, `2 cores`, `Unlimited`. Never a raw number. */
  display: string;
  bound: Bound;
  value: number;
  onChange: (value: number) => void;
  /** What the range means at each end, in the same units as `display`. */
  minLabel: string;
  maxLabel: string;
  help: string;
  remaining?: string | undefined;
  error?: string | undefined;
  /** The node cannot fit even the minimum, so there is nothing to drag. */
  frozen?: boolean;
}

function ResourceSlider({
  label,
  display,
  bound,
  value,
  onChange,
  minLabel,
  maxLabel,
  help,
  remaining,
  error,
  frozen = false,
}: ResourceSliderProps) {
  const helpId = useId();
  const errorId = useId();

  return (
    <div className="flex flex-col gap-2">
      <Slider
        aria-describedby={error ? `${helpId} ${errorId}` : helpId}
        className="gap-2"
        disabled={frozen}
        getAriaValueText={() => display}
        invalid={Boolean(error)}
        max={bound.max}
        min={bound.min}
        onValueChange={({ value: next }) => {
          const first = next[0];
          if (first !== undefined) onChange(first);
        }}
        step={bound.step}
        value={[value]}
      >
        <div className="flex items-baseline justify-between gap-3">
          <SliderLabel className="text-subhead font-medium text-label">{label}</SliderLabel>
          {/* `output` is the semantic element for a value derived from a control. */}
          <output className="tabular font-mono text-subhead font-medium text-label">
            {display}
          </output>
        </div>
      </Slider>

      <div className="tabular flex items-center justify-between gap-3 font-mono text-caption text-label-secondary">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>

      <p className="text-caption text-label-secondary" id={helpId}>
        {help}
        {remaining ? <> {remaining}</> : null}
      </p>

      {error ? (
        <p className="text-caption text-danger" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export interface ResourceFieldsProps {
  blueprint: Pick<Blueprint, 'name' | 'minMemoryMb' | 'recommendedMemoryMb' | 'minDiskMb'>;
  value: ResourceValue;
  onChange: (value: ResourceValue) => void;
  /** `null` when the node's figures are not readable by this account. */
  capacity: ResourceCapacity | null;
  errors?: ResourceErrors | undefined;
  className?: string;
}

export function ResourceFields({
  blueprint,
  value,
  onChange,
  capacity,
  errors,
  className,
}: ResourceFieldsProps) {
  const bounds = resourceBounds(blueprint, capacity);

  const memoryFrozen = bounds.memory.max <= bounds.memory.min;
  const diskFrozen = bounds.disk.max <= bounds.disk.min;

  function remainingText(freeMb: number | undefined, chosenMb: number): string | undefined {
    if (capacity === null || freeMb === undefined) return undefined;
    const left = Math.max(0, freeMb - chosenMb);
    return `${formatMegabytes(left)} would be left on ${capacity.nodeName}.`;
  }

  return (
    <div className={cn('flex flex-col gap-8', className)}>
      <ResourceSlider
        bound={bounds.memory}
        display={formatMegabytes(value.memoryMb)}
        error={errors?.memoryMb}
        frozen={memoryFrozen}
        help={`${blueprint.name} needs at least ${formatMegabytes(blueprint.minMemoryMb)} and runs comfortably on ${formatMegabytes(blueprint.recommendedMemoryMb)}.`}
        label="Memory"
        maxLabel={formatMegabytes(bounds.memory.max)}
        minLabel={formatMegabytes(bounds.memory.min)}
        onChange={(memoryMb) => onChange({ ...value, memoryMb })}
        remaining={remainingText(capacity?.memoryFreeMb, value.memoryMb)}
        value={value.memoryMb}
      />

      <ResourceSlider
        bound={bounds.disk}
        display={formatMegabytes(value.diskMb)}
        error={errors?.diskMb}
        frozen={diskFrozen}
        help={`World data, mods and backups all live in this space. ${blueprint.name} needs at least ${formatMegabytes(blueprint.minDiskMb)}.`}
        label="Disk"
        maxLabel={formatMegabytes(bounds.disk.max)}
        minLabel={formatMegabytes(bounds.disk.min)}
        onChange={(diskMb) => onChange({ ...value, diskMb })}
        remaining={remainingText(capacity?.diskFreeMb, value.diskMb)}
        value={value.diskMb}
      />

      <ResourceSlider
        bound={bounds.cpu}
        display={formatCpu(value.cpuCores)}
        error={errors?.cpuCores}
        help="A quota, not a reservation. Unlimited lets the server use whatever the machine has spare."
        label="CPU"
        maxLabel={formatCpu(bounds.cpu.max)}
        minLabel="Unlimited"
        onChange={(cpuCores) => onChange({ ...value, cpuCores })}
        value={value.cpuCores}
      />

      {capacity === null ? (
        <p className="text-caption text-label-tertiary">
          Platter places this server on a node with room for it. Only administrators can see how
          much each node has left, so these ranges are the blueprint’s, not the node’s.
        </p>
      ) : null}

      {memoryFrozen || diskFrozen ? (
        <p
          className="rounded-sm border border-warning/25 bg-warning-subtle px-3 py-2 text-subhead text-warning"
          role="alert"
        >
          {capacity?.nodeName ?? 'This node'} has only enough room for the minimum this game needs.
          Free space by deleting a server, or lower another server’s limits, before creating this
          one.
        </p>
      ) : null}
    </div>
  );
}
