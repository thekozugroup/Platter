import { Fragment, useMemo } from 'react';
import { cn } from '@/lib/utils';

/**
 * Registry descriptions, rendered.
 *
 * A mod's description is arbitrary text written by a stranger and served by a third party, so
 * the security posture here is the first thing to understand: **there is no HTML sink in this
 * file.** No `dangerouslySetInnerHTML`, no `innerHTML`, no `<svg>` passthrough. The parser
 * produces a tree of plain values and the renderer turns that tree into React elements, so
 * every piece of registry text reaches the DOM as a text node or as an attribute React itself
 * escapes. That is why no sanitiser dependency is needed: sanitising is what you do when you
 * have decided to hand markup to the browser, and this never does.
 *
 * The two attributes that *are* attacker-controlled — a link's `href` and an image's `src` —
 * both go through `safeHref`, which admits `http:` and `https:` and nothing else. `javascript:`,
 * `data:` and `vbscript:` URLs come back null and the node degrades to inert text.
 *
 * What it renders, and why each piece is here rather than "good enough without":
 *
 * - **Images.** `![fo](…)` was previously unmatched, so Modrinth's Palladium printed the
 *   literal string `!fo !fa !qu !neo` at the reader. Screenshots in a description are often
 *   the description.
 * - **Raw HTML.** Markdown permits it and registry authors use it constantly. `</br>` and
 *   `<br />` become real breaks; every other tag is dropped and its text kept. A user must
 *   never be shown a tag.
 * - **Nested inline.** `**text with a [link](…)**` used to render the link syntax raw, because
 *   the old scanner never re-entered emphasis. Inline parsing recurses, with a depth cap.
 * - **Tables.** GFM pipe tables are how a mod compares itself to vanilla, and unparsed they
 *   are a wall of `|`.
 * - **Reference links** (`[a][b]` with `[b]: url` below), autolinks and bare URLs, so no
 *   bracket syntax survives to the screen.
 *
 * CurseForge publishes HTML instead. That path is parsed with `DOMParser` — which neither runs
 * scripts nor fetches subresources — purely to recover the text, and the text is then rendered
 * as paragraphs *without* Markdown inline parsing, so a stray asterisk in prose stays an
 * asterisk.
 */

// ---------------------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------------------

/** Web links only. Everything else — `javascript:`, `data:`, `vbscript:` — comes back null. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (trimmed.length === 0) return null;
  try {
    const base = typeof window === 'undefined' ? 'https://platter.invalid' : window.location.origin;
    const url = new URL(trimmed, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  times: '×',
  middot: '·',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  larr: '←',
  rarr: '→',
  check: '✓',
};

/**
 * Entities are decoded by table, never by assigning to a DOM node's `innerHTML`.
 *
 * The `element.innerHTML = text; return element.textContent` trick is the usual one-liner for
 * this and it is an HTML sink — it is how a sanitiser gets bypassed. A lookup cannot execute
 * anything.
 */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body.startsWith('#x') || body.startsWith('#X')
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // Surrogates and out-of-range code points would throw; leave those as written.
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// ---------------------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------------------

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'break' }
  | { kind: 'strong'; children: Inline[] }
  | { kind: 'em'; children: Inline[] }
  | { kind: 'strike'; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'image'; src: string; alt: string };

type LinkDefinitions = ReadonlyMap<string, string>;

/**
 * How long a run of emphasis is allowed to be before it is assumed to be a stray marker.
 *
 * This is a backtracking bound, not a style rule. `**…**` is lazy, so an unclosed `**` makes
 * the engine scan the rest of the body looking for a partner, and a body full of unpaired
 * asterisks turns that into quadratic work on text a stranger wrote. Modrinth allows 64 KB of
 * body, which is more than enough to make that felt. Nobody bolds four hundred characters.
 */
const EMPHASIS_SPAN = 400;

