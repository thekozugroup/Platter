'use client';

import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog, DialogHeader } from '@astryxdesign/core/Dialog';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { HStack } from '@astryxdesign/core/HStack';
import { List, ListItem } from '@astryxdesign/core/List';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useToast } from '@astryxdesign/core/Toast';
import { Token } from '@astryxdesign/core/Token';
import { VStack } from '@astryxdesign/core/VStack';
import type { ServerStatus } from '@platter/shared';
import { useState, useTransition } from 'react';
import {
  installModAction,
  type ModPreview,
  type ModSearchHit,
  previewModAction,
  removeModAction,
  searchModsAction,
} from '@/lib/mod-actions';

export interface InstalledMod {
  id: string;
  name: string;
  provider: string;
  slug: string | null;
  version: string | null;
  isDependency: boolean;
  installedBy: string;
  fileSize: number | null;
}

/**
 * Mod management.
 *
 * The flow is search → preview → install, and the preview step is not skippable. It is the only
 * place that resolves a real downloadable file and checks it against what is already on the
 * server, and it is what stops someone installing a client-only mod, a mod for the wrong loader,
 * or something that conflicts with what they already have.
 *
 * The install button stays disabled until the preview comes back clean. That is a deliberate bit
 * of friction — one extra second, in exchange for not spending an evening working out why the
 * server stopped booting.
 */
