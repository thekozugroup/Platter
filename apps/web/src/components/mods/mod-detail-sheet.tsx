import { Fragment, useId, useMemo, useState } from 'react';
import { formatBytes, formatRelativeTime } from '@platter/shared';
import { ExternalLink } from 'pixelarticons/react/ExternalLink.js';
import { ModIcon, formatDownloads } from '@/components/mods/mod-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ErrorState } from '@/components/common/error-state';
import type {
  InstalledMod,
  ModDependency,
  ModDetail,
  ModSource,
  ModVersion,
} from '@/hooks';
import { useCreateProposal, useMod } from '@/hooks';
import { errorMessage } from '@/lib/api-client.js';
import { cn } from '@/lib/utils';

/**
 * Everything about one mod, in a sheet.
 *
 * The completeness is the product requirement, not a nicety: this panel and the proposal
 * review screen are the only places a person gets to decide whether a project is real and
 * maintained or a two-download typosquat, and sending them to a third-party site to find out
 * defeats the point of having a review gate at all. So the body carries the full description,
 * the gallery, the author, the licence, the download count, the source and issue links, every
 * supported version and loader, the version list with its release channels, and the
 * dependencies — and `ModDetailBody` is exported so `proposal-review.tsx` renders exactly the
 * same thing from the snapshot rather than an abridged version of it.
 *
 * There is no install button anywhere in here, and there is no endpoint for one. The only
 * path to a file on disk is a proposal a human approves — see `apps/api/src/routes/mods.ts`.
 */

// ---------------------------------------------------------------------------------------
// Description rendering
// ---------------------------------------------------------------------------------------

/**
 * Registry descriptions are arbitrary text written by strangers, so none of it is ever
 * injected as markup. Modrinth publishes Markdown and CurseForge publishes HTML; the HTML is
 * parsed with `DOMParser` (which neither runs scripts nor fetches subresources) purely to
 * recover its text, and the Markdown gets a small block-level renderer. The result is plain
 * React elements — there is no `dangerouslySetInnerHTML` in this file by design.
 */
function htmlToText(html: string): string {
  if (typeof DOMParser === 'undefined') return html;
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return parsed.body.textContent ?? '';
}