/*
 * One pass, one regex. The alternation order is the precedence: an HTML comment before a tag,
 * a linked image before a bare image before a link (each is the next one wearing a prefix), an
 * autolink before the generic-tag rule (`<https://x>` is shaped exactly like a tag), and a
 * `<br>` before that too, because `br` is the one tag that survives as content.
 *
 * Alternatives that carry no capture group — the comment, the break, the discarded tag — are
 * identified from the whole match instead. That keeps the group indices short enough to name.
 *
 * Every quantifier here is either a single character class or explicitly bounded. Nested
 * quantifiers over overlapping alternatives are what turn a description into a hang, and this
 * regex runs against text supplied by whoever published the mod.
 */
const INLINE_TOKEN = new RegExp(
  [
    '<!--[\\s\\S]{0,2000}?-->', //                                            comment, dropped
    '<\\s*/?\\s*[bB][rR](?:\\s[^>]*)?/?\\s*>', //                             a real break
    '`([^`\\n]+)`', //                                                    1   code span
    // 2,3,4 — an image that is itself a link, the shape every shields.io badge takes.
    '\\[!\\[([^\\]]*)\\]\\(\\s*<?([^)\\s>]*)>?[^)]*\\)\\]\\(\\s*<?([^)\\s>]*)>?[^)]*\\)',
    '!\\[([^\\]]*)\\]\\(\\s*<?([^)\\s>]*)>?[^)]*\\)', //                  5,6 image
    '!\\[([^\\]]*)\\]\\[([^\\]]*)\\]', //                                 7,8 image by reference
    '\\[([^\\[\\]]*)\\]\\(\\s*<?([^)\\s>]*)>?[^)]*\\)', //               9,10 link
    '\\[([^\\]]+)\\]\\[([^\\]]*)\\]', //                                11,12 link by reference
    `\\*\\*([\\s\\S]{1,${EMPHASIS_SPAN}}?)\\*\\*`, //                       13 bold
    `__([\\s\\S]{1,${EMPHASIS_SPAN}}?)__`, //                               14 bold
    `~~([\\s\\S]{1,${EMPHASIS_SPAN}}?)~~`, //                               15 strikethrough
    `\\*([^*\\n]{1,${EMPHASIS_SPAN}}?)\\*`, //                              16 italic
    `(?<![A-Za-z0-9_])_([^_\\n]{1,${EMPHASIS_SPAN}}?)_(?![A-Za-z0-9_])`, // 17 italic
    '<(https?://[^>\\s]+)>', //                                            18 autolink
    '</?[A-Za-z][^>]*>', //                                                   any other tag
    '(https?://[^\\s<>()\\[\\]"\']+)', //                                  19 bare URL
  ].join('|'),
);

const BREAK_TOKEN = /^<\s*\/?\s*[bB][rR](?:\s|\/|>)/;

/** Emphasis inside emphasis inside a link is real; ten levels of it is a malformed body. */
const MAX_INLINE_DEPTH = 8;

function pushText(nodes: Inline[], text: string): void {
  if (text.length === 0) return;
  const decoded = decodeEntities(text);
  const last = nodes[nodes.length - 1];
  if (last?.kind === 'text') last.text += decoded;
  else nodes.push({ kind: 'text', text: decoded });
}

function resolveReference(name: string, fallback: string, links: LinkDefinitions): string | null {
  const key = (name.trim() === '' ? fallback : name).trim().toLowerCase();
  return links.get(key) ?? null;
}

