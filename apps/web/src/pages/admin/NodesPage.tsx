import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  formatMegabytes,
  formatRelativeTime,
  type Node,
  type NodeDriver,
  type NodeStatus,
} from '@platter/shared';
import { Cpu } from 'pixelarticons/react/Cpu.js';
import { MoreVertical } from 'pixelarticons/react/MoreVertical.js';
import { Pencil } from 'pixelarticons/react/Pencil.js';
import { Plus } from 'pixelarticons/react/Plus.js';
import { Reload } from 'pixelarticons/react/Reload.js';
import { Server as ServerIcon } from 'pixelarticons/react/Server.js';
import { Trash } from 'pixelarticons/react/Trash.js';
import { CapacityBar } from '@/components/admin/capacity-bar';
import {
  NodeForm,
  buildCreateNodeRequest,
  buildUpdateNodeRequest,
  defaultNodeFormValue,
  nodeFormValueFromNode,
  validateNodeForm,
  type NodeFormValue,
} from '@/components/admin/node-form';
import { EmptyState } from '@/components/common/empty-state';
import { ErrorState } from '@/components/common/error-state';
import { StatusCapsule, type StatusTone } from '@/components/common/status-pill';
import { PageAction, PageBody, PageHeader } from '@/components/layout/page-header';
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
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/menu';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import {
  useCreateNode,
  useDeleteNode,
  useNodeCapacity,
  useNodes,
  useTestNode,
  useUpdateNode,
  type TestNodeResult,
} from '@/hooks';
import { errorMessage } from '@/lib/api-client.js';
import { queryKeys } from '@/lib/query.js';
import { cn } from '@/lib/utils';

/**
 * The hosts that run game servers.
 *
 * A self-hosted install typically has exactly one of these, so this reads as a short list of
 * detailed cards rather than a dense table — each node needs three capacity bars, a driver
 * version, a reachability state and a live test, none of which fit a table cell without
 * shrinking to illegibility.
 */

const ACTION = 'h-11 rounded-button px-4 text-subhead font-medium';

const DRIVER_LABEL: Record<NodeDriver, string> = { docker: 'Docker', mock: 'Mock' };

const NODE_STATUS_LABEL: Record<NodeStatus, string> = {
  online: 'Online',
  degraded: 'Degraded',
  offline: 'Offline',
  unknown: 'Not checked yet',
};

const NODE_STATUS_TONE: Record<NodeStatus, StatusTone> = {
  online: 'success',
  degraded: 'warning',
  offline: 'danger',
  unknown: 'neutral',
};

/**
 * A node's health is not a `ServerStatus`, so it does not borrow `StatusPill` — but it is
 * the same capsule, and the reason the word stays near-black is the same one: at 13px,
 * `text-success` on the pill measures 3.51:1 and `text-warning` 3.77:1. The dot carries the
 * colour, the pulse and the ring; the word carries the meaning.
 */
function NodeStatusPill({ status }: { status: NodeStatus }) {
  return (
    <StatusCapsule
      data-status={status}
      pulse={status === 'online'}
      ring={status === 'offline' ? 'danger' : undefined}
      size="md"
      tone={NODE_STATUS_TONE[status]}
    >
      {NODE_STATUS_LABEL[status]}
    </StatusCapsule>
  );
}

// ---------------------------------------------------------------------------------------

function TestResultPanel({ result }: { result: TestNodeResult }) {
  return (
    <div
      aria-live="polite"
      className={cn(
        'flex flex-col gap-1.5 rounded-sm border px-3 py-2.5 text-footnote',
        result.reachable
          ? 'border-success/25 bg-success-subtle text-label'
          : 'border-danger/25 bg-danger-subtle text-label',
      )}
      role="status"
    >
      <p className="font-medium">
        {result.reachable ? 'Reachable' : 'Not reachable'} · tested{' '}
        {formatRelativeTime(result.testedAt)}
        {result.reachable ? ` · ${result.latencyMs} ms` : ''}
      </p>
      {result.reachable ? (
        <p className="tabular font-mono text-caption text-label-secondary">
          {result.driverVersion ?? 'unknown version'}
          {result.cpuCores !== null ? ` · ${result.cpuCores} cores` : ''}
          {result.memoryTotalMb !== null ? ` · ${formatMegabytes(result.memoryTotalMb)}` : ''}
          {result.containersRunning !== null
            ? ` · ${result.containersRunning} container${result.containersRunning === 1 ? '' : 's'} running`
            : ''}
        </p>
      ) : (
        <p className="text-caption text-label-secondary">{result.error ?? 'No error was given.'}</p>
      )}
    </div>
  );
}

