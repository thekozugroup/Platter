import { useState } from 'react';
import type { BlueprintVariable } from '@platter/shared';
import { ChevronDown } from 'pixelarticons/react/ChevronDown.js';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldRequiredIndicator,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  PasswordInput,
  PasswordInputGroup,
  PasswordInputInput,
  PasswordInputTrigger,
} from '@/components/ui/password-input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/**
 * A blueprint's variables, rendered from its own declared schema.
 *
 * Blueprints are data: adding a game, or a setting to a game, must not mean shipping a new
 * build of this client. So nothing here is keyed to a particular variable — the *type* decides
 * the control, and the blueprint's `required` and `advanced` flags decide where it sits.
 *
 * The one judgement call this file makes is that a required variable is never behind a
 * disclosure. Minecraft's EULA is the case that matters: it has no default, the server refuses
 * to boot without it, and burying it under "Advanced" would produce a server that installs
 * perfectly and then dies on first start with a message nobody reads.
 */

/** Variables arrive as strings on the wire; booleans are `"true"` / `"false"`. */
export type VariableValues = Record<string, string>;

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

/** A variable the operator is allowed to see and set. */
function isVisible(variable: BlueprintVariable): boolean {
  return !variable.hidden;
}

/** The blueprint's own defaults, which is what the API applies when a key is omitted. */
export function defaultVariableValues(variables: readonly BlueprintVariable[]): VariableValues {
  const values: VariableValues = {};
  for (const variable of variables) {
    if (!isVisible(variable)) continue;
    values[variable.key] = variable.default === null ? '' : String(variable.default);
  }
  return values;
}

/**
 * One variable's error, or `null`.
 *
 * Mirrors the API's own `resolveVariables` so the form never submits something the server will
 * reject — with one deliberate addition. The API accepts `EULA=false` because "false" is a
 * present value; the resulting server installs and then refuses to start forever. A required
 * boolean that is off is treated as unanswered here.
 */
export function validateVariableValue(
  variable: BlueprintVariable,
  raw: string | undefined,
): string | null {
  const value = raw ?? '';

  if (variable.type === 'boolean') {
    if (variable.required && value !== 'true') {
      return `Turn “${variable.label}” on before the server can start.`;
    }
    return null;
  }

  if (isBlank(value)) {
    return variable.required ? `${variable.label} is required.` : null;
  }

  if (variable.type === 'number') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 'Enter a number.';
    if (variable.min !== null && parsed < variable.min) return `Must be ${variable.min} or more.`;
    if (variable.max !== null && parsed > variable.max) return `Must be ${variable.max} or less.`;
    return null;
  }

  if (variable.type === 'enum') {
    const allowed = variable.options.some((option) => option.value === value);
    return allowed ? null : 'Pick one of the listed options.';
  }

  // string and password
  if (variable.max !== null && value.length > variable.max) {
    return `Keep it to ${variable.max} characters or fewer.`;
  }
  if (variable.pattern !== null) {
    try {
      if (!new RegExp(variable.pattern).test(value)) {
        return `That is not a valid ${variable.label.toLowerCase()}.`;
      }
    } catch {
      // A blueprint shipping an invalid pattern must not block the form. The API validates
      // with the same source string and will say so properly if it really is wrong.
      return null;
    }
  }
  return null;
}

/** Every error across a blueprint's visible variables, keyed by variable key. */
export function variableErrors(
  variables: readonly BlueprintVariable[],
  values: VariableValues,
  omitKeys: readonly string[] = [],
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const variable of variables) {
    if (!isVisible(variable) || omitKeys.includes(variable.key)) continue;
    const error = validateVariableValue(variable, values[variable.key]);
    if (error) errors[variable.key] = error;
  }
  return errors;
}

// ---------------------------------------------------------------------------------------

const CONTROL_HEIGHT = 'h-11';

