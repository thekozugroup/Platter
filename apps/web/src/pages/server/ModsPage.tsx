import { useState } from 'react';
import { InstalledMods } from '@/components/mods/installed-mods';
import { ModDetailSheet } from '@/components/mods/mod-detail-sheet';
import { ModSearch } from '@/components/mods/mod-search';
import { ProposalQueue } from '@/components/mods/proposal-review';
import { PageBody } from '@/components/layout/page-header';
import type { ModSource } from '@/hooks';
import { useInstalledMods } from '@/hooks';
import { useServerScope } from '@/pages/server/ServerLayout';

/**
 * Mods and plugins for one server.
 *
 * Three stacked sections rather than a widget that hides two of them: the review queue first,
 * because a proposal is somebody waiting on you; then the registry search; then what is on
 * disk. The order is the order of urgency, and the vertical rhythm is the design language's
 * — this screen is airy on purpose.
 *
 * There is no install control anywhere on this page. Search sends a mod for review, review
 * approves it, and approval is the only thing that writes a file. See
 * `apps/api/src/routes/mods.ts` for why there is no endpoint to shortcut that.
 */

/**
 * The server's concrete Minecraft version, or null when it tracks a moving alias.
 *
 * Mirrors `buildModContext` in `apps/api/src/services/mods.ts`: `LATEST` and `SNAPSHOT` are
 * aliases with no knowable version, and the honest answer for them is null. Used here only for
 * display and for the soft compatibility warning on a card — the API remains the authority on
 * what this server can actually load, and its `incompatibleReason` is what the detail sheet
 * shows.
 */
function concreteGameVersion(variables: Readonly<Record<string, string>>): string | null {
  const raw = (variables.VERSION ?? '').trim();
  if (raw.length === 0) return null;
  const upper = raw.toUpperCase();
  return upper === 'LATEST' || upper === 'SNAPSHOT' ? null : raw;
}

interface SheetTarget {
  source: ModSource;
  project: string;
  title: string;
}

export function ModsPage() {
  const { server } = useServerScope();
  const installedQuery = useInstalledMods(server.id);
  const [target, setTarget] = useState<SheetTarget | null>(null);

  const gameVersion = concreteGameVersion(server.variables);
  const serverType = (server.variables.TYPE ?? '').trim();

  return (
    <PageBody>
      <div className="flex flex-col gap-16 sm:gap-24">
        <section aria-labelledby="mods-review" className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <h2 className="text-title-2 text-label" id="mods-review">
              Waiting for review
            </h2>
            <p className="max-w-prose text-subhead text-label-secondary">
              An agent can suggest a mod. Only a person can install one.
            </p>
          </div>
          <ProposalQueue serverId={server.id} />
        </section>

        <section aria-labelledby="mods-browse" className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <h2 className="text-title-2 text-label" id="mods-browse">
              Add a mod
            </h2>
            <p className="max-w-prose text-subhead text-label-secondary">
              Search Modrinth
              {(installedQuery.data?.sources ?? []).includes('curseforge')
                ? ' and CurseForge'
                : ''}
              {serverType === '' ? '' : `, filtered to what a ${serverType} server loads`}.
              Picking one sends it to the queue above; it is not installed until it is
              approved.
            </p>
          </div>
          <ModSearch
            gameVersion={gameVersion}
            installed={installedQuery.data?.data ?? []}
            onOpenMod={(mod) =>
              setTarget({ source: mod.source, project: mod.slug, title: mod.title })
            }
            serverId={server.id}
            sources={installedQuery.data?.sources ?? []}
          />
        </section>

        <section aria-labelledby="mods-installed" className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <h2 className="text-title-2 text-label" id="mods-installed">
              Installed
            </h2>
            <p className="max-w-prose text-subhead text-label-secondary">
              Every jar Platter put on this server, with the checksum it verified and who
              approved it.
            </p>
          </div>
          <InstalledMods
            onOpenMod={(mod) =>
              setTarget({ source: mod.source, project: mod.slug, title: mod.title })
            }
            serverId={server.id}
          />
        </section>
      </div>

      <ModDetailSheet
        onClose={() => setTarget(null)}
        serverId={server.id}
        target={target}
      />
    </PageBody>
  );
}
