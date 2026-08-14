import { useState } from 'react';
import { hueFromString, initials } from '@platter/shared';
import { GameIcon } from '@/components/common/game-icon';
import type { ModSummary } from '@/hooks';
import { cn } from '@/lib/utils';

/**
 * One mod, as a search result.
 *
 * The card exists to answer a single question — *is this the thing I want, and can this
 * server actually run it?* — so incompatibility is stated in words on the face of the card
 * rather than left for the reader to infer from a version list. The API already filters
 * search by the server's loader and version, but `gameVersion=any` is an explicit escape
 * hatch (see `routes/mods.ts`), and results from it are exactly the ones that need the
 * warning.
 *
 * Colour comes from the project's own artwork and nothing else; the chrome stays monochrome.
 */

// ---------------------------------------------------------------------------------------
// Icon
// ---------------------------------------------------------------------------------------

const ICON_SIZE = {
  sm: 'size-8 text-caption-2',
  md: 'size-11 text-subhead',
  lg: 'size-16 text-title-3',
} as const;

export type ModIconSize = keyof typeof ICON_SIZE;

export interface ModIconProps {
  iconUrl: string | null;
  /** Used for the fallback monogram and, when `label` is set, the accessible name. */
  title: string;
  size?: ModIconSize;
  /**
   * Set only when the mod's name is not already written beside the icon. Otherwise the icon
   * is decorative and stays out of the accessibility tree.
   */
  labelled?: boolean;
  className?: string;
}

/**
 * A project's own artwork, with a deterministic monogram behind it.
 *
 * Registry icons are remote, and a self-hosted panel on a locked-down network frequently
 * cannot reach them. A broken-image glyph in a grid of forty results looks like the product
 * is broken, so a failed load falls back to the mark `GameIcon` draws — the component
 * itself, not a copy of its formula.
 *
 * That matters twice over. Hand-rolling `hsl(hue 46% 48%)` under white text is exactly the
 * bug `GameIcon` was rewritten to fix: lightness in HSL is not perceptual, so nine of the
 * eighteen mods this panel ships against — Fabric API at 2.58:1, WorldEdit 2.54:1, Citizens
 * 2.24:1 — printed their monogram below AA. `GameIcon.legibleLightness` solves the lightness
 * per hue instead. And both marks are content imagery, which DESIGN §4 keeps square: the
 * 6px `rounded-xs` here was the chrome's radius on artwork, the one contrast the system rests
 * on.
 */
export function ModIcon({
  iconUrl,
  title,
  size = 'md',
  labelled = false,
  className,
}: ModIconProps) {
  const [failed, setFailed] = useState(false);
  const showImage = iconUrl !== null && iconUrl.length > 0 && !failed;

  if (showImage) {
    const naming = labelled
      ? { role: 'img' as const, 'aria-label': title }
      : { 'aria-hidden': true };
    return (
      <img
        alt=""
        className={cn('shrink-0 bg-fill-tertiary object-cover', ICON_SIZE[size], className)}
        loading="lazy"
        onError={() => setFailed(true)}
        src={iconUrl}
        {...naming}
      />
    );
  }

  return (
    <GameIcon
      // The mod's own size ramp, laid over `GameIcon`'s: `sm` is 32px here and 28px there,
      // and the type scale differs with it.
      className={cn(ICON_SIZE[size], className)}
      hue={hueFromString(title)}
      monogram={initials(title)}
      name={title}
      size={size === 'sm' ? 'sm' : size === 'lg' ? 'lg' : 'md'}
      {...(labelled ? { label: title } : {})}
    />
  );
}

// ---------------------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------------------

export interface ModCompatibility {
  ok: boolean;
  /** Names the constraint that failed, in a sentence. Null when the mod fits. */
  reason: string | null;
}

/** `1.21.1, 1.21 and 6 more` — enough to judge, short enough to read. */
function listVersions(versions: readonly string[], limit = 3): string {
  const head = versions.slice(0, limit);
  const rest = versions.length - head.length;
  const joined = head.join(', ');
  return rest > 0 ? `${joined} and ${rest} more` : joined;
}

/**
 * Whether this server can load this project, judged from the search hit alone.
 *
 * Deliberately narrow. The API filters search by loader already, and `GET /mods/:source/:project`
 * returns the authoritative `incompatibleReason` — duplicating the loader table
 * (`apps/api/src/mods/resolve.ts`'s `LOADERS_BY_TYPE`) on the client would create two copies
 * of a rule that has to stay identical. So this only checks what the client can know for
 * certain: the declared server side, and the game version when the server has a concrete one.
 */