export function parseInline(
  source: string,
  links: LinkDefinitions = new Map(),
  depth = 0,
): Inline[] {
  const nodes: Inline[] = [];
  if (depth > MAX_INLINE_DEPTH) {
    pushText(nodes, source);
    return nodes;
  }

  const pattern = new RegExp(INLINE_TOKEN.source, 'g');
  let cursor = 0;
  let match = pattern.exec(source);

  while (match !== null) {
    if (match.index > cursor) pushText(nodes, source.slice(cursor, match.index));
    cursor = match.index + match[0].length;

    const [
      whole,
      code,
      linkedImageAlt,
      linkedImageSrc,
      linkedImageHref,
      imageAlt,
      imageSrc,
      imageRefAlt,
      imageRef,
      linkText,
      linkHref,
      refText,
      refName,
      boldStar,
      boldScore,
      strike,
      italicStar,
      italicScore,
      autolink,
      bareUrl,
    ] = match;

    if (code !== undefined) {
      nodes.push({ kind: 'code', text: decodeEntities(code) });
    } else if (linkedImageSrc !== undefined) {
      const src = safeHref(linkedImageSrc);
      const href = safeHref(linkedImageHref ?? '');
      const alt = decodeEntities(linkedImageAlt ?? '');
      const image: Inline =
        src === null ? { kind: 'text', text: alt } : { kind: 'image', src, alt };
      if (href === null) nodes.push(image);
      else nodes.push({ kind: 'link', href, children: [image] });
    } else if (imageSrc !== undefined) {
      const src = safeHref(imageSrc);
      if (src === null) pushText(nodes, decodeEntities(imageAlt ?? ''));
      else nodes.push({ kind: 'image', src, alt: decodeEntities(imageAlt ?? '') });
    } else if (imageRef !== undefined) {
      const src = safeHref(resolveReference(imageRef, imageRefAlt ?? '', links) ?? '');
      if (src === null) pushText(nodes, decodeEntities(imageRefAlt ?? ''));
      else nodes.push({ kind: 'image', src, alt: decodeEntities(imageRefAlt ?? '') });
    } else if (linkHref !== undefined) {
      const href = safeHref(linkHref);
      const children = parseInline(linkText ?? '', links, depth + 1);
      if (href === null) nodes.push(...children);
      else nodes.push({ kind: 'link', href, children });
    } else if (refName !== undefined) {
      const href = safeHref(resolveReference(refName, refText ?? '', links) ?? '');
      const children = parseInline(refText ?? '', links, depth + 1);
      if (href === null) nodes.push(...children);
      else nodes.push({ kind: 'link', href, children });
    } else if (boldStar !== undefined || boldScore !== undefined) {
      nodes.push({
        kind: 'strong',
        children: parseInline(boldStar ?? boldScore ?? '', links, depth + 1),
      });
    } else if (strike !== undefined) {
      nodes.push({ kind: 'strike', children: parseInline(strike, links, depth + 1) });
    } else if (italicStar !== undefined || italicScore !== undefined) {
      nodes.push({
        kind: 'em',
        children: parseInline(italicStar ?? italicScore ?? '', links, depth + 1),
      });
    } else if (autolink !== undefined || bareUrl !== undefined) {
      const raw = autolink ?? bareUrl ?? '';
      const href = safeHref(raw);
      if (href === null) pushText(nodes, raw);
      else nodes.push({ kind: 'link', href, children: [{ kind: 'text', text: raw }] });
    } else if (BREAK_TOKEN.test(whole)) {
      nodes.push({ kind: 'break' });
    }
    // Anything left is an HTML comment or a tag we do not render. Dropped, never printed.

    match = pattern.exec(source);
  }

  if (cursor < source.length) pushText(nodes, source.slice(cursor));
  return nodes;
}

// ---------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------

export interface ListItem {
  text: string;
  depth: number;
  /** `- [x] done` renders its box rather than the literal brackets. */
  checked: boolean | null;
}

export type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'list'; items: ListItem[]; ordered: boolean }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'rule' };

