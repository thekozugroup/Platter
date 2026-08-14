import type React from 'react';
import { useId } from 'react';
import { type z } from 'zod';
import {
  emailSchema,
  passwordSchema,
  usernameSchema,
  type createUserRequestSchema,
  type updateUserRequestSchema,
  type User,
  type UserRole,
} from '@platter/shared';
import { Field, FieldError, FieldGroup, FieldHelper, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  PasswordInput,
  PasswordInputGroup,
  PasswordInputInput,
  PasswordInputTrigger,
} from '@/components/ui/password-input';

/**
 * The fields shared by "create a user" and "edit a user".
 *
 * Validation mirrors `@platter/shared`'s own schemas rather than re-deriving the rules by
 * hand, so a password this form calls valid is never one the API turns around and rejects.
 * Create and edit differ in exactly one way that matters here: a password is required to
 * create an account and optional to edit one — leaving it blank on edit means "keep the
 * current password", which is also why editing never round-trips a real password into this
 * form's state.
 */

/** Neither request schema exports a named type; inferred so this can never drift from what
 *  the API actually validates. */
export type CreateUserRequest = z.infer<typeof createUserRequestSchema>;
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export type UserFormMode = 'create' | 'edit';

export interface UserFormValue {
  email: string;
  username: string;
  displayName: string;
  /** Empty on edit means "leave the current password in place". */
  password: string;
  role: UserRole;
}

export function defaultUserFormValue(role: UserRole = 'member'): UserFormValue {
  return { email: '', username: '', displayName: '', password: '', role };
}

export function userFormValueFromUser(user: User): UserFormValue {
  return {
    email: user.email,
    username: user.username,
    displayName: user.displayName,
    password: '',
    role: user.role,
  };
}

const FIELD_HEIGHT = 'h-11';

export function validateUserForm(value: UserFormValue, mode: UserFormMode): Record<string, string> {
  const errors: Record<string, string> = {};

  const email = emailSchema.safeParse(value.email);
  if (!email.success) errors.email = 'Enter a valid email address.';

  const username = usernameSchema.safeParse(value.username);
  if (!username.success) {
    errors.username = 'At least 3 characters: lowercase letters, numbers, dashes and underscores.';
  }

  if (value.displayName.trim().length === 0) {
    errors.displayName = 'Give this account a name.';
  } else if (value.displayName.trim().length > 64) {
    errors.displayName = 'Keep it under 64 characters.';
  }

  const passwordRequired = mode === 'create';
  if (passwordRequired || value.password.length > 0) {
    const password = passwordSchema.safeParse(value.password);
    if (!password.success) {
      errors.password = password.error.issues[0]?.message ?? 'Choose a longer password.';
    }
  }

  return errors;
}

export function buildCreateUserRequest(value: UserFormValue): CreateUserRequest {
  return {
    email: value.email.trim().toLowerCase(),
    username: value.username.trim(),
    displayName: value.displayName.trim(),
    password: value.password,
    role: value.role,
  };
}

/** Only the fields that actually changed — an update that repeats the current password would
 *  revoke every session and API key the account holds for no reason. */
export function buildUpdateUserRequest(value: UserFormValue, original: User): UpdateUserRequest {
  const patch: UpdateUserRequest = {};
  const email = value.email.trim().toLowerCase();
  const username = value.username.trim();
  const displayName = value.displayName.trim();

  if (email !== original.email) patch.email = email;
  if (username !== original.username) patch.username = username;
  if (displayName !== original.displayName) patch.displayName = displayName;
  if (value.role !== original.role) patch.role = value.role;
  if (value.password.length > 0) patch.password = value.password;

  return patch;
}

const ROLE_DESCRIPTION: Record<UserRole, string> = {
  owner: 'Everything an admin can do, plus the only role that can grant or remove other owners.',
  admin: 'Manages every server, user, node and setting on this installation.',
  member: 'Sees and manages only the servers they own or have been invited to.',
};