/** Only web links are rendered as links. Anything else stays inert text. */
function safeHref(href: string): string | null {
  try {
    const url = new URL(href, window.location.origin);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const INLINE_PATTERN =
  /`([^`]+)`|\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;

/** Inline code, links, bold and italic. Everything else is left as literal text. */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let index = 0;

  INLINE_PATTERN.lastIndex = 0;
  let match = INLINE_PATTERN.exec(text);
  while (match !== null) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const key = `${keyPrefix}-i${index}`;
    index += 1;

    const [, code, linkText, linkHref, bold, italic] = match;
    if (code !== undefined) {
      nodes.push(
        <code className="rounded-xs bg-fill-tertiary px-1 font-mono text-caption" key={key}>
          {code}
        </code>,
      );
    } else if (linkHref !== undefined) {
      const href = safeHref(linkHref);
      const label = linkText === undefined || linkText.length === 0 ? linkHref : linkText;
      nodes.push(
        href === null ? (
          <Fragment key={key}>{label}</Fragment>
        ) : (
          <a
            className="underline underline-offset-2 hover:text-label"
            href={href}
            key={key}
            rel="noreferrer noopener nofollow"
            target="_blank"
          >
            {label}
          </a>
        ),
      );
    } else if (bold !== undefined) {
      nodes.push(
        <strong className="font-semibold text-label" key={key}>
          {bold}
        </strong>,
      );
    } else if (italic !== undefined) {
      nodes.push(<em key={key}>{italic}</em>);
    }

    cursor = match.index + match[0].length;
    match = INLINE_PATTERN.exec(text);
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'list'; items: string[]; ordered: boolean }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'rule' };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { items: string[]; ordered: boolean } | null = null;
  let fence: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
      paragraph = [];
    }
  };
  const flushList = (): void => {
    if (list !== null) {
      blocks.push({ kind: 'list', items: list.items, ordered: list.ordered });
      list = null;
    }
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trimStart().startsWith('```')) {
      if (fence === null) {
        flushAll();
        fence = [];
      } else {
        blocks.push({ kind: 'code', text: fence.join('\n') });
        fence = null;
      }
      continue;
    }
    if (fence !== null) {
      fence.push(raw);
      continue;
    }

    if (line.trim().length === 0) {
      flushAll();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      flushAll();
      blocks.push({ kind: 'heading', text: heading[2], level: heading[1].length });
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[-*_\s]*$/.test(line)) {
      flushAll();
      blocks.push({ kind: 'rule' });
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote?.[1] !== undefined) {
      flushAll();
      blocks.push({ kind: 'quote', text: quote[1] });
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const item = bullet?.[1] ?? numbered?.[1];
    if (item !== undefined) {
      const ordered = bullet === null;
      flushParagraph();
      if (list === null || list.ordered !== ordered) {
        flushList();
        list = { items: [], ordered };
      }
      list.items.push(item);
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  if (fence !== null) blocks.push({ kind: 'code', text: fence.join('\n') });
  flushAll();
  return blocks;
}

export interface ModDescriptionProps {
  text: string;
  format: ModDetail['descriptionFormat'];
  className?: string;
}

export function ModDescription({ text, format, className }: ModDescriptionProps) {
  const blocks = useMemo(
    () => parseBlocks(format === 'html' ? htmlToText(text) : text),
    [text, format],
  );

  if (blocks.length === 0) {
    return (
      <p className={cn('text-subhead text-label-tertiary', className)}>
        This project publishes no description.
      </p>
    );
  }

  return (
    <div className={cn('flex flex-col gap-3 text-subhead leading-normal text-label-secondary', className)}>
      {blocks.map((block, blockIndex) => {
        const key = `b${blockIndex}`;
        switch (block.kind) {
          case 'heading':
            return (
              // h4+, always: the pixel display face is for page headings and is unreadable here.
              <h4
                className={cn(
                  'mt-2 font-sans font-semibold text-label',
                  block.level <= 2 ? 'text-title-3' : 'text-body',
                )}
                key={key}
              >
                {renderInline(block.text, key)}
              </h4>
            );
          case 'list':
            return block.ordered ? (
              <ol className="ms-5 flex list-decimal flex-col gap-1" key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ol>
            ) : (
              <ul className="ms-5 flex list-disc flex-col gap-1" key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
                ))}
              </ul>
            );
          case 'quote':
            return (
              <blockquote
                className="border-s-2 border-separator-strong ps-3 text-label-tertiary"
                key={key}
              >
                {renderInline(block.text, key)}
              </blockquote>
            );
          case 'code':
            return (
              <pre
                className="overflow-x-auto rounded-sm bg-bg-sunken p-3 font-mono text-caption text-label-secondary"
                key={key}
              >
                <code>{block.text}</code>
              </pre>
            );
          case 'rule':
            return <hr className="border-separator" key={key} />;
          default:
            return <p key={key}>{renderInline(block.text, key)}</p>;
        }
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col gap-3 border-t border-separator pt-5', className)}>
      <h4 className="font-sans text-subhead font-semibold text-label">{title}</h4>
      {children}
    </section>
  );
}

function Chips({ values, empty }: { values: readonly string[]; empty: string }) {
  if (values.length === 0) {
    return <p className="text-caption text-label-tertiary">{empty}</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <span
          className="rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption font-medium text-label-secondary"
          key={value}
        >
          {value}
        </span>
      ))}
    </div>
  );
}