const DEFINITION = /^ {0,3}\[([^\]]+)\]:\s*<?(\S+)>?\s*(?:["'(].*)?$/;
const TABLE_DIVIDER = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/** `| a | b |` → `['a', 'b']`, tolerating the optional leading and trailing pipes. */
function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableStart(line: string, next: string | undefined): boolean {
  return (
    line.includes('|') &&
    next !== undefined &&
    next.includes('-') &&
    TABLE_DIVIDER.test(next) &&
    splitRow(next).length === splitRow(line).length &&
    splitRow(line).length > 1
  );
}

export function parseBlocks(source: string): { blocks: Block[]; links: Map<string, string> } {
  const links = new Map<string, string>();
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];

  let paragraph: string[] = [];
  let list: { items: ListItem[]; ordered: boolean } | null = null;
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

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const line = raw.trimEnd();

    if (line.trimStart().startsWith('```') || line.trimStart().startsWith('~~~')) {
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

    const definition = DEFINITION.exec(line);
    if (definition?.[1] !== undefined && definition[2] !== undefined) {
      links.set(definition[1].trim().toLowerCase(), definition[2]);
      continue;
    }

    const heading = /^ {0,3}(#{1,6})\s+(.*?)\s*#*$/.exec(line);
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

    if (isTableStart(line, lines[index + 1])) {
      flushAll();
      const head = splitRow(line);
      const rows: string[][] = [];
      index += 1;
      while (index + 1 < lines.length) {
        const candidate = lines[index + 1] ?? '';
        if (!candidate.includes('|') || candidate.trim().length === 0) break;
        index += 1;
        rows.push(splitRow(candidate));
      }
      blocks.push({ kind: 'table', head, rows });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote?.[1] !== undefined) {
      flushAll();
      blocks.push({ kind: 'quote', text: quote[1] });
      continue;
    }

    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    const numbered = /^(\s*)\d+[.)]\s+(.*)$/.exec(line);
    const marker = bullet ?? numbered;
    if (marker?.[2] !== undefined) {
      const ordered = bullet === null;
      // Two spaces is a level on Modrinth, four on GitHub; either reads as "under the last".
      const depth = Math.min(3, Math.floor((marker[1]?.length ?? 0) / 2));
      const task = /^\[([ xX])\]\s+(.*)$/.exec(marker[2]);
      flushParagraph();
      if (list === null || list.ordered !== ordered) {
        flushList();
        list = { items: [], ordered };
      }
      list.items.push({
        text: task?.[2] ?? marker[2],
        depth,
        checked: task === null ? null : task[1] !== ' ',
      });
      continue;
    }

    flushList();
    // Two trailing spaces is Markdown's hard break. `<br>` is the tokeniser's break, and the
    // two mean the same thing, so the cheapest correct move is to say it in the one dialect
    // the inline scanner already speaks.
    paragraph.push(/ {2,}$/.test(raw) ? `${line.trim()}<br>` : line.trim());
  }

  if (fence !== null) blocks.push({ kind: 'code', text: fence.join('\n') });
  flushAll();
  return { blocks, links };
}

// ---------------------------------------------------------------------------------------
// HTML bodies
// ---------------------------------------------------------------------------------------

/**
 * CurseForge's HTML, reduced to text.
 *
 * `DOMParser` builds an inert document: scripts do not run, `<img>` does not fetch, and
 * nothing is ever attached to this page's DOM. Only `textContent` leaves this function.
 */
function htmlToText(html: string): string {
  if (typeof DOMParser === 'undefined') {
    return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ');
  }
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  /*
   * `textContent` includes the *source* of a `<script>` or `<style>`. Nothing runs — the
   * parsed document is inert and never attached — but printing `window.owned = true` at
   * somebody reading a mod description is the same failure as printing a tag at them.
   */
  for (const node of parsed.body.querySelectorAll('script, style, noscript, template, head')) {
    node.remove();
  }
  for (const node of parsed.body.querySelectorAll('br, p, div, li, tr, h1, h2, h3, h4, h5, h6')) {
    node.append(parsed.createTextNode('\n'));
  }
  return (parsed.body.textContent ?? '').replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------------------

/**
 * An image inside a description body does not fetch, and that is deliberate twice over.
 *
 * `apps/api/src/plugins/security.ts` pins `img-src` to `'self'`, so a `cdn.modrinth.com` URL
 * in an `<img>` is a tile the browser refuses to paint — it would render as a broken-image
 * glyph, which is a worse version of the bug this rewrite fixes. The policy is not an
 * oversight either: the comment there says outright that the operator's browser should never
 * beacon to a registry CDN revealing which mods they are reading about. Icons and gallery
 * screenshots get around it by being rewritten server-side to a signed same-origin proxy
 * (`mods/icon-proxy.ts`), and a description body is free text that rewrite does not reach.
 *
 * So the alt text is used instead — but only when it says something. Real bodies are full of
 * `![fo]`, `![1]`, `![pull]`: labels for the author's own benefit that would be pure noise as
 * captions. Anything with a space in it, or long enough to be a sentence fragment, is a
 * caption somebody wrote to be read; anything shorter is dropped. The mod's actual screenshots
 * are not lost either way — they are in the gallery below, through the proxy, as pictures.
 */
function imageCaption(alt: string): string | null {
  const label = alt.trim();
  if (label.length === 0) return null;
  return /\s/.test(label) || label.length >= 12 ? label : null;
}

/**
 * True when this would render to nothing.
 *
 * Two things need it. A paragraph holding only dropped images must not survive as an empty box
 * with the column's gap either side of it; and a badge — `[![build](img)](href)`, which is
 * every README's top line — must not become an empty link, which is a focus stop leading
 * somewhere with no name a screen reader can read out.
 */
function isBlank(nodes: readonly Inline[]): boolean {
  return nodes.every((node) => {
    switch (node.kind) {
      case 'text':
        return node.text.trim().length === 0;
      case 'break':
        return true;
      case 'image':
        return imageCaption(node.alt) === null;
      case 'code':
        return false;
      default:
        return isBlank(node.children);
    }
  });
}

function renderInline(nodes: readonly Inline[], keyPrefix: string): React.ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.kind) {
      case 'text':
        return <Fragment key={key}>{node.text}</Fragment>;
      case 'break':
        return <br key={key} />;
      case 'code':
        return (
          <code className="rounded-xs bg-fill-tertiary px-1 font-mono text-caption" key={key}>
            {node.text}
          </code>
        );
      case 'strong':
        return (
          <strong className="font-semibold text-label" key={key}>
            {renderInline(node.children, key)}
          </strong>
        );
      case 'em':
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case 'strike':
        return (
          <s className="text-label-tertiary" key={key}>
            {renderInline(node.children, key)}
          </s>
        );
      case 'link':
        // A badge whose picture was dropped would leave an empty link: focusable, and
        // announced by a screen reader as a destination with no name.
        return isBlank(node.children) ? null : (
          <a
            className="underline underline-offset-2 hover:text-label"
            href={node.href}
            key={key}
            // `nofollow` and `noreferrer` because this is a stranger's link in a stranger's
            // description; `noopener` because a new tab must not reach back into this one.
            rel="noreferrer noopener nofollow"
            target="_blank"
          >
            {renderInline(node.children, key)}
          </a>
        );
      default: {
        const caption = imageCaption(node.alt);
        return caption === null ? null : (
          <span className="text-label-tertiary" key={key}>
            {caption}
          </span>
        );
      }
    }
  });
}

