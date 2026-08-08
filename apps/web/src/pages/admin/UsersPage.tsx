import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  ROLE_RANK,
  USER_ROLES,
  formatRelativeTime,
  type Paginated,
  type User,
  type UserRole,
} from '@platter/shared';
import { Crown } from 'pixelarticons/react/Crown.js';
import { MoreVertical } from 'pixelarticons/react/MoreVertical.js';
import { Pencil } from 'pixelarticons/react/Pencil.js';
import { Plus } from 'pixelarticons/react/Plus.js';
import { Search } from 'pixelarticons/react/Search.js';
import { Shield } from 'pixelarticons/react/Shield.js';
import { Trash } from 'pixelarticons/react/Trash.js';
import { User as UserIcon } from 'pixelarticons/react/User.js';
import { UserX } from 'pixelarticons/react/UserX.js';
import { Users as UsersIcon } from 'pixelarticons/react/Users.js';
import { avatarStyle } from '@/components/common/avatar-ink';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import { StatusCapsule } from '@/components/common/status-pill';
import { PageAction, PageBody, PageHeader } from '@/components/layout/page-header';
import {
  UserForm,
  buildCreateUserRequest,
  buildUpdateUserRequest,
  defaultUserFormValue,
  userFormValueFromUser,
  validateUserForm,
  type UserFormValue,
} from '@/components/admin/user-form';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Pagination,
  PaginationItems,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toast';
import { useCreateUser, useDeleteUser, useUpdateUser, useUsers } from '@/hooks';
import { ApiError, api, errorMessage } from '@/lib/api-client.js';
import { useAuth } from '@/lib/auth.js';
import { queryKeys } from '@/lib/query.js';
import { cn } from '@/lib/utils';

/**
 * Every account on this installation: who they are, what they can do, and whether they can
 * still sign in.
 *
 * Two rules from `services/users.ts` cannot be enforced only by reacting to the error they
 * throw, because by the time that error arrives the admin has already picked "delete" and
 * needs a way forward, not a dead end: an account that owns servers cannot be deleted without
 * saying who inherits them, and Platter can never be left with zero owners. Both are checked
 * here before the request goes out — the delete dialog asks for a new owner up front when the
 * account owns anything, and the sole remaining owner's own destructive actions are disabled
 * with the reason shown, rather than offered and then refused.
 */

const PER_PAGE = 20;
const SEARCH_DEBOUNCE_MS = 300;
const ACTION = 'h-11 rounded-button px-4 text-subhead font-medium';

const ROLE_ICON: Record<UserRole, (props: React.SVGProps<SVGSVGElement>) => React.JSX.Element> = {
  owner: Crown,
  admin: Shield,
  member: UserIcon,
};

const ROLE_LABEL: Record<UserRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

function RoleTag({ role }: { role: UserRole }) {
  const Icon = ROLE_ICON[role];
  return (
    <span className="inline-flex items-center gap-1.5 text-subhead text-label">
      <Icon aria-hidden className="size-4 shrink-0 text-label-tertiary" />
      {ROLE_LABEL[role]}
    </span>
  );
}

/** Active/suspended is not a server-lifecycle status, so it does not borrow `StatusPill` —
 *  it borrows the capsule underneath it, which keeps the word near-black. Painting "Active"
 *  `text-success` measured 3.31:1 on the pill at 12px, under AA. */
function AccountStatusBadge({ suspended }: { suspended: boolean }) {
  return (
    <StatusCapsule
      data-status={suspended ? 'suspended' : 'active'}
      pulse={!suspended}
      tone={suspended ? 'neutral' : 'success'}
    >
      {suspended ? 'Suspended' : 'Active'}
    </StatusCapsule>
  );
}

function lastLoginText(user: User): string {
  return user.lastLoginAt ? formatRelativeTime(user.lastLoginAt) : 'Never signed in';
}

/** Nobody may act on an account that outranks them — mirrors `assertCanAct` in
 *  `services/users.ts`, so the row explains the same rule the API would enforce anyway. */