function OutboundLink({ href, children }: { href: string; children: React.ReactNode }) {
  const safe = safeHref(href);
  if (safe === null) return null;
  return (
    <a
      className="inline-flex h-11 items-center gap-1.5 text-subhead text-label-secondary underline underline-offset-2 hover:text-label"
      href={safe}
      rel="noreferrer noopener"
      target="_blank"
    >
      {children}
      <ExternalLink aria-hidden className="size-3.5" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

const CHANNEL_STYLE = {
  release: 'border-pill-border bg-pill text-label-secondary',
  beta: 'border-warning/25 bg-warning-subtle text-warning',
  alpha: 'border-danger/25 bg-danger-subtle text-danger',
} as const;

const CHANNEL_HINT = {
  release: 'Stable, published for general use.',
  beta: 'Pre-release. The author expects bugs.',
  alpha: 'Early build. Expect breakage and data loss.',
} as const;

export function ReleaseChannelBadge({ channel }: { channel: ModVersion['channel'] }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-pill border px-2 py-0.5 text-caption-2 font-medium capitalize',
        CHANNEL_STYLE[channel],
      )}
      title={CHANNEL_HINT[channel]}
    >
      {channel}
    </span>
  );
}

const DEPENDENCY_LABEL = {
  required: 'Required',
  optional: 'Optional',
  incompatible: 'Conflicts with',
  embedded: 'Bundled inside',
} as const;