interface ListNode {
  item: ListItem;
  children: ListNode[];
}

/** Flat items with an indent level, back into the nesting the author wrote. */
function nestItems(items: readonly ListItem[]): ListNode[] {
  const roots: ListNode[] = [];
  const stack: ListNode[] = [];

  for (const item of items) {
    const node: ListNode = { item, children: [] };
    while (stack.length > 0 && (stack[stack.length - 1]?.item.depth ?? 0) >= item.depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function ItemList({
  nodes,
  ordered,
  links,
  keyPrefix,
  nested = false,
}: {
  nodes: readonly ListNode[];
  ordered: boolean;
  links: LinkDefinitions;
  keyPrefix: string;
  nested?: boolean;
}) {
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag
      className={cn(
        'ms-5 flex flex-col gap-1',
        ordered ? 'list-decimal' : 'list-disc',
        nested && 'mt-1',
      )}
    >
      {nodes.map((node, index) => {
        const key = `${keyPrefix}-${index}`;
        return (
          <li className={node.item.checked === null ? undefined : 'list-none'} key={key}>
            {node.item.checked === null ? null : (
              <span aria-hidden className="me-1.5 text-label-tertiary">
                {node.item.checked ? '☑' : '☐'}
              </span>
            )}
            {node.item.checked === null ? null : (
              <span className="sr-only">{node.item.checked ? 'Done: ' : 'Not done: '}</span>
            )}
            {renderInline(parseInline(node.item.text, links), key)}
            {node.children.length > 0 ? (
              <ItemList
                keyPrefix={key}
                links={links}
                nested
                nodes={node.children}
                ordered={ordered}
              />
            ) : null}
          </li>
        );
      })}
    </Tag>
  );
}

export interface ModDescriptionProps {
  text: string;
  format: 'markdown' | 'html' | 'text';
  className?: string;
  /** Shown when the project publishes nothing. Worded for the surface it sits on. */
  empty?: string;
}

export function ModDescription({
  text,
  format,
  className,
  empty = 'This project publishes no description.',
}: ModDescriptionProps) {
  const { blocks, links } = useMemo(() => {
    if (format === 'markdown') return parseBlocks(text);
    // HTML and plain text are both prose: split into paragraphs, and read no Markdown into
    // them. A `*` in a CurseForge sentence is an asterisk, not an italic that never closes.
    const source = format === 'html' ? htmlToText(text) : text;
    return {
      blocks: source
        .split(/\n{2,}/)
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk.length > 0)
        .map((chunk): Block => ({ kind: 'paragraph', text: chunk })),
      links: new Map<string, string>(),
    };
  }, [text, format]);

  if (blocks.length === 0) {
    return <p className={cn('text-subhead text-label-tertiary', className)}>{empty}</p>;
  }

  return (
    <div
      className={cn(
        'flex flex-col gap-3 text-subhead leading-normal break-words text-label-secondary',
        className,
      )}
    >
      {blocks.map((block, blockIndex) => {
        const key = `b${blockIndex}`;
        // A paragraph of nothing but images the browser is not allowed to fetch would render
        // as an empty box with the column's gap either side of it. Drop it whole.
        if (
          (block.kind === 'paragraph' || block.kind === 'heading' || block.kind === 'quote') &&
          isBlank(parseInline(block.text, links))
        ) {
          return null;
        }
        switch (block.kind) {
          case 'heading':
            return (
              // h4 and below, always: the pixel display face is for page headings and is
              // unreadable at this size, and a mod's `#` is not a heading of this page.
              <h4
                className={cn(
                  'mt-2 font-sans font-semibold text-label',
                  block.level <= 2 ? 'text-title-3' : 'text-body',
                )}
                key={key}
              >
                {renderInline(parseInline(block.text, links), key)}
              </h4>
            );
          case 'list':
            return (
              <ItemList
                key={key}
                keyPrefix={key}
                links={links}
                nodes={nestItems(block.items)}
                ordered={block.ordered}
              />
            );
          case 'quote':
            return (
              <blockquote
                className="border-s-2 border-separator-strong ps-3 text-label-tertiary"
                key={key}
              >
                {renderInline(parseInline(block.text, links), key)}
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
          case 'table':
            return (
              <div className="overflow-x-auto" key={key}>
                <table className="w-full border-collapse text-caption">
                  <thead>
                    <tr className="border-b border-separator-strong">
                      {block.head.map((cell, cellIndex) => (
                        <th
                          className="py-1.5 pe-3 text-start font-medium text-label"
                          key={`${key}-h${cellIndex}`}
                          scope="col"
                        >
                          {renderInline(parseInline(cell, links), `${key}-h${cellIndex}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr className="border-b border-separator" key={`${key}-r${rowIndex}`}>
                        {row.map((cell, cellIndex) => (
                          <td className="py-1.5 pe-3" key={`${key}-r${rowIndex}c${cellIndex}`}>
                            {renderInline(
                              parseInline(cell, links),
                              `${key}-r${rowIndex}c${cellIndex}`,
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case 'rule':
            return <hr className="border-separator" key={key} />;
          default:
            return <p key={key}>{renderInline(parseInline(block.text, links), key)}</p>;
        }
      })}
    </div>
  );
}