interface NodeCardProps {
  node: Node;
  onEdit: () => void;
  onDelete: () => void;
}

function NodeCard({ node, onEdit, onDelete }: NodeCardProps) {
  const queryClient = useQueryClient();
  const capacity = useNodeCapacity(node.id);
  const test = useTestNode(node.id);
  const [lastResult, setLastResult] = useState<TestNodeResult | null>(null);

  function runTest() {
    test.mutate(undefined, {
      onSuccess: (result) => {
        setLastResult(result);
        // `useTestNode` already refreshes this node's own detail and capacity; the list this
        // page renders from is a separate cache entry, so it is invalidated here too, or the
        // status pill and driver version would keep showing what was true before the test.
        void queryClient.invalidateQueries({ queryKey: queryKeys.nodes.all });
      },
      onError: (cause: unknown) =>
        toast.create({
          title: "Couldn't reach that node",
          description: errorMessage(cause),
          type: 'error',
        }),
    });
  }

  const deleteReason =
    node.serverCount > 0
      ? `${node.serverCount} ${node.serverCount === 1 ? 'server lives' : 'servers live'} on this node. Move or delete them first.`
      : undefined;

  return (
    <li className="flex flex-col gap-5 rounded-md border border-separator-strong bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-sm bg-fill-tertiary text-label-secondary">
            <Cpu aria-hidden className="size-5" />
          </span>
          <div className="min-w-0">
            <p className="truncate font-sans text-body font-semibold text-label">{node.name}</p>
            <p className="truncate text-footnote text-label-secondary">
              {DRIVER_LABEL[node.driver]} · {node.serverCount}{' '}
              {node.serverCount === 1 ? 'server' : 'servers'}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <NodeStatusPill status={node.status} />
          <Menu
            onSelect={({ value }) => {
              if (value === 'edit') onEdit();
              else if (value === 'delete' && !deleteReason) onDelete();
            }}
          >
            <MenuTrigger asChild>
              <Button
                aria-label={`Actions for ${node.name}`}
                className="hit-target size-9 shrink-0 text-label-tertiary hover:text-label"
                size="icon-md"
                variant="ghost"
              >
                <MoreVertical aria-hidden />
              </Button>
            </MenuTrigger>
            <MenuContent className="w-48">
              <MenuItem value="edit">
                <Pencil aria-hidden />
                Edit node
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={Boolean(deleteReason)}
                title={deleteReason}
                value="delete"
                variant="destructive"
              >
                <Trash aria-hidden />
                Remove node
              </MenuItem>
            </MenuContent>
          </Menu>
        </div>
      </div>

      {node.description ? (
        <p className="text-subhead text-label-secondary">{node.description}</p>
      ) : null}

      <div className="grid gap-5 border-t border-separator pt-5 sm:grid-cols-3">
        <CapacityBar
          allocated={capacity.data?.memoryAllocatedMb ?? 0}
          format={formatMegabytes}
          isLoading={capacity.isPending}
          label="Memory"
          total={capacity.data?.memoryTotalMb ?? node.memoryTotalMb}
          unavailable={
            capacity.isError ? "Couldn't read live memory usage from this node." : undefined
          }
          used={capacity.data?.memoryUsedMb ?? 0}
        />
        <CapacityBar
          allocated={capacity.data?.diskAllocatedMb ?? 0}
          format={formatMegabytes}
          isLoading={capacity.isPending}
          label="Disk"
          total={capacity.data?.diskTotalMb ?? node.diskTotalMb}
          unavailable={
            capacity.isError ? "Couldn't read live disk usage from this node." : undefined
          }
          used={capacity.data?.diskUsedMb ?? 0}
        />
        <CapacityBar
          allocated={capacity.data?.portsUsed ?? 0}
          format={(value) => `${Math.round(value)}`}
          isLoading={capacity.isPending}
          label="Ports"
          total={capacity.data?.portsTotal ?? node.portRangeEnd - node.portRangeStart + 1}
          unavailable={
            capacity.isError ? "Couldn't read live port usage from this node." : undefined
          }
          used={capacity.data?.portsUsed ?? 0}
          warnAt={0.9}
        />
      </div>

      <dl className="grid gap-x-6 gap-y-2 border-t border-separator pt-5 text-footnote sm:grid-cols-2 lg:grid-cols-4">
        <div className="min-w-0">
          <dt className="text-caption text-label-tertiary">Endpoint</dt>
          <dd className="truncate font-mono text-label-secondary" title={node.endpoint}>
            {node.endpoint}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-caption text-label-tertiary">Public host</dt>
          <dd className="truncate font-mono text-label-secondary">{node.publicHost}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-caption text-label-tertiary">Port range</dt>
          <dd className="tabular font-mono text-label-secondary">
            {node.portRangeStart}–{node.portRangeEnd}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-caption text-label-tertiary">Driver version</dt>
          <dd className="truncate font-mono text-label-secondary">
            {node.driverVersion ?? 'Unknown until tested'}
          </dd>
        </div>
        <div className="min-w-0 sm:col-span-2 lg:col-span-1">
          <dt className="text-caption text-label-tertiary">Last seen</dt>
          <dd
            className="text-label-secondary"
            title={node.lastSeenAt ? new Date(node.lastSeenAt).toLocaleString() : undefined}
          >
            {node.lastSeenAt ? formatRelativeTime(node.lastSeenAt) : 'Never'}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-caption text-label-tertiary">Overcommit</dt>
          <dd className="tabular font-mono text-label-secondary">{node.overcommitRatio}×</dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          className={cn(ACTION, 'px-4')}
          isLoading={test.isPending}
          onClick={runTest}
          variant="outline"
        >
          <Reload aria-hidden />
          Test connection
        </Button>
      </div>

      {lastResult ? <TestResultPanel result={lastResult} /> : null}
    </li>
  );
}