export function ModDependencyList({
  dependencies,
  className,
}: {
  dependencies: readonly ModDependency[];
  className?: string;
}) {
  if (dependencies.length === 0) {
    return (
      <p className={cn('text-caption text-label-tertiary', className)}>
        This version declares no dependencies.
      </p>
    );
  }

  return (
    <ul className={cn('flex flex-col gap-1.5', className)}>
      {dependencies.map((dependency, index) => (
        <li
          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-label-secondary"
          key={`${dependency.source}-${dependency.projectId ?? 'x'}-${dependency.versionId ?? 'x'}-${index}`}
        >
          <span className="font-medium text-label">{DEPENDENCY_LABEL[dependency.kind]}</span>
          <code className="font-mono text-caption">
            {dependency.fileName ?? dependency.projectId ?? dependency.versionId ?? 'unnamed'}
          </code>
          {dependency.versionId !== null ? (
            <span className="text-label-tertiary">pinned to one version</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const VERSION_PAGE = 5;

export function ModVersionList({
  versions,
  highlightVersionId,
  installedVersionId,
}: {
  versions: readonly ModVersion[];
  highlightVersionId?: string | null;
  installedVersionId?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);

  if (versions.length === 0) {
    return (
      <p className="text-subhead text-label-tertiary">
        No version of this project matches this server’s loader and Minecraft version.
      </p>
    );
  }

  const shown = expanded ? versions : versions.slice(0, VERSION_PAGE);
  const hidden = versions.length - shown.length;

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {shown.map((version) => {
          const isHighlighted = version.versionId === highlightVersionId;
          const isInstalled = version.versionId === installedVersionId;
          return (
            <li
              className={cn(
                'flex flex-col gap-2 rounded-sm border p-3',
                isHighlighted
                  ? 'border-separator-strong bg-bg-sunken'
                  : 'border-separator bg-surface',
              )}
              key={version.versionId}
            >
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-footnote font-medium text-label">
                  {version.versionNumber}
                </code>
                <ReleaseChannelBadge channel={version.channel} />
                {isHighlighted ? (
                  <span className="rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption-2 font-medium text-label">
                    Under review
                  </span>
                ) : null}
                {isInstalled ? (
                  <span className="rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption-2 font-medium text-label-secondary">
                    Installed
                  </span>
                ) : null}
                {version.publishedAt !== null ? (
                  <time
                    className="text-caption text-label-tertiary"
                    dateTime={version.publishedAt}
                    title={new Date(version.publishedAt).toLocaleString()}
                  >
                    {formatRelativeTime(version.publishedAt)}
                  </time>
                ) : null}
              </div>

              <p className="text-caption text-label-tertiary">
                <span className="tabular font-mono">{version.file.filename}</span>
                <span aria-hidden> · </span>
                <span className="tabular">{formatBytes(version.file.sizeBytes)}</span>
                {version.loaders.length > 0 ? (
                  <>
                    <span aria-hidden> · </span>
                    {version.loaders.join(', ')}
                  </>
                ) : null}
                {version.gameVersions.length > 0 ? (
                  <>
                    <span aria-hidden> · </span>
                    Minecraft {version.gameVersions.slice(0, 4).join(', ')}
                    {version.gameVersions.length > 4
                      ? ` +${version.gameVersions.length - 4}`
                      : null}
                  </>
                ) : null}
              </p>

              {version.dependencies.length > 0 ? (
                <ModDependencyList dependencies={version.dependencies} />
              ) : null}
            </li>
          );
        })}
      </ul>

      {hidden > 0 ? (
        <Button
          className="h-11 w-full rounded-button text-subhead font-medium"
          onClick={() => setExpanded(true)}
          variant="outline"
        >
          Show {hidden} older {hidden === 1 ? 'version' : 'versions'}
        </Button>
      ) : null}
    </div>
  );
}

function ModGallery({ mod }: { mod: ModDetail }) {
  if (mod.gallery.length === 0) return null;

  return (
    <Section title="Screenshots">
      {/* Content imagery keeps square corners — the rounded/square contrast is the system. */}
      <ul className="-mx-1 flex snap-x gap-3 overflow-x-auto px-1 pb-2">
        {mod.gallery.map((image) => {
          const href = safeHref(image.url);
          if (href === null) return null;
          return (
            <li className="w-64 shrink-0 snap-start" key={image.url}>
              <a
                className="flex flex-col gap-1.5"
                href={href}
                rel="noreferrer noopener"
                target="_blank"
              >
                <img
                  alt={image.title ?? `Screenshot of ${mod.title}`}
                  className="h-36 w-full bg-fill-tertiary object-cover"
                  loading="lazy"
                  src={href}
                />
                <span className="text-caption text-label-tertiary">
                  {image.title ?? 'Open full size'}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------------------

export interface ModDetailBodyProps {
  mod: ModDetail;
  /** Versions this server can load. Empty is meaningful — it explains `incompatibleReason`. */
  versions?: readonly ModVersion[];
  /** Pinned open at the top of the version list, for the one version under review. */
  highlightVersionId?: string | null;
  installed?: InstalledMod | null;
  incompatibleReason?: string | null;
  /** Set when this is a stored snapshot rather than a live read, so the panel can say so. */
  capturedAt?: string | null;
  className?: string;
}

/**
 * The mod, rendered in full. Shared by the browser's sheet and the approval screen so the
 * two can never show a different amount of information about the same project.
 */
export function ModDetailBody({
  mod,
  versions = [],
  highlightVersionId,
  installed,
  incompatibleReason,
  capturedAt,
  className,
}: ModDetailBodyProps) {
  const sourceName = mod.source === 'modrinth' ? 'Modrinth' : 'CurseForge';

  return (
    <div className={cn('flex flex-col gap-5', className)}>
      <div className="flex items-start gap-4">
        <ModIcon iconUrl={mod.iconUrl} size="lg" title={mod.title} />
        <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-2">
          <div className="min-w-0">
            <dt className="text-caption text-label-tertiary">Author</dt>
            <dd className="truncate text-subhead text-label">{mod.author ?? 'Not published'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-caption text-label-tertiary">Downloads</dt>
            <dd className="tabular text-subhead text-label" title={`${mod.downloads.toLocaleString()} downloads`}>
              {formatDownloads(mod.downloads)}
            </dd>
          </div>
          <div className="min-w-0">
            <dt className="text-caption text-label-tertiary">Licence</dt>
            <dd className="truncate text-subhead text-label">{mod.license ?? 'Not published'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-caption text-label-tertiary">Source</dt>
            <dd className="truncate text-subhead text-label">{sourceName}</dd>
          </div>
        </dl>
      </div>

      {capturedAt ? (
        <p className="text-caption text-label-tertiary">
          Captured{' '}
          <time dateTime={capturedAt} title={new Date(capturedAt).toLocaleString()}>
            {formatRelativeTime(capturedAt)}
          </time>
          , when the proposal was raised. This is what the proposer saw.
        </p>
      ) : null}

      {incompatibleReason ? (
        <Alert variant="warning">
          <AlertTitle className="font-sans">This server can’t load it</AlertTitle>
          <AlertDescription>{incompatibleReason}</AlertDescription>
        </Alert>
      ) : null}

      {installed ? (
        <Alert>
          <AlertTitle className="font-sans">Already installed</AlertTitle>
          <AlertDescription>
            Version <code className="font-mono">{installed.versionNumber}</code> is on disk as{' '}
            <code className="font-mono">
              {installed.target}/{installed.filename}
            </code>
            .
          </AlertDescription>
        </Alert>
      ) : null}

      <Section className="border-t-0 pt-0" title="About">
        <ModDescription format={mod.descriptionFormat} text={mod.description || mod.summary} />
      </Section>

      <ModGallery mod={mod} />

      <Section title="Runs on">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-caption text-label-tertiary">Loaders</span>
            <Chips empty="The project declares no loader." values={mod.loaders} />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-caption text-label-tertiary">Minecraft versions</span>
            <Chips empty="The project declares no game version." values={mod.gameVersions} />
          </div>
          <p className="text-caption text-label-tertiary">
            Server side: {mod.serverSide} · Client side: {mod.clientSide}
          </p>
        </div>
      </Section>

      <Section title={versions.length === 1 ? 'Version' : 'Versions'}>
        <ModVersionList
          highlightVersionId={highlightVersionId ?? null}
          installedVersionId={installed?.versionId ?? null}
          versions={versions}
        />
      </Section>

      <Section title="Links">
        <div className="flex flex-col">
          <OutboundLink href={mod.url}>View on {sourceName}</OutboundLink>
          {mod.sourceUrl ? <OutboundLink href={mod.sourceUrl}>Source code</OutboundLink> : null}
          {mod.issuesUrl ? <OutboundLink href={mod.issuesUrl}>Issue tracker</OutboundLink> : null}
          {mod.wikiUrl ? <OutboundLink href={mod.wikiUrl}>Wiki</OutboundLink> : null}
          {mod.licenseUrl ? (
            <OutboundLink href={mod.licenseUrl}>Licence text</OutboundLink>
          ) : null}
          {mod.discordUrl ? <OutboundLink href={mod.discordUrl}>Discord</OutboundLink> : null}
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Propose
// ---------------------------------------------------------------------------------------

const MIN_RATIONALE = 3;
const MAX_RATIONALE = 2000;

function ProposeForm({
  serverId,
  source,
  project,
  versions,
  onProposed,
}: {
  serverId: string;
  source: ModSource;
  project: string;
  versions: readonly ModVersion[];
  onProposed?: (proposalId: string) => void;
}) {
  const [rationale, setRationale] = useState('');
  const [versionId, setVersionId] = useState('');
  const [touched, setTouched] = useState(false);
  const propose = useCreateProposal(serverId);
  const hintId = useId();

  const trimmed = rationale.trim();
  const tooShort = trimmed.length < MIN_RATIONALE;
  const invalid = touched && tooShort;

  if (propose.isSuccess) {
    return (
      <Alert variant="success">
        <AlertTitle className="font-sans">Queued for review</AlertTitle>
        <AlertDescription>
          Nothing has been installed. It waits in this server’s review queue until someone
          approves it.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        setTouched(true);
        if (tooShort || propose.isPending) return;
        propose.mutate(
          {
            source,
            project,
            rationale: trimmed,
            ...(versionId === '' ? {} : { version: versionId }),
          },
          { onSuccess: (proposal) => onProposed?.(proposal.id) },
        );
      }}
    >
      <Field invalid={invalid}>
        <FieldLabel>Why this mod?</FieldLabel>
        <Textarea
          maxLength={MAX_RATIONALE}
          name="rationale"
          onBlur={() => setTouched(true)}
          onChange={(event) => setRationale(event.target.value)}
          placeholder="What it adds, and why this server wants it."
          rows={3}
          value={rationale}
        />
        {invalid ? (
          <FieldError>Write at least a few words. The reviewer reads this first.</FieldError>
        ) : (
          <FieldDescription>
            Stored with the proposal. An agent proposing over MCP fills in the same field.
          </FieldDescription>
        )}
      </Field>

      {versions.length > 0 ? (
        <Field>
          <FieldLabel>Version</FieldLabel>
          <NativeSelect
            className="w-full [&>select]:h-11"
            name="version"
            onChange={(event) => setVersionId(event.target.value)}
            value={versionId}
          >
            <NativeSelectOption value="">Newest this server can load</NativeSelectOption>
            {versions.map((version) => (
              <NativeSelectOption key={version.versionId} value={version.versionId}>
                {version.versionNumber} ({version.channel})
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      ) : null}

      <p className="text-caption text-label-tertiary" id={hintId}>
        This adds it to the review queue. It installs nothing.
      </p>

      <Button
        aria-describedby={hintId}
        className="h-11 rounded-button px-5 text-subhead font-medium"
        isLoading={propose.isPending}
        size="lg"
        type="submit"
      >
        Send for review
      </Button>

      <p aria-live="polite" className="text-caption text-danger" role="status">
        {propose.isError ? errorMessage(propose.error) : null}
      </p>
    </form>
  );
}

// ---------------------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------------------

export interface ModDetailSheetProps {
  serverId: string;
  /** Null closes the sheet. Changing it swaps which mod is shown. */
  target: { source: ModSource; project: string; title: string } | null;
  onClose: () => void;
  /** Hides the propose form for a reader who cannot use it. */
  canPropose?: boolean;
  onProposed?: (proposalId: string) => void;
}

export function ModDetailSheet({
  serverId,
  target,
  onClose,
  canPropose = true,
  onProposed,
}: ModDetailSheetProps) {
  return (
    <Sheet
      onOpenChange={(details) => {
        if (!details.open) onClose();
      }}
      open={target !== null}
    >
      {/* No aria-label: Ark points the content's aria-labelledby at SheetTitle already. */}
      <SheetContent className="max-w-xl lg:max-w-2xl">
        {target ? (
          <SheetInner
            canPropose={canPropose}
            project={target.project}
            serverId={serverId}
            source={target.source}
            title={target.title}
            {...(onProposed ? { onProposed } : {})}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * Split out so the query only runs while the sheet is open — `Sheet` lazy-mounts and unmounts
 * its content, so nothing here fetches a project the reader never asked to see.
 */
function SheetInner({
  serverId,
  source,
  project,
  title,
  canPropose,
  onProposed,
}: {
  serverId: string;
  source: ModSource;
  project: string;
  title: string;
  canPropose: boolean;
  onProposed?: (proposalId: string) => void;
}) {
  const query = useMod(serverId, source, project);
  const detail = query.data;

  return (
    <>
      <SheetHeader>
        {/* font-sans: SheetTitle defaults to `font-heading`, which this theme maps to the
            pixel display face — unreadable at 20px. */}
        <SheetTitle className="font-sans text-title-3 font-semibold">{title}</SheetTitle>
        <SheetDescription>
          {detail
            ? detail.mod.summary
            : query.isError
              ? 'This project could not be loaded.'
              : 'Loading the full listing.'}
        </SheetDescription>
      </SheetHeader>

      <SheetBody>
        {/* Error first: a failed query also has no data, and a skeleton that never
            resolves is the worst of the three states to be left in. */}
        {query.isError ? (
          <ErrorState
            error={query.error}
            isRetrying={query.isFetching}
            onRetry={() => void query.refetch()}
            variant="inline"
          />
        ) : detail === undefined ? (
          <div className="flex flex-col gap-4">
            <span className="sr-only" role="status">
              Loading {title}.
            </span>
            <div className="flex gap-4">
              <Skeleton className="size-16 rounded-xs" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-28" />
              </div>
            </div>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-24 w-full rounded-sm" />
          </div>
        ) : (
          <ModDetailBody
            incompatibleReason={detail.incompatibleReason}
            installed={detail.installed}
            mod={detail.mod}
            versions={detail.compatibleVersions}
          />
        )}
      </SheetBody>

      {detail && canPropose && detail.incompatibleReason === null ? (
        <SheetFooter className="flex-col items-stretch gap-0 sm:flex-col sm:justify-start">
          <ProposeForm
            project={project}
            serverId={serverId}
            source={source}
            versions={detail.compatibleVersions}
            {...(onProposed ? { onProposed } : {})}
          />
        </SheetFooter>
      ) : null}
    </>
  );
}