export interface UserFormProps {
  mode: UserFormMode;
  value: UserFormValue;
  onChange: (next: UserFormValue) => void;
  /** Server-side field errors from a failed submit, keyed the same as the request body. */
  fieldErrors?: Record<string, string>;
  /** Roles the current actor may grant. Excludes `owner` unless the actor is an owner. */
  availableRoles: readonly UserRole[];
  /** Disables the role field with a reason — e.g. editing your own account. */
  roleLockedReason?: string | undefined;
  /** Wires this form's inputs to an external submit button via the HTML `form` attribute. */
  formId?: string;
  onSubmit?: (event: React.FormEvent<HTMLFormElement>) => void;
}

export function UserForm({
  mode,
  value,
  onChange,
  fieldErrors,
  availableRoles,
  roleLockedReason,
  formId,
  onSubmit,
}: UserFormProps) {
  const localErrors = validateUserForm(value, mode);
  const errors = { ...localErrors, ...fieldErrors };
  const roleHintId = useId();

  return (
    <form className="flex flex-col gap-5" id={formId} noValidate onSubmit={onSubmit}>
      <FieldGroup>
        <Field invalid={Boolean(errors.displayName)} required>
          <FieldLabel>Display name</FieldLabel>
          <Input
            autoComplete="off"
            className={FIELD_HEIGHT}
            maxLength={64}
            name="displayName"
            onChange={(event) => onChange({ ...value, displayName: event.target.value })}
            value={value.displayName}
          />
          <FieldError>{errors.displayName}</FieldError>
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field invalid={Boolean(errors.email)} required>
            <FieldLabel>Email</FieldLabel>
            <Input
              autoComplete="off"
              className={FIELD_HEIGHT}
              inputMode="email"
              name="email"
              onChange={(event) => onChange({ ...value, email: event.target.value })}
              type="email"
              value={value.email}
            />
            <FieldHelper>What this account signs in with.</FieldHelper>
            <FieldError>{errors.email}</FieldError>
          </Field>

          <Field invalid={Boolean(errors.username)} required>
            <FieldLabel>Username</FieldLabel>
            <Input
              autoComplete="off"
              className={FIELD_HEIGHT}
              name="username"
              onChange={(event) =>
                onChange({ ...value, username: event.target.value.toLowerCase() })
              }
              value={value.username}
            />
            <FieldHelper>Lowercase, no spaces.</FieldHelper>
            <FieldError>{errors.username}</FieldError>
          </Field>
        </div>

        <Field invalid={Boolean(errors.password)} required={mode === 'create'}>
          <FieldLabel>{mode === 'create' ? 'Password' : 'New password'}</FieldLabel>
          <PasswordInput size="lg">
            <PasswordInputGroup className={FIELD_HEIGHT}>
              <PasswordInputInput
                autoComplete="new-password"
                name="password"
                onChange={(event) => onChange({ ...value, password: event.target.value })}
                value={value.password}
              />
              <PasswordInputTrigger aria-label="Toggle password visibility" />
            </PasswordInputGroup>
          </PasswordInput>
          <FieldHelper>
            {mode === 'create'
              ? 'At least 12 characters. Length beats symbols.'
              : 'Leave this blank to keep the current password. Setting one signs the account out everywhere.'}
          </FieldHelper>
          <FieldError>{errors.password}</FieldError>
        </Field>

        <Field disabled={Boolean(roleLockedReason)} invalid={Boolean(errors.role)}>
          <FieldLabel>Role</FieldLabel>
          <NativeSelect
            aria-describedby={roleLockedReason ? roleHintId : undefined}
            className="w-full [&>select]:h-11"
            disabled={Boolean(roleLockedReason)}
            onChange={(event) => onChange({ ...value, role: event.target.value as UserRole })}
            size="lg"
            value={value.role}
          >
            {availableRoles.map((role) => (
              <NativeSelectOption key={role} value={role}>
                {role.charAt(0).toUpperCase() + role.slice(1)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <FieldHelper>
            {roleLockedReason ? (
              <span id={roleHintId}>{roleLockedReason}</span>
            ) : (
              ROLE_DESCRIPTION[value.role]
            )}
          </FieldHelper>
        </Field>
      </FieldGroup>
    </form>
  );
}