// ---------------------------------------------------------------------------------------

export function NodesPage() {
  const nodes = useNodes();
  const create = useCreateNode();
  const update = useUpdateNode();
  const remove = useDeleteNode();

  const [showForm, setShowForm] = useState(false);
  const [editingNode, setEditingNode] = useState<Node | null>(null);
  const [deletingNode, setDeletingNode] = useState<Node | null>(null);
  const [formValue, setFormValue] = useState<NodeFormValue>(defaultNodeFormValue());
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const rows = nodes.data?.data ?? [];
  const mode = editingNode ? 'edit' : 'create';
  const localErrors = validateNodeForm(formValue);
  const valid = Object.keys(localErrors).length === 0;
  const dirty =
    mode === 'create' ||
    (editingNode !== null &&
      Object.keys(buildUpdateNodeRequest(formValue, editingNode)).length > 0);
  const pending = create.isPending || update.isPending;

  function openCreate() {
    setEditingNode(null);
    setFormValue(defaultNodeFormValue());
    setFormErrors({});
    setShowForm(true);
  }

  function openEdit(node: Node) {
    setEditingNode(node);
    setFormValue(nodeFormValueFromNode(node));
    setFormErrors({});
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setEditingNode(null);
    setFormErrors({});
  }

  function submitForm() {
    if (!valid) return;

    if (editingNode) {
      const patch = buildUpdateNodeRequest(formValue, editingNode);
      if (Object.keys(patch).length === 0) return;
      update.mutate(
        { nodeId: editingNode.id, patch },
        {
          onSuccess: (node) => {
            closeForm();
            toast.create({ title: `${node.name} saved`, type: 'success' });
          },
          onError: (cause: unknown) => {
            toast.create({
              title: "Couldn't save the node",
              description: errorMessage(cause),
              type: 'error',
            });
          },
        },
      );
    } else {
      create.mutate(buildCreateNodeRequest(formValue), {
        onSuccess: (node) => {
          closeForm();
          toast.create({ title: `${node.name} added`, type: 'success' });
        },
        onError: (cause: unknown) => {
          toast.create({
            title: "Couldn't add the node",
            description: errorMessage(cause),
            type: 'error',
          });
        },
      });
    }
    setFormErrors({});
  }

  return (
    <>
      <PageHeader
        actions={
          <PageAction onClick={openCreate}>
            <Plus aria-hidden />
            Add node
          </PageAction>
        }
        description="Hosts that run game servers, and the capacity remaining on each."
        title="Nodes"
      />

      <PageBody>
        {nodes.isPending ? (
          <div aria-busy="true" className="flex flex-col gap-4">
            <Skeleton className="h-64 rounded-md" />
            <Skeleton className="h-64 rounded-md" />
            <span aria-live="polite" className="sr-only" role="status">
              Loading nodes
            </span>
          </div>
        ) : null}

        {nodes.isError ? (
          <ErrorState
            error={nodes.error}
            isRetrying={nodes.isFetching}
            onRetry={() => void nodes.refetch()}
            title="Couldn’t load nodes"
          />
        ) : null}

        {nodes.isSuccess && rows.length === 0 ? (
          <EmptyState
            action={{ label: 'Add your first node', onClick: openCreate }}
            description="A node is a machine that runs game servers. Add one before creating a server."
            icon={<ServerIcon />}
            title="No nodes yet"
          />
        ) : null}

        {nodes.isSuccess && rows.length > 0 ? (
          <ul className="flex flex-col gap-5">
            {rows.map((node) => (
              <NodeCard
                key={node.id}
                node={node}
                onDelete={() => setDeletingNode(node)}
                onEdit={() => openEdit(node)}
              />
            ))}
          </ul>
        ) : null}
      </PageBody>

      {/* -------------------------------------------------------------- Create / edit */}
      <Dialog onOpenChange={({ open }) => (open ? undefined : closeForm())} open={showForm}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle className="font-sans text-title-3 font-semibold">
              {editingNode ? `Edit ${editingNode.name}` : 'Add a node'}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <NodeForm
              fieldErrors={formErrors}
              formId="node-form"
              onChange={setFormValue}
              onSubmit={(event) => {
                event.preventDefault();
                submitForm();
              }}
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
              form="node-form"
              isLoading={pending}
              type="submit"
            >
              {editingNode ? 'Save changes' : 'Add node'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ------------------------------------------------------------------- Delete */}
      <AlertDialog
        onOpenChange={({ open }) => (open ? undefined : setDeletingNode(null))}
        open={deletingNode !== null}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-sans text-title-3 font-semibold">
              Remove {deletingNode?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Platter stops managing this host. Nothing on the machine itself is touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deletingNode && deletingNode.serverCount > 0 ? (
            <AlertDialogBody className="text-subhead text-label-secondary">
              {deletingNode.serverCount} {deletingNode.serverCount === 1 ? 'server' : 'servers'}{' '}
              still {deletingNode.serverCount === 1 ? 'lives' : 'live'} here. Move or delete{' '}
              {deletingNode.serverCount === 1 ? 'it' : 'them'} first — Platter will not remove a
              node out from under a running server.
            </AlertDialogBody>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel className={ACTION}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={ACTION}
              disabled={Boolean(deletingNode && deletingNode.serverCount > 0)}
              isLoading={remove.isPending}
              onClick={() => {
                if (!deletingNode) return;
                remove.mutate(deletingNode.id, {
                  onSuccess: () => {
                    toast.create({ title: `Removed ${deletingNode.name}`, type: 'success' });
                    setDeletingNode(null);
                  },
                  onError: (cause: unknown) => {
                    toast.create({
                      title: "Couldn't remove the node",
                      description: errorMessage(cause),
                      type: 'error',
                    });
                  },
                });
              }}
              variant="destructive"
            >
              Remove node
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