function VariableField({
  variable,
  value,
  onChange,
  error,
}: {
  variable: BlueprintVariable;
  value: string;
  onChange: (next: string) => void;
  error?: string | undefined;
}) {
  const invalid = Boolean(error);

  if (variable.type === 'boolean') {
    return (
      <Field invalid={invalid} orientation="horizontal" required={variable.required}>
        <FieldContent>
          <FieldLabel>
            {variable.label}
            {variable.required ? <FieldRequiredIndicator /> : null}
          </FieldLabel>
          {variable.description ? (
            <FieldDescription>{variable.description}</FieldDescription>
          ) : null}
          <FieldError>{error}</FieldError>
        </FieldContent>
        {/*
          Inside a Field, Ark wires the switch to the label and the error automatically.
          `hit-target` grows the pointer target to 44px without changing how the switch looks —
          a 22px-tall control is the classic hit-target miss.
        */}
        <Switch
          checked={value === 'true'}
          className="mt-1 hit-target"
          onCheckedChange={({ checked }) => onChange(checked ? 'true' : 'false')}
        />
      </Field>
    );
  }

  if (variable.type === 'enum') {
    return (
      <Field invalid={invalid} required={variable.required}>
        <FieldLabel>
          {variable.label}
          {variable.required ? <FieldRequiredIndicator /> : null}
        </FieldLabel>
        {/* `NativeSelect` styles its wrapper; the child selector reaches the real control,
            whose largest built-in size stops short of the 44px minimum. */}
        <NativeSelect
          className="w-full max-w-sm [&>select]:h-11"
          invalid={invalid}
          onChange={(event) => onChange(event.target.value)}
          size="lg"
          value={value}
        >
          {variable.options.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {variable.description ? <FieldDescription>{variable.description}</FieldDescription> : null}
        <FieldError>{error}</FieldError>
      </Field>
    );
  }

  if (variable.type === 'password') {
    return (
      <Field invalid={invalid} required={variable.required}>
        <FieldLabel>
          {variable.label}
          {variable.required ? <FieldRequiredIndicator /> : null}
        </FieldLabel>
        <PasswordInput className="max-w-sm" size="lg">
          <PasswordInputGroup className={CONTROL_HEIGHT}>
            <PasswordInputInput
              autoComplete="off"
              onChange={(event) => onChange(event.target.value)}
              value={value}
            />
            <PasswordInputTrigger aria-label={`Show ${variable.label.toLowerCase()}`} />
          </PasswordInputGroup>
        </PasswordInput>
        {variable.description ? <FieldDescription>{variable.description}</FieldDescription> : null}
        <FieldError>{error}</FieldError>
      </Field>
    );
  }

  const isNumber = variable.type === 'number';

  return (
    <Field invalid={invalid} required={variable.required}>
      <FieldLabel>
        {variable.label}
        {variable.required ? <FieldRequiredIndicator /> : null}
      </FieldLabel>
      <Input
        className={cn(CONTROL_HEIGHT, 'max-w-sm', isNumber && 'tabular font-mono')}
        {...(isNumber
          ? {
              inputMode: 'numeric' as const,
              type: 'number' as const,
              ...(variable.min !== null ? { min: variable.min } : {}),
              ...(variable.max !== null ? { max: variable.max } : {}),
            }
          : variable.max !== null
            ? { maxLength: variable.max }
            : {})}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
      {variable.description ? <FieldDescription>{variable.description}</FieldDescription> : null}
      <FieldError>{error}</FieldError>
    </Field>
  );
}

export interface VariableFieldsProps {
  variables: readonly BlueprintVariable[];
  values: VariableValues;
  onChange: (key: string, value: string) => void;
  /** Keyed by variable key. Merge API field errors in here after a failed submit. */
  errors?: Record<string, string>;
  /** Rendered elsewhere on the page — Minecraft's `TYPE` belongs to its own picker. */
  omitKeys?: readonly string[];
  /**
   * Advanced variables lifted out of the disclosure because the current choice makes them
   * load-bearing — the pack slug once a modpack type is picked, for instance.
   */
  promoteKeys?: readonly string[];
  className?: string;
}

export function VariableFields({
  variables,
  values,
  onChange,
  errors = {},
  omitKeys = [],
  promoteKeys = [],
  className,
}: VariableFieldsProps) {
  const visible = variables.filter(
    (variable) => isVisible(variable) && !omitKeys.includes(variable.key),
  );

  const promoted = visible.filter(
    (variable) => !variable.advanced || promoteKeys.includes(variable.key),
  );
  const advanced = visible.filter(
    (variable) => variable.advanced && !promoteKeys.includes(variable.key),
  );

  // An advanced field that failed validation must not be hidden behind a closed disclosure.
  const advancedHasError = advanced.some((variable) => Boolean(errors[variable.key]));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const advancedOpen = showAdvanced || advancedHasError;

  const required = promoted.filter((variable) => variable.required);
  const optional = promoted.filter((variable) => !variable.required);

  return (
    <div className={cn('flex flex-col gap-8', className)}>
      {required.length > 0 ? (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h3 className="font-sans text-title-3 font-semibold text-label">Before it can start</h3>
            <p className="max-w-prose text-subhead text-label-secondary">
              The server will not boot until these are answered.
            </p>
          </div>
          <FieldGroup className="gap-6">
            {required.map((variable) => (
              <VariableField
                error={errors[variable.key]}
                key={variable.key}
                onChange={(next) => onChange(variable.key, next)}
                value={values[variable.key] ?? ''}
                variable={variable}
              />
            ))}
          </FieldGroup>
        </section>
      ) : null}

      {optional.length > 0 ? (
        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h3 className="font-sans text-title-3 font-semibold text-label">Game settings</h3>
            <p className="max-w-prose text-subhead text-label-secondary">
              Sensible defaults are already filled in. Every one of these can be changed later
              without recreating the server.
            </p>
          </div>
          <FieldGroup className="gap-6">
            {optional.map((variable) => (
              <VariableField
                error={errors[variable.key]}
                key={variable.key}
                onChange={(next) => onChange(variable.key, next)}
                value={values[variable.key] ?? ''}
                variable={variable}
              />
            ))}
          </FieldGroup>
        </section>
      ) : null}

      {advanced.length > 0 ? (
        <section className="flex flex-col gap-4">
          {!advancedOpen ? (
            <Button
              aria-expanded={false}
              className="h-11 w-fit rounded-button px-4 text-subhead font-medium text-label-secondary"
              onClick={() => setShowAdvanced(true)}
              variant="ghost"
            >
              <ChevronDown aria-hidden />
              {`Advanced settings (${advanced.length})`}
            </Button>
          ) : (
            <>
              <div className="flex flex-col gap-1">
                <h3 className="font-sans text-title-3 font-semibold text-label">Advanced</h3>
                <p className="max-w-prose text-subhead text-label-secondary">
                  Version pins, JVM flags and the settings only some server types read. Leave a
                  field empty and the blueprint picks for you.
                </p>
              </div>
              <FieldGroup className="gap-6">
                {advanced.map((variable) => (
                  <VariableField
                    error={errors[variable.key]}
                    key={variable.key}
                    onChange={(next) => onChange(variable.key, next)}
                    value={values[variable.key] ?? ''}
                    variable={variable}
                  />
                ))}
              </FieldGroup>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