export function ModsPanel({
  serverId,
  serverStatus,
  noun,
  curseforgeEnabled,
  installed,
}: {
  serverId: string;
  serverStatus: ServerStatus;
  noun: string;
  curseforgeEnabled: boolean;
  installed: InstalledMod[];
}) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<ModSearchHit[] | null>(null);
  const [degraded, setDegraded] = useState<{ provider: string; reason: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<{ ref: string; data: ModPreview } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [pending, startTransition] = useTransition();
  const showToast = useToast();

  const search = async () => {
    if (query.trim().length === 0) {
      return;
    }
    setSearching(true);
    const found = await searchModsAction(serverId, query.trim());
    setSearching(false);
    if (!found.ok) {
      showToast({ body: found.message ?? 'Search failed.', type: 'error' });
      return;
    }
    setHits(found.hits);
    setDegraded(found.degraded);
  };

  const openPreview = async (hit: ModSearchHit) => {
    const ref = `${hit.provider}:${hit.slug ?? hit.projectId}`;
    setPreviewing(true);
    setPreview({ ref, data: { ok: true, title: hit.title } });
    const data = await previewModAction(serverId, ref);
    setPreviewing(false);
    setPreview({ ref, data });
  };

  const report = preview?.data.report;
  const canInstall = Boolean(report && report.blockers.length === 0 && !previewing);

  return (
    <VStack gap={5}>
      {serverStatus === 'running' ? (
        <Banner
          status="info"
          title="Changes need a restart"
          description={`Installing or removing ${noun} takes effect the next time the server starts.`}
          isDismissable
        />
      ) : null}

      <VStack gap={3}>
        <HStack gap={2} align="end">
          <TextInput
            label={`Search for ${noun}`}
            value={query}
            onChange={setQuery}
            placeholder="performance, chunk loading, claims, minimap…"
            width="100%"
            onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void search();
              }
            }}
          />
          <Button
            label="Search"
            variant="primary"
            isLoading={searching}
            isDisabled={query.trim().length === 0}
            onClick={() => void search()}
          />
        </HStack>

        {!curseforgeEnabled ? (
          <Text type="supporting">
            Searching Modrinth only. Set CURSEFORGE_API_KEY to include CurseForge.
          </Text>
        ) : null}

        {degraded.length > 0 ? (
          <Text type="supporting">
            Could not reach {degraded.map((d) => `${d.provider} (${d.reason})`).join(', ')}.
          </Text>
        ) : null}
      </VStack>

      {hits !== null ? (
        hits.length === 0 ? (
          <EmptyState
            title="Nothing matched"
            description={`No ${noun} for this server's loader and Minecraft version match "${query}".`}
            isCompact
          />
        ) : (
          <List density="compact" hasDividers header={<Text weight="medium">Results</Text>}>
            {hits.map((hit) => (
              <ListItem
                key={`${hit.provider}:${hit.projectId}`}
                label={hit.title}
                description={hit.summary ?? 'No description.'}
                endContent={
                  <HStack gap={2} align="center">
                    <Text type="supporting">{hit.downloads.toLocaleString()} downloads</Text>
                    {hit.serverSide === 'unsupported' ? (
                      <Token label="Client only" size="sm" color="orange" />
                    ) : null}
                    <Button label="Review" size="sm" onClick={() => void openPreview(hit)} />
                  </HStack>
                }
              />
            ))}
          </List>
        )
      ) : null}

      <VStack gap={3}>
        <Text weight="medium">Installed ({installed.length})</Text>
        {installed.length === 0 ? (
          <Text type="supporting">Nothing installed yet.</Text>
        ) : (
          <List density="compact" hasDividers>
            {installed.map((mod) => (
              <ListItem
                key={mod.id}
                label={`${mod.name}${mod.version ? ` ${mod.version}` : ''}`}
                description={`${mod.provider}${mod.slug ? ` · ${mod.slug}` : ''}`}
                endContent={
                  <HStack gap={2} align="center">
                    {mod.isDependency ? <Badge label="Dependency" variant="neutral" /> : null}
                    {mod.installedBy === 'ai' ? (
                      <Token label="AI" size="sm" color="purple" />
                    ) : null}
                    <Button
                      label="Remove"
                      variant="ghost"
                      size="sm"
                      isDisabled={pending}
                      onClick={() => {
                        startTransition(async () => {
                          const outcome = await removeModAction(serverId, mod.id);
                          showToast({
                            body: outcome.message,
                            type: outcome.ok ? 'info' : 'error',
                          });
                        });
                      }}
                    />
                  </HStack>
                }
              />
            ))}
          </List>
        )}
      </VStack>

      <Dialog
        isOpen={preview !== null}
        onOpenChange={(open) => !open && setPreview(null)}
        purpose="form"
        width={560}
      >
        <DialogHeader
          title={preview?.data.title ?? 'Checking…'}
          subtitle={preview?.data.versionLabel ?? undefined}
          onOpenChange={(open) => !open && setPreview(null)}
        />
        <VStack padding={4} gap={4}>
          {previewing ? (
            <HStack gap={2} align="center">
              <Spinner />
              <Text type="supporting">Resolving a version and checking compatibility…</Text>
            </HStack>
          ) : preview?.data.ok === false ? (
            <Banner
              status="error"
              title="Could not check this"
              description={preview.data.message ?? ''}
            />
          ) : report ? (
            <VStack gap={4}>
              <HStack gap={2} align="center">
                <Badge
                  label={verdictLabel(report.verdict)}
                  variant={verdictVariant(report.verdict)}
                />
                <Text type="supporting">{report.score}/100</Text>
              </HStack>

              {report.blockers.length > 0 ? (
                <VStack gap={2}>
                  {report.blockers.map((finding) => (
                    <Banner
                      key={finding.code}
                      status="error"
                      title={finding.title}
                      description={finding.detail}
                    />
                  ))}
                </VStack>
              ) : null}

              {report.warnings.length > 0 ? (
                <VStack gap={2}>
                  {report.warnings.map((finding) => (
                    <Banner
                      key={finding.code}
                      status="warning"
                      title={finding.title}
                      description={finding.detail}
                    />
                  ))}
                </VStack>
              ) : null}

              {preview?.data.dependencies && preview.data.dependencies.length > 0 ? (
                <VStack gap={1}>
                  <Text weight="medium">Also installs</Text>
                  {preview.data.dependencies.map((dep) => (
                    <Text key={dep.title} type="supporting">
                      • {dep.title} {dep.versionLabel ?? ''}
                    </Text>
                  ))}
                </VStack>
              ) : null}

              {report.notes.length > 0 ? (
                <VStack gap={1}>
                  {report.notes.map((finding) => (
                    <Text key={finding.code} type="supporting">
                      {finding.detail}
                    </Text>
                  ))}
                </VStack>
              ) : null}

              <Text type="supporting">
                {preview?.data.totalBytes
                  ? `${formatBytes(preview.data.totalBytes)} to download. `
                  : ''}
                Platter backs the server up before installing.
              </Text>
            </VStack>
          ) : null}

          <HStack gap={2} justify="end">
            <Button label="Cancel" variant="ghost" onClick={() => setPreview(null)} />
            <Button
              label="Install"
              variant="primary"
              isDisabled={!canInstall || pending}
              isLoading={pending}
              onClick={() => {
                const ref = preview?.ref;
                if (!ref) {
                  return;
                }
                startTransition(async () => {
                  const outcome = await installModAction(serverId, ref);
                  setPreview(null);
                  showToast({ body: outcome.message, type: outcome.ok ? 'info' : 'error' });
                });
              }}
            />
          </HStack>
        </VStack>
      </Dialog>
    </VStack>
  );
}

function verdictLabel(verdict: string): string {
  switch (verdict) {
    case 'compatible':
      return 'Compatible';
    case 'compatible_with_warnings':
      return 'Works, with caveats';
    case 'incompatible':
      return 'Will not work';
    default:
      return 'Unknown';
  }
}

function verdictVariant(verdict: string): 'success' | 'warning' | 'error' | 'neutral' {
  switch (verdict) {
    case 'compatible':
      return 'success';
    case 'compatible_with_warnings':
      return 'warning';
    case 'incompatible':
      return 'error';
    default:
      return 'neutral';
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}
