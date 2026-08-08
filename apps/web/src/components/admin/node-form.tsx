import type React from 'react';
import { LIMITS, portSchema, type Node, type NodeDriver } from '@platter/shared';
import { Field, FieldError, FieldGroup, FieldHelper, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * The fields shared by "add a node" and "edit a node".
 *
 * Memory, disk and CPU are optional on purpose, matching `createNodeRequestSchema`: Platter
 * probes the driver (and, for a local socket, the filesystem) for whatever is left blank, and
 * only asks the operator to type a number it genuinely could not detect. A blank field is
 * therefore a real, different answer from a zero — it means "let Platter find out" — so this
 * form keeps the three of them as strings and only puts a number in the request when one was
 * actually typed.
 */

export interface NodeFormValue {
  name: string;
  description: string;
  driver: NodeDriver;
  endpoint: string;
  publicHost: string;
  portRangeStart: string;
  portRangeEnd: string;
  /** Blank means "detect automatically". */
  memoryTotalMb: string;
  diskTotalMb: string;
  cpuCores: string;
  overcommitRatio: string;
}

export function defaultNodeFormValue(): NodeFormValue {
  return {
    name: '',
    description: '',
    driver: 'docker',
    endpoint: '/var/run/docker.sock',
    publicHost: '127.0.0.1',
    portRangeStart: '25000',
    portRangeEnd: '25999',
    memoryTotalMb: '',
    diskTotalMb: '',
    cpuCores: '',
    overcommitRatio: '1',
  };
}

export function nodeFormValueFromNode(node: Node): NodeFormValue {
  return {
    name: node.name,
    description: node.description,
    driver: node.driver,
    endpoint: node.endpoint,
    publicHost: node.publicHost,
    portRangeStart: String(node.portRangeStart),
    portRangeEnd: String(node.portRangeEnd),
    memoryTotalMb: String(node.memoryTotalMb),
    diskTotalMb: String(node.diskTotalMb),
    cpuCores: String(node.cpuCores),
    overcommitRatio: String(node.overcommitRatio),
  };
}

/** `''` for an optional numeric field parses to `undefined` — the auto-detect request. */
function parseOptionalNumber(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : NaN;
}

export function validateNodeForm(value: NodeFormValue): Record<string, string> {
  const errors: Record<string, string> = {};

  if (value.name.trim().length === 0) errors.name = 'Name this node.';
  else if (value.name.trim().length > 64) errors.name = 'Keep it under 64 characters.';

  if (value.description.length > 300) errors.description = 'Keep it under 300 characters.';

  if (value.endpoint.trim().length === 0) {
    errors.endpoint = 'Enter a Docker socket path or a tcp:// URL.';
  }
  if (value.publicHost.trim().length === 0) {
    errors.publicHost = 'Enter the address players should connect to.';
  }

  const start = Number(value.portRangeStart);
  const end = Number(value.portRangeEnd);
  if (!portSchema.safeParse(start).success) {
    errors.portRangeStart = 'Enter a port between 1 and 65535.';
  }
  if (!portSchema.safeParse(end).success) {
    errors.portRangeEnd = 'Enter a port between 1 and 65535.';
  }
  if (!errors.portRangeStart && !errors.portRangeEnd && end < start) {
    errors.portRangeEnd = 'Must be at or above the start of the range.';
  }

  const memory = parseOptionalNumber(value.memoryTotalMb);
  if (memory !== undefined && (!Number.isFinite(memory) || memory < LIMITS.minMemoryMb)) {
    errors.memoryTotalMb = `Leave blank to auto-detect, or enter at least ${LIMITS.minMemoryMb} MB.`;
  }

  const disk = parseOptionalNumber(value.diskTotalMb);
  if (disk !== undefined && (!Number.isFinite(disk) || disk < LIMITS.minDiskMb)) {
    errors.diskTotalMb = `Leave blank to auto-detect, or enter at least ${LIMITS.minDiskMb} MB.`;
  }

  const cpu = parseOptionalNumber(value.cpuCores);
  if (cpu !== undefined && (!Number.isFinite(cpu) || cpu < 0.1)) {
    errors.cpuCores = 'Leave blank to auto-detect, or enter at least 0.1 cores.';
  }

  const overcommit = Number(value.overcommitRatio);
  if (!Number.isFinite(overcommit) || overcommit < 1 || overcommit > 10) {
    errors.overcommitRatio = 'Enter a number from 1 (no overcommit) to 10.';
  }

  return errors;
}

interface NodeCreatePayload {
  name: string;
  description: string;
  driver: NodeDriver;
  endpoint: string;
  publicHost: string;
  portRangeStart: number;
  portRangeEnd: number;
  overcommitRatio: number;
  memoryTotalMb?: number;
  diskTotalMb?: number;
  cpuCores?: number;
}

function toPayload(value: NodeFormValue): NodeCreatePayload {
  const payload: NodeCreatePayload = {
    name: value.name.trim(),
    description: value.description.trim(),
    driver: value.driver,
    endpoint: value.endpoint.trim(),
    publicHost: value.publicHost.trim(),
    portRangeStart: Number(value.portRangeStart),
    portRangeEnd: Number(value.portRangeEnd),
    overcommitRatio: Number(value.overcommitRatio),
  };
  const memory = parseOptionalNumber(value.memoryTotalMb);
  const disk = parseOptionalNumber(value.diskTotalMb);
  const cpu = parseOptionalNumber(value.cpuCores);
  if (memory !== undefined) payload.memoryTotalMb = memory;
  if (disk !== undefined) payload.diskTotalMb = disk;
  if (cpu !== undefined) payload.cpuCores = cpu;
  return payload;
}

export function buildCreateNodeRequest(value: NodeFormValue): NodeCreatePayload {
  return toPayload(value);
}

/** Only the fields that actually changed from the node's current, already-detected values. */
export function buildUpdateNodeRequest(
  value: NodeFormValue,
  original: Node,
): Partial<NodeCreatePayload> {
  const next = toPayload(value);
  const patch: Partial<NodeCreatePayload> = {};

  if (next.name !== original.name) patch.name = next.name;
  if (next.description !== original.description) patch.description = next.description;
  if (next.driver !== original.driver) patch.driver = next.driver;
  if (next.endpoint !== original.endpoint) patch.endpoint = next.endpoint;
  if (next.publicHost !== original.publicHost) patch.publicHost = next.publicHost;
  if (next.portRangeStart !== original.portRangeStart) patch.portRangeStart = next.portRangeStart;
  if (next.portRangeEnd !== original.portRangeEnd) patch.portRangeEnd = next.portRangeEnd;
  if (next.overcommitRatio !== original.overcommitRatio) {
    patch.overcommitRatio = next.overcommitRatio;
  }
  if (next.memoryTotalMb !== undefined && next.memoryTotalMb !== original.memoryTotalMb) {
    patch.memoryTotalMb = next.memoryTotalMb;
  }
  if (next.diskTotalMb !== undefined && next.diskTotalMb !== original.diskTotalMb) {
    patch.diskTotalMb = next.diskTotalMb;
  }
  if (next.cpuCores !== undefined && next.cpuCores !== original.cpuCores) {
    patch.cpuCores = next.cpuCores;
  }

  return patch;
}

const FIELD_HEIGHT = 'h-11';
const DRIVERS: ReadonlyArray<{ value: NodeDriver; label: string }> = [
  { value: 'docker', label: 'Docker' },
  { value: 'mock', label: 'Mock (for testing, without a real container runtime)' },
];

export interface NodeFormProps {
  value: NodeFormValue;
  onChange: (next: NodeFormValue) => void;
  fieldErrors?: Record<string, string>;
  formId?: string;
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
}

export function NodeForm({ value, onChange, fieldErrors, formId, onSubmit }: NodeFormProps) {
  const localErrors = validateNodeForm(value);
  const errors = { ...localErrors, ...fieldErrors };

  return (
    <form className="flex flex-col gap-5" id={formId} noValidate onSubmit={onSubmit}>
      <FieldGroup>
        <Field invalid={Boolean(errors.name)} required>
          <FieldLabel>Name</FieldLabel>
          <Input
            autoComplete="off"
            className={FIELD_HEIGHT}
            maxLength={64}
            name="name"
            onChange={(event) => onChange({ ...value, name: event.target.value })}
            placeholder="Main box"
            value={value.name}
          />
          <FieldError>{errors.name}</FieldError>
        </Field>

        <Field invalid={Boolean(errors.description)}>
          <FieldLabel>Description</FieldLabel>
          <Textarea
            maxLength={300}
            name="description"
            onChange={(event) => onChange({ ...value, description: event.target.value })}
            placeholder="Where this machine lives, or what it is for. Optional."
            rows={2}
            value={value.description}
          />
          <FieldError>{errors.description}</FieldError>
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field>
            <FieldLabel>Driver</FieldLabel>
            <NativeSelect
              className="w-full [&>select]:h-11"
              onChange={(event) => onChange({ ...value, driver: event.target.value as NodeDriver })}
              size="lg"
              value={value.driver}
            >
              {DRIVERS.map((driver) => (
                <NativeSelectOption key={driver.value} value={driver.value}>
                  {driver.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>

          <Field invalid={Boolean(errors.endpoint)} required>
            <FieldLabel>Docker endpoint</FieldLabel>
            <Input
              autoComplete="off"
              className={cn(FIELD_HEIGHT, 'font-mono')}
              name="endpoint"
              onChange={(event) => onChange({ ...value, endpoint: event.target.value })}
              placeholder="/var/run/docker.sock"
              value={value.endpoint}
            />
            <FieldError>{errors.endpoint}</FieldError>
          </Field>
        </div>

        <Field invalid={Boolean(errors.publicHost)} required>
          <FieldLabel>Public host</FieldLabel>
          <Input
            autoComplete="off"
            className={cn(FIELD_HEIGHT, 'font-mono')}
            name="publicHost"
            onChange={(event) => onChange({ ...value, publicHost: event.target.value })}
            placeholder="play.example.com"
            value={value.publicHost}
          />
          <FieldHelper>The address Platter tells players to connect to.</FieldHelper>
          <FieldError>{errors.publicHost}</FieldError>
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field invalid={Boolean(errors.portRangeStart)} required>
            <FieldLabel>Port range start</FieldLabel>
            <Input
              className={cn(FIELD_HEIGHT, 'font-mono')}
              inputMode="numeric"
              max={65535}
              min={1}
              name="portRangeStart"
              onChange={(event) => onChange({ ...value, portRangeStart: event.target.value })}
              type="number"
              value={value.portRangeStart}
            />
            <FieldError>{errors.portRangeStart}</FieldError>
          </Field>

          <Field invalid={Boolean(errors.portRangeEnd)} required>
            <FieldLabel>Port range end</FieldLabel>
            <Input
              className={cn(FIELD_HEIGHT, 'font-mono')}
              inputMode="numeric"
              max={65535}
              min={1}
              name="portRangeEnd"
              onChange={(event) => onChange({ ...value, portRangeEnd: event.target.value })}
              type="number"
              value={value.portRangeEnd}
            />
            <FieldHelper>Platter auto-allocates game ports from this inclusive range.</FieldHelper>
            <FieldError>{errors.portRangeEnd}</FieldError>
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-3">
          <Field invalid={Boolean(errors.memoryTotalMb)}>
            <FieldLabel>Memory (MB)</FieldLabel>
            <Input
              className={cn(FIELD_HEIGHT, 'font-mono')}
              inputMode="numeric"
              min={LIMITS.minMemoryMb}
              name="memoryTotalMb"
              onChange={(event) => onChange({ ...value, memoryTotalMb: event.target.value })}
              placeholder="Auto-detected"
              type="number"
              value={value.memoryTotalMb}
            />
            <FieldError>{errors.memoryTotalMb}</FieldError>
          </Field>

          <Field invalid={Boolean(errors.diskTotalMb)}>
            <FieldLabel>Disk (MB)</FieldLabel>
            <Input
              className={cn(FIELD_HEIGHT, 'font-mono')}
              inputMode="numeric"
              min={LIMITS.minDiskMb}
              name="diskTotalMb"
              onChange={(event) => onChange({ ...value, diskTotalMb: event.target.value })}
              placeholder="Auto-detected"
              type="number"
              value={value.diskTotalMb}
            />
            <FieldError>{errors.diskTotalMb}</FieldError>
          </Field>

          <Field invalid={Boolean(errors.cpuCores)}>
            <FieldLabel>CPU cores</FieldLabel>
            <Input
              className={cn(FIELD_HEIGHT, 'font-mono')}
              inputMode="decimal"
              min={0.1}
              name="cpuCores"
              onChange={(event) => onChange({ ...value, cpuCores: event.target.value })}
              placeholder="Auto-detected"
              step={0.1}
              type="number"
              value={value.cpuCores}
            />
            <FieldError>{errors.cpuCores}</FieldError>
          </Field>
        </div>
        <FieldHelper className="-mt-3">
          Leave any of the three blank to let Platter detect it from the driver.
        </FieldHelper>

        <Field className="max-w-56" invalid={Boolean(errors.overcommitRatio)}>
          <FieldLabel>Overcommit ratio</FieldLabel>
          <Input
            className={cn(FIELD_HEIGHT, 'font-mono')}
            inputMode="decimal"
            max={10}
            min={1}
            name="overcommitRatio"
            onChange={(event) => onChange({ ...value, overcommitRatio: event.target.value })}
            step={0.5}
            type="number"
            value={value.overcommitRatio}
          />
          <FieldHelper>
            1 allocates no more than this node physically has. Higher lets Platter place more
            servers than fit at once, betting they will not all peak together.
          </FieldHelper>
          <FieldError>{errors.overcommitRatio}</FieldError>
        </Field>
      </FieldGroup>
    </form>
  );
}