export function modCompatibility(
  mod: Pick<ModSummary, 'serverSide' | 'gameVersions' | 'projectType'>,
  gameVersion: string | null,
): ModCompatibility {
  if (mod.serverSide === 'unsupported') {
    return {
      ok: false,
      reason: 'Client-side only. Installing it on the server would do nothing.',
    };
  }

  if (
    gameVersion !== null &&
    mod.gameVersions.length > 0 &&
    !mod.gameVersions.includes(gameVersion)
  ) {
    return {
      ok: false,
      reason: `Built for ${listVersions(mod.gameVersions)}. This server runs ${gameVersion}.`,
    };
  }

  if (mod.projectType === 'modpack') {
    return {
      ok: false,
      reason: 'This is a modpack, not a single mod. Change the server type to install one.',
    };
  }

  return { ok: true, reason: null };
}

// ---------------------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------------------

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** `2.4M` on the card, the exact figure in the tooltip. */
export function formatDownloads(downloads: number): string {
  return compactNumber.format(downloads);
}

/** Shared with the installed list so a card and a row never drift into two materials. */
export const modSurface = cn(
  'relative rounded-md border border-separator-strong bg-surface text-start',
  'after:pointer-events-none after:absolute after:inset-0 after:rounded-md',
  'after:shadow-3 after:opacity-0 after:transition-opacity after:duration-150 after:ease-standard',
);

export interface ModCardProps {
  mod: ModSummary;
  /** The server's concrete Minecraft version, or null when it tracks `LATEST`/`SNAPSHOT`. */
  gameVersion: string | null;
  /** The version already on disk, when this project is installed. */
  installedVersion?: string | null;
  onOpen: (mod: ModSummary) => void;
  className?: string;
}

export function ModCard({ mod, gameVersion, installedVersion, onOpen, className }: ModCardProps) {
  const compatibility = modCompatibility(mod, gameVersion);
  const categories = mod.categories.slice(0, 3);
  const extraCategories = mod.categories.length - categories.length;

  return (
    <button
      className={cn(
        'group flex w-full flex-col gap-3 p-4 transition-[translate,opacity] duration-150 ease-standard',
        modSurface,
        'hover:-translate-y-0.5 hover:after:opacity-100',
        'active:translate-y-0',
        'motion-reduce:translate-y-0! motion-reduce:transition-none!',
        className,
      )}
      onClick={() => onOpen(mod)}
      type="button"
    >
      <span className="flex w-full items-start gap-3">
        <ModIcon iconUrl={mod.iconUrl} size="md" title={mod.title} />

        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-baseline gap-2">
            {/* Sans, not the pixel face: this is a card title, not a page heading. */}
            <span
              className="min-w-0 flex-1 truncate font-sans text-body font-semibold tracking-title text-label"
              title={mod.title}
            >
              {mod.title}
            </span>
            {installedVersion ? (
              <span className="shrink-0 rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption-2 font-medium text-label-secondary">
                Installed
              </span>
            ) : null}
          </span>

          <span className="mt-0.5 truncate text-footnote text-label-secondary">
            {mod.author ?? 'Author not published'}
            <span aria-hidden> · </span>
            <span
              className="tabular"
              title={`${mod.downloads.toLocaleString()} downloads on ${mod.source === 'modrinth' ? 'Modrinth' : 'CurseForge'}`}
            >
              {formatDownloads(mod.downloads)} downloads
            </span>
          </span>
        </span>
      </span>

      <span className="line-clamp-2 text-footnote leading-snug text-label-secondary">
        {mod.summary}
      </span>

      {categories.length > 0 ? (
        <span className="flex flex-wrap items-center gap-1.5">
          {categories.map((category) => (
            <span
              className="rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption-2 font-medium text-label-tertiary"
              key={category}
            >
              {category}
            </span>
          ))}
          {extraCategories > 0 ? (
            <span className="text-caption-2 text-label-quaternary">+{extraCategories}</span>
          ) : null}
        </span>
      ) : null}

      {/*
        The incompatibility line is text, never a colour swap alone — and it names the
        constraint that failed rather than saying "incompatible".
      */}
      {compatibility.reason ? (
        <span className="flex w-full items-start gap-1.5 rounded-sm bg-warning-subtle px-2.5 py-1.5 text-caption leading-snug text-warning">
          <span className="font-medium">Won’t run here.</span>
          <span className="min-w-0 flex-1">{compatibility.reason}</span>
        </span>
      ) : null}
    </button>
  );
}

/** The card's shape while a page of results loads. */
export function ModCardSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn(modSurface, 'flex flex-col gap-3 p-4', className)}>
      <div className="flex items-start gap-3">
        <div className="skeleton size-11 rounded-xs" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
          <div className="skeleton h-4 w-40 max-w-full rounded-xs" />
          <div className="skeleton h-3 w-28 max-w-full rounded-xs" />
        </div>
      </div>
      <div className="skeleton h-3 w-full rounded-xs" />
      <div className="skeleton h-3 w-3/4 rounded-xs" />
    </div>
  );
}
