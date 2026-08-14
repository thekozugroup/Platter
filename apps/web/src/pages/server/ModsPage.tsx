import { useRef, useState } from 'react';
import { InstalledMods } from '@/components/mods/installed-mods';
import { ModDetailSheet } from '@/components/mods/mod-detail-sheet';
import { ModSearch } from '@/components/mods/mod-search';
import { ProposalQueue, useProposalQueue } from '@/components/mods/proposal-review';
import { PageBody } from '@/components/layout/page-header';
import { minecraftTypeLabel } from '@/components/servers/minecraft-type-picker';
import type { ModSource } from '@/hooks';
import { useInstalledMods } from '@/hooks';
import { useServerScope } from '@/pages/server/ServerLayout';

/**
 * Mods for one server.
 *
 * There are two ways a mod gets here, and the page is laid out so which one you are in is
 * never in doubt.
 *
 * **You found it.** You search, you open it, you press add. No form, no queue, no waiting on
 * yourself — the old screen made a person write a justification and file a request they then
 * had to approve, which is a review workflow pointed at the wrong human. Search leads the page,
 * because that is what somebody opening this tab almost always came to do.
 *
 * **Something suggested it.** An assistant over MCP can propose a mod and cannot install one
 * (`apps/api/src/routes/proposals.ts` — `ai.use` proposes, `files.write` installs). That is a
 * decision waiting on a person, so when one exists it takes the top of the page; when none
 * does, the section falls to the bottom and explains itself rather than sitting empty above
 * the thing you came for.
 *
 * The vertical rhythm is the design language's — this screen is airy on purpose.
 */

/**
 * The server's concrete Minecraft version, or null when it tracks a moving alias.
 *
 * Mirrors `buildModContext` in `apps/api/src/services/mods.ts`: `LATEST` and `SNAPSHOT` are
 * aliases with no knowable version, and the honest answer for them is null. Used here only for
 * display and for the soft compatibility warning on a card — the API remains the authority on
 * what this server can actually run, and its `incompatibleReason` is what the detail sheet
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
  const { server, status } = useServerScope();
  const installedQuery = useInstalledMods(server.id);
  const { proposals } = useProposalQueue(server.id);
  const [target, setTarget] = useState<SheetTarget | null>(null);
  /** Set when the open sheet actually put something on disk, read when it closes. */
  const added = useRef(false);

  const gameVersion = concreteGameVersion(server.variables);
  const serverType = minecraftTypeLabel((server.variables.TYPE ?? '').trim());
  const hasSuggestions = proposals.length > 0;

  const suggestions = (
    <section aria-labelledby="mods-suggested" className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <h2 className="text-title-2 text-label" id="mods-suggested">
          Suggested for you
        </h2>
        <p className="max-w-prose text-subhead text-label-secondary">
          {hasSuggestions
            ? 'An assistant picked these out. Nothing is on the server until you say so.'
            : 'An assistant connected over MCP can suggest a mod. It cannot put one on the server — that is always your call.'}
        </p>
      </div>
      <ProposalQueue serverId={server.id} serverName={server.name} />
    </section>
  );

  return (
    <PageBody>
      <div className="flex flex-col gap-16 sm:gap-24">
        {hasSuggestions ? suggestions : null}

        <section aria-labelledby="mods-browse" className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <h2 className="text-title-2 text-label" id="mods-browse">
              Add a mod
            </h2>
            <p className="max-w-prose text-subhead text-label-secondary">
              Search Modrinth
              {(installedQuery.data?.sources ?? []).includes('curseforge') ? ' and CurseForge' : ''}
              {serverType === '' ? '' : `, narrowed to what a ${serverType} server runs`}. Open one
              to read what it does, then add it.
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
              On this server
            </h2>
            <p className="max-w-prose text-subhead text-label-secondary">
              Every mod Platter put on {server.name}, when it went on, and who added it.
            </p>
          </div>
          <InstalledMods
            onOpenMod={(mod) =>
              setTarget({ source: mod.source, project: mod.slug, title: mod.title })
            }
            serverId={server.id}
          />
        </section>

        {hasSuggestions ? null : suggestions}
      </div>

      <ModDetailSheet
        onAdded={() => {
          added.current = true;
        }}
        onClose={() => {
          setTarget(null);
          /*
           * The installed list is on this same page, behind the sheet — so the move happens on
           * the way out, not the moment the install lands. While the sheet is open it holds a
           * scroll lock on the body and the page underneath cannot go anywhere; scrolling then
           * would silently do nothing, and the reader would close the sheet to find the screen
           * exactly where they left it and no sign of the thing they just added.
           */
          if (!added.current) return;
          added.current = false;
          document
            .getElementById('mods-installed')
            ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        }}
        serverId={server.id}
        serverName={server.name}
        serverRunning={status === 'running'}
        target={target}
      />
    </PageBody>
  );
}