function outranks(actorRole: UserRole, target: User): boolean {
  return ROLE_RANK[target.role] > ROLE_RANK[actorRole];
}

// ---------------------------------------------------------------------------------------

interface RowActionsProps {
  user: User;
  isSelf: boolean;
  isSoleOwner: boolean;
  canAct: boolean;
  onEdit: () => void;
  onToggleSuspend: () => void;
  onDelete: () => void;
}

function disabledReasonFor(
  action: 'suspend' | 'delete',
  { isSelf, isSoleOwner, canAct }: { isSelf: boolean; isSoleOwner: boolean; canAct: boolean },
): string | undefined {
  if (!canAct) return "You don't have access to this account.";
  if (isSoleOwner) return 'Platter needs at least one owner. Promote someone else first.';
  if (isSelf) return `You can't ${action} your own account while signed in as them.`;
  return undefined;
}

function RowActions({
  user,
  isSelf,
  isSoleOwner,
  canAct,
  onEdit,
  onToggleSuspend,
  onDelete,
}: RowActionsProps) {
  const suspendReason = disabledReasonFor('suspend', { isSelf, isSoleOwner, canAct });
  const deleteReason = disabledReasonFor('delete', { isSelf, isSoleOwner, canAct });

  return (
    <Menu
      onSelect={({ value }) => {
        if (value === 'edit') onEdit();
        else if (value === 'toggle-suspend' && !suspendReason) onToggleSuspend();
        else if (value === 'delete' && !deleteReason) onDelete();
      }}
    >
      <MenuTrigger asChild>
        <Button
          aria-label={`Actions for ${user.displayName}`}
          className="hit-target size-9 shrink-0 text-label-tertiary hover:text-label"
          size="icon-md"
          variant="ghost"
        >
          <MoreVertical aria-hidden />
        </Button>
      </MenuTrigger>
      <MenuContent className="w-56">
        <MenuItem value="edit">
          <Pencil aria-hidden />
          Edit account
        </MenuItem>
        <MenuItem
          disabled={Boolean(suspendReason)}
          title={suspendReason}
          value="toggle-suspend"
        >
          <UserX aria-hidden />
          {user.suspended ? 'Reactivate' : 'Suspend'}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          disabled={Boolean(deleteReason)}
          title={deleteReason}
          value="delete"
          variant="destructive"
        >
          <Trash aria-hidden />
          Delete account
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function IdentityCell({ user }: { user: User }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <Avatar className="size-9 rounded-sm" size="md">
        <AvatarFallback
          className="rounded-sm text-caption font-semibold"
          style={avatarStyle(user.avatarColor)}
        >
          {user.displayName.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <p className="truncate text-subhead font-medium text-label">{user.displayName}</p>
        <p className="truncate text-caption text-label-tertiary">{user.email}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------

export function UsersPage() {
  const { user: me } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const urlSearch = searchParams.get('q') ?? '';
  const roleFilter = (searchParams.get('role') as UserRole | null) ?? '';
  const suspendedFilter = searchParams.get('suspended') ?? '';
  const page = Math.max(1, Number(searchParams.get('page') ?? '1') || 1);

  const [searchDraft, setSearchDraft] = useState(urlSearch);
  const debouncedSearch = useDebounced(searchDraft, SEARCH_DEBOUNCE_MS);

  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [suspendingUser, setSuspendingUser] = useState<User | null>(null);
  const [deletingUser, setDeletingUser] = useState<User | null>(null);

  function updateParams(changes: Record<string, string>) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) {
        if (value === '') next.delete(key);
        else next.set(key, value);
      }
      if (!('page' in changes)) next.delete('page');
      return next;
    }, { replace: true });
  }

  useEffect(() => {
    if (debouncedSearch === urlSearch) return;
    updateParams({ q: debouncedSearch });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  const params = {
    page,
    perPage: PER_PAGE,
    ...(urlSearch ? { search: urlSearch } : {}),
    ...(roleFilter ? { role: roleFilter } : {}),
    ...(suspendedFilter ? { suspended: suspendedFilter === 'true' } : {}),
  };

  const users = useUsers(params);

  // How many owners exist in total — not just on this page — so the sole owner's own row can
  // disable the actions that would leave Platter without one, instead of offering them and
  // refusing afterwards.
  const owners = useQuery({
    queryKey: [...queryKeys.users.all, 'owner-count'] as const,
    queryFn: () => api.get<Paginated<User>>('/users', { query: { role: 'owner', perPage: 100 } }),
    staleTime: 30_000,
  });
  const ownerCount = owners.data?.meta.total;

  const create = useCreateUser();
  const update = useUpdateUser();

  const rows = users.data?.data ?? [];
  const total = users.data?.meta.total ?? 0;
  const totalPages = users.data?.meta.totalPages ?? 1;
  const filtered = urlSearch !== '' || roleFilter !== '' || suspendedFilter !== '';

  const isOwnerActor = me?.role === 'owner';
  const availableRoles = isOwnerActor ? USER_ROLES : USER_ROLES.filter((role) => role !== 'owner');

  const [formValue, setFormValue] = useState<UserFormValue>(defaultUserFormValue());
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const mode = editingUser ? 'edit' : 'create';
  const localErrors = validateUserForm(formValue, mode);
  const valid = Object.keys(localErrors).length === 0;
  const dirty =
    mode === 'create' ||
    (editingUser !== null &&
      Object.keys(buildUpdateUserRequest(formValue, editingUser)).length > 0);

  function openCreate() {
    setEditingUser(null);
    setFormValue(defaultUserFormValue());
    setFormErrors({});
    setShowForm(true);
  }

  function openEdit(user: User) {
    setEditingUser(user);
    setFormValue(userFormValueFromUser(user));
    setFormErrors({});
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingUser(null);
    setFormErrors({});
  }

  function submitForm() {
    if (!valid) return;

    if (editingUser) {
      const patch = buildUpdateUserRequest(formValue, editingUser);
      if (Object.keys(patch).length === 0) return;
      update.mutate(
        { userId: editingUser.id, patch },
        {
          onSuccess: (updated) => {
            closeForm();
            toast.create({ title: `${updated.displayName} saved`, type: 'success' });
          },
          onError: (cause: unknown) => {
            setFormErrors(cause instanceof ApiError ? cause.fieldErrors : {});
            toast.create({
              title: "Couldn't save the account",
              description: errorMessage(cause),
              type: 'error',
            });
          },
        },
      );
    } else {
      create.mutate(buildCreateUserRequest(formValue), {
        onSuccess: (created) => {
          closeForm();
          toast.create({ title: `${created.displayName} created`, type: 'success' });
        },
        onError: (cause: unknown) => {
          setFormErrors(cause instanceof ApiError ? cause.fieldErrors : {});
          toast.create({
            title: "Couldn't create the account",
            description: errorMessage(cause),
            type: 'error',
          });
        },
      });
    }
  }

  const formPending = create.isPending || update.isPending;

  const rowMeta = (user: User) => ({
    isSelf: me?.id === user.id,
    isSoleOwner: user.role === 'owner' && (ownerCount === undefined || ownerCount <= 1),
    canAct: me ? !outranks(me.role, user) : false,
  });

  return (
    <>
      <PageHeader
        actions={
          <PageAction onClick={openCreate}>
            <Plus aria-hidden />
            New user
          </PageAction>
        }
        description="Every account on this installation, and what it can do."
        title="Users"
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field className="min-w-56 max-w-xs flex-1">
            <FieldLabel>Search</FieldLabel>
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute inset-s-3 top-1/2 size-4 -translate-y-1/2 text-label-tertiary"
              />
              <Input
                autoComplete="off"
                className="h-11 ps-9"
                name="user-search"
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="Name, email or username"
                type="search"
                value={searchDraft}
              />
            </div>
          </Field>

          <Field className="w-auto">
            <FieldLabel>Role</FieldLabel>
            <NativeSelect
              className="w-40 [&>select]:h-11"
              onChange={(event) => updateParams({ role: event.target.value })}
              size="lg"
              value={roleFilter}
            >
              <NativeSelectOption value="">Any role</NativeSelectOption>
              {USER_ROLES.map((role) => (
                <NativeSelectOption key={role} value={role}>
                  {ROLE_LABEL[role]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>

          <Field className="w-auto">
            <FieldLabel>Status</FieldLabel>
            <NativeSelect
              className="w-40 [&>select]:h-11"
              onChange={(event) => updateParams({ suspended: event.target.value })}
              size="lg"
              value={suspendedFilter}
            >
              <NativeSelectOption value="">Any status</NativeSelectOption>
              <NativeSelectOption value="false">Active</NativeSelectOption>
              <NativeSelectOption value="true">Suspended</NativeSelectOption>
            </NativeSelect>
          </Field>
        </div>
      </PageHeader>

      <PageBody>
        {users.isPending ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
            <span aria-live="polite" className="sr-only" role="status">
              Loading accounts
            </span>
          </div>
        ) : null}

        {users.isError ? (
          <ErrorState
            error={users.error}
            isRetrying={users.isFetching}
            onRetry={() => void users.refetch()}
            title="Couldn’t load accounts"
          />
        ) : null}

        {users.isSuccess && rows.length === 0 && filtered ? (
          <EmptyState
            action={{
              label: 'Clear the filters',
              onClick: () => {
                setSearchDraft('');
                updateParams({ q: '', role: '', suspended: '' });
              },
            }}
            description="No account matches these filters. Widen the search, or clear it to see everyone."
            title="Nothing matches that"
          />
        ) : null}

        {users.isSuccess && rows.length === 0 && !filtered ? (
          <EmptyState
            action={{ label: 'Create the first account', onClick: openCreate }}
            description="Every account on Platter — who can sign in, what they can do, and which servers they own — lives here."
            icon={<UsersIcon />}
            title="No accounts yet"
          />
        ) : null}

        {users.isSuccess && rows.length > 0 ? (
          <div className="flex flex-col gap-6">
            <p aria-live="polite" className="text-caption text-label-secondary" role="status">
              {`${total} account${total === 1 ? '' : 's'}`}
              {filtered ? ' matching your filters' : ''}
              {totalPages > 1 ? ` · page ${page} of ${totalPages}` : ''}
            </p>

            {/* Desktop: a real table. */}
            <div className="hidden md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Account</TableHead>
                    <TableHead className="w-32">Role</TableHead>
                    <TableHead className="w-24 text-end">Servers</TableHead>
                    <TableHead className="w-44">Last signed in</TableHead>
                    <TableHead className="w-32">Status</TableHead>
                    <TableHead className="w-16">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((user) => {
                    const meta = rowMeta(user);
                    return (
                      <TableRow key={user.id}>
                        <TableCell>
                          <IdentityCell user={user} />
                        </TableCell>
                        <TableCell>
                          <RoleTag role={user.role} />
                        </TableCell>
                        <TableCell className="tabular text-end font-mono text-footnote text-label-secondary">
                          {user.serverCount}
                        </TableCell>
                        <TableCell
                          className="text-footnote text-label-secondary"
                          title={user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : undefined}
                        >
                          {lastLoginText(user)}
                        </TableCell>
                        <TableCell>
                          <AccountStatusBadge suspended={user.suspended} />
                        </TableCell>
                        <TableCell className="text-end">
                          <RowActions
                            canAct={meta.canAct}
                            isSelf={meta.isSelf}
                            isSoleOwner={meta.isSoleOwner}
                            onDelete={() => setDeletingUser(user)}
                            onEdit={() => openEdit(user)}
                            onToggleSuspend={() => setSuspendingUser(user)}
                            user={user}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Phone: the same rows as cards. A six-column table at 360px is unreadable. */}
            <ul className="flex flex-col divide-y divide-separator border-y border-separator md:hidden">
              {rows.map((user) => {
                const meta = rowMeta(user);
                return (
                  <li className="flex flex-col gap-3 py-4" key={user.id}>
                    <div className="flex items-start justify-between gap-3">
                      <IdentityCell user={user} />
                      <RowActions
                        canAct={meta.canAct}
                        isSelf={meta.isSelf}
                        isSoleOwner={meta.isSoleOwner}
                        onDelete={() => setDeletingUser(user)}
                        onEdit={() => openEdit(user)}
                        onToggleSuspend={() => setSuspendingUser(user)}
                        user={user}
                      />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                      <RoleTag role={user.role} />
                      <AccountStatusBadge suspended={user.suspended} />
                    </div>
                    <p className="text-caption text-label-tertiary">
                      {user.serverCount} {user.serverCount === 1 ? 'server' : 'servers'} ·{' '}
                      {lastLoginText(user)}
                    </p>
                  </li>
                );
              })}
            </ul>

            {totalPages > 1 ? (
              <Pagination
                className={cn(
                  'pt-2',
                  '[&_[data-slot=pagination-item]]:size-11',
                  '[&_[data-slot=pagination-previous]]:h-11 [&_[data-slot=pagination-previous]]:px-4',
                  '[&_[data-slot=pagination-next]]:h-11 [&_[data-slot=pagination-next]]:px-4',
                  '[&_[data-slot=pagination-ellipsis]]:h-11',
                )}
                count={total}
                onPageChange={({ page: next }) => updateParams({ page: String(next) })}
                page={page}
                pageSize={PER_PAGE}
              >
                <PaginationPrevious />
                <PaginationItems />
                <PaginationNext />
              </Pagination>
            ) : null}
          </div>
        ) : null}
      </PageBody>

      {/* -------------------------------------------------------------- Create / edit */}
      <Dialog onOpenChange={({ open }) => (open ? undefined : closeForm())} open={showForm}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle className="font-sans text-title-3 font-semibold">
              {editingUser ? `Edit ${editingUser.displayName}` : 'New user'}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <UserForm
              availableRoles={availableRoles}
              fieldErrors={formErrors}
              formId="user-form"
              mode={mode}
              onChange={setFormValue}
              onSubmit={(event) => {
                event.preventDefault();
                submitForm();
              }}
              roleLockedReason={
                editingUser && editingUser.role === 'owner' && (ownerCount === undefined || ownerCount <= 1)
                  ? 'Platter needs at least one owner. Promote someone else to owner first.'
                  : undefined
              }
              value={formValue}
            />
          </DialogBody>
          <DialogFooter>
            <Button className={ACTION} onClick={closeForm} variant="outline">
              Cancel
            </Button>
            <Button
              className={ACTION}
              disabled={!valid || !dirty}
              form="user-form"
              isLoading={formPending}
              type="submit"
            >
              {editingUser ? 'Save changes' : 'Create user'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SuspendDialog onClose={() => setSuspendingUser(null)} user={suspendingUser} />
      <DeleteDialog onClose={() => setDeletingUser(null)} user={deletingUser} />
    </>
  );
}

// ---------------------------------------------------------------------------------------

function SuspendDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const update = useUpdateUser();
  const nextSuspended = user ? !user.suspended : false;

  return (
    <AlertDialog onOpenChange={({ open }) => (open ? undefined : onClose())} open={user !== null}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-sans text-title-3 font-semibold">
            {nextSuspended ? `Suspend ${user?.displayName}?` : `Reactivate ${user?.displayName}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {nextSuspended
              ? 'They are signed out immediately and cannot sign back in until reactivated.'
              : 'They can sign in again right away.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {nextSuspended && user && user.serverCount > 0 ? (
          <AlertDialogBody className="text-subhead text-label-secondary">
            {user.serverCount} {user.serverCount === 1 ? 'server' : 'servers'} they own{' '}
            {user.serverCount === 1 ? 'stops' : 'stop'} too — Platter shuts each one down as part
            of the suspension. Nothing is deleted, and un-suspending the account does not start
            them back up on its own.
          </AlertDialogBody>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel className={ACTION}>Never mind</AlertDialogCancel>
          <AlertDialogAction
            className={ACTION}
            isLoading={update.isPending}
            onClick={() => {
              if (!user) return;
              update.mutate(
                { userId: user.id, patch: { suspended: nextSuspended } },
                {
                  onSuccess: () => {
                    onClose();
                    toast.create({
                      title: nextSuspended ? `${user.displayName} suspended` : `${user.displayName} reactivated`,
                      type: 'success',
                    });
                  },
                  onError: (cause: unknown) =>
                    toast.create({
                      title: "Couldn't do that",
                      description: errorMessage(cause),
                      type: 'error',
                    }),
                },
              );
            }}
            variant={nextSuspended ? 'destructive' : 'default'}
          >
            {nextSuspended ? 'Suspend account' : 'Reactivate account'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------------------

function DeleteDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const remove = useDeleteUser();
  const [transferTo, setTransferTo] = useState('');
  const owesServers = (user?.serverCount ?? 0) > 0;

  useEffect(() => {
    setTransferTo('');
  }, [user?.id]);

  const candidates = useQuery({
    queryKey: [...queryKeys.users.all, 'reassign-candidates'] as const,
    queryFn: () => api.get<Paginated<User>>('/users', { query: { perPage: 100, suspended: false } }),
    enabled: owesServers,
  });
  const options = (candidates.data?.data ?? []).filter((candidate) => candidate.id !== user?.id);

  const canSubmit = !owesServers || transferTo !== '';

  return (
    <AlertDialog onOpenChange={({ open }) => (open ? undefined : onClose())} open={user !== null}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-sans text-title-3 font-semibold">
            Delete {user?.displayName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes the account, its sessions and its API keys. It cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {owesServers && user ? (
          <AlertDialogBody className="flex flex-col gap-3">
            <p className="text-subhead text-label-secondary">
              {user.displayName} owns {user.serverCount} {user.serverCount === 1 ? 'server' : 'servers'}.
              Platter will not delete an account that still owns servers — choose who receives
              them.
            </p>
            <Field required>
              <FieldLabel>Reassign their servers to</FieldLabel>
              <NativeSelect
                className="w-full [&>select]:h-11"
                onChange={(event) => setTransferTo(event.target.value)}
                size="lg"
                value={transferTo}
              >
                <NativeSelectOption value="">Choose an account</NativeSelectOption>
                {options.map((candidate) => (
                  <NativeSelectOption key={candidate.id} value={candidate.id}>
                    {candidate.displayName} ({candidate.email})
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </AlertDialogBody>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel className={ACTION}>Keep the account</AlertDialogCancel>
          <AlertDialogAction
            className={ACTION}
            disabled={!canSubmit}
            isLoading={remove.isPending}
            onClick={() => {
              if (!user) return;
              remove.mutate(
                { userId: user.id, ...(transferTo ? { transferTo } : {}) },
                {
                  onSuccess: () => {
                    onClose();
                    toast.create({ title: `Deleted ${user.displayName}`, type: 'success' });
                  },
                  onError: (cause: unknown) => {
                    // The API's own message already names what happened and, for both cases
                    // this dialog cannot already prevent, exactly what to do about it.
                    toast.create({
                      title: "Couldn't delete the account",
                      description: errorMessage(cause),
                      type: 'error',
                    });
                    void queryClient.invalidateQueries({ queryKey: queryKeys.users.all });
                  },
                },
              );
            }}
            variant="destructive"
          >
            Delete account
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
