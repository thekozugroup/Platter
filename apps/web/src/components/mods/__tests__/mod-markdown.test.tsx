import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModDescription } from '@/components/mods/mod-markdown';

/**
 * Registry descriptions are the one place in this product where a stranger's text reaches the
 * screen, so these tests are split by the two ways that goes wrong.
 *
 * **It looks broken.** The regression that prompted the rewrite is in the first block: Modrinth's
 * "Palladium" body opens with four images and a `</br>`, and the panel printed the literal
 * string `!fo !fa !qu !neo </br>` at the reader. Every case there is taken from a real body.
 *
 * **It is dangerous.** The second block is the security floor. There is no HTML sink in
 * `mod-markdown.tsx` — no `dangerouslySetInnerHTML`, no `innerHTML` — so the attack surface is
 * the two attacker-controlled attributes, `href` and `src`. Both are checked here.
 */

function renderMarkdown(text: string) {
  return render(<ModDescription format="markdown" text={text} />);
}

// ---------------------------------------------------------------------------------------
// The Palladium body
// ---------------------------------------------------------------------------------------

/** Trimmed from https://api.modrinth.com/v2/project/mpalladium, verbatim. */
const PALLADIUM = `# [DISCONTINUED]

**I'll be archiving this mod. The useful features will be ported over to [NumFlux](https://modrinth.com/mod/numflux)(server).**
***
![fo](https://cdn.modrinth.com/data/cached_images/8457cf2b.png)
![fa](https://cdn.modrinth.com/data/cached_images/6c152554.png)
</br>
**Tests on 1.20.2 without any optimizing mods.**
</br>
</br>

**World loading/creation time(seconds) comparison table(1.1.1+):**
|  | Vanilla | Palladium |
|--------------|-----------|-----|
| World creation  | 08.92 | 08.06 |
| World loading   | 02.96  | 02.71 |

**Mob AI:**
<br/>
Improve cat and wolf attack AI
<br />
Full compatible with Sodium/Forks ~~and shader-packs~~ the shaders work but with bugs`;

describe('ModDescription — the Palladium regression', () => {
  it('never prints a raw tag at the reader', () => {
    const { container } = renderMarkdown(PALLADIUM);
    const text = container.textContent ?? '';

    expect(text).not.toContain('</br>');
    expect(text).not.toContain('<br/>');
    expect(text).not.toContain('<br />');
    // …and the breaks are real elements, not text that was silently swallowed.
    expect(container.querySelectorAll('br').length).toBeGreaterThan(0);
  });

  it('swallows `!fo !fa` rather than printing it, and beacons to no CDN doing so', () => {
    const { container } = renderMarkdown(PALLADIUM);

    expect(container.textContent).not.toContain('!fo');
    expect(container.textContent).not.toContain('!fa');
    expect(container.textContent).not.toContain('cdn.modrinth.com');
    /*
     * No request to a registry CDN — `img-src` is `'self'` and the policy exists so the
     * operator's browser does not tell Modrinth which mods they are reading about
     * (`apps/api/src/plugins/security.ts`). A tag here would paint a broken-image glyph.
     */
    expect(container.querySelector('img')).toBeNull();
    // And the paragraph that held nothing but those four images does not survive as a gap.
    expect(
      [...container.querySelectorAll('p')].some((node) => node.textContent?.trim() === ''),
    ).toBe(false);
  });

  it('keeps a caption somebody wrote to be read', () => {
    const { container } = renderMarkdown(
      '![World load times, vanilla against Palladium](https://cdn.modrinth.com/a.png)\n\n![qu](https://cdn.modrinth.com/b.png)',
    );

    expect(container.textContent).toBe('World load times, vanilla against Palladium');
    // `![qu]` is a label for the author's own benefit, not a caption. It goes.
    expect(container.textContent).not.toContain('qu');
  });

  it('renders a link nested inside bold, rather than its Markdown source', () => {
    const { container } = renderMarkdown(PALLADIUM);

    // The old scanner never re-entered emphasis, so this printed `[NumFlux](https://…)`.
    expect(container.textContent).not.toContain('](https://modrinth.com/mod/numflux)');
    const link = screen.getByRole('link', { name: 'NumFlux' });
    expect(link).toHaveAttribute('href', 'https://modrinth.com/mod/numflux');
    expect(link.closest('strong')).not.toBeNull();
  });

  it('renders a pipe table as a table', () => {
    renderMarkdown(PALLADIUM);

    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Vanilla' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: 'World creation' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: '08.06' })).toBeInTheDocument();
    // No row of pipes survived into the prose.
    expect(screen.queryByText(/\|--------------\|/)).not.toBeInTheDocument();
  });

  it('strikes through what the author struck through', () => {
    const { container } = renderMarkdown(PALLADIUM);

    expect(container.querySelector('s')?.textContent).toBe('and shader-packs');
    expect(container.textContent).not.toContain('~~');
  });

  it('keeps headings out of the pixel display face', () => {
    const { container } = renderMarkdown(PALLADIUM);

    // A mod's `#` is not a heading of this page: h4 and below, in the body sans (DESIGN §3).
    expect(container.querySelector('h1, h2, h3')).toBeNull();
    const heading = container.querySelector('h4');
    expect(heading).toHaveTextContent('[DISCONTINUED]');
    expect(heading?.className).toContain('font-sans');
  });
});

// ---------------------------------------------------------------------------------------
// Everything else a real body contains
// ---------------------------------------------------------------------------------------

describe('ModDescription — the rest of Markdown', () => {
  it('drops tags it does not render, keeping their text', () => {
    const { container } = renderMarkdown(
      '<div align="center"><span class="x">Centred words</span></div>\n\n<!-- a note -->\n\nAfter.',
    );

    expect(container.textContent).toContain('Centred words');
    expect(container.textContent).toContain('After.');
    expect(container.textContent).not.toContain('<div');
    expect(container.textContent).not.toContain('align=');
    expect(container.textContent).not.toContain('a note');
  });

  it('decodes entities by table rather than through the DOM', () => {
    const { container } = renderMarkdown('Tom &amp; Jerry &mdash; 5 &lt; 6 &#8212; &#x41;');

    expect(container.textContent).toBe('Tom & Jerry — 5 < 6 — A');
  });

  it('nests a sub-list under its parent instead of flattening it', () => {
    const { container } = renderMarkdown(
      '- Deduplication\n  - Resource key\n  - Verticies\n- Mob AI',
    );

    const outer = container.querySelector('ul');
    expect(outer?.children).toHaveLength(2);
    expect(within(outer as HTMLElement).getAllByRole('listitem')[0]).toHaveTextContent(
      'Resource key',
    );
    expect(outer?.querySelector('ul')?.children).toHaveLength(2);
  });

  it('resolves reference links and bare URLs', () => {
    renderMarkdown(
      'See the [docs][d] or https://example.com/plain\n\n[d]: https://docs.example.com/x',
    );

    expect(screen.getByRole('link', { name: 'docs' })).toHaveAttribute(
      'href',
      'https://docs.example.com/x',
    );
    expect(screen.getByRole('link', { name: 'https://example.com/plain' })).toBeInTheDocument();
  });

  it('leaves a fenced block alone', () => {
    const { container } = renderMarkdown('Run:\n\n```\njava -jar **not bold** server.jar\n```');

    expect(container.querySelector('pre')?.textContent).toBe('java -jar **not bold** server.jar');
  });

  it('reads a CurseForge HTML body as text, without reading Markdown into it', () => {
    const { container } = render(
      <ModDescription
        format="html"
        text="<p>Adds 3 * 4 blocks</p><script>window.owned = true</script><p>Second</p>"
      />,
    );

    expect(container.textContent).toContain('Adds 3 * 4 blocks');
    expect(container.textContent).toContain('Second');
    expect(container.textContent).not.toContain('window.owned');
    expect((window as unknown as { owned?: boolean }).owned).toBeUndefined();
    // A lone `*` in prose is an asterisk, not an italic that never closes.
    expect(container.querySelector('em')).toBeNull();
  });

  it('drops a badge row rather than leaving nameless links behind', () => {
    // Every README opens with these. The picture cannot be fetched, and a link with no
    // readable name is worse than no link.
    const { container } = renderMarkdown(
      '[![wakatime](https://wakatime.com/badge.svg)](https://wakatime.com/x)\n' +
        '[![Discord](https://img.shields.io/discord/1.svg)](https://discord.gg/x)\n\n' +
        'Palladium lets you create data-driven superpowers.',
    );

    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(container.textContent).toBe('Palladium lets you create data-driven superpowers.');
  });

  it('finishes promptly on a body full of unpaired emphasis markers', () => {
    // Lazy `**…**` against 64 KB of asterisks is how a description becomes a hang. The
    // bounded span in `mod-markdown.tsx` is what keeps this linear-ish.
    const hostile = `${'**'.repeat(4000)} and some words`;
    const started = Date.now();
    renderMarkdown(hostile);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('says so when a project publishes nothing', () => {
    renderMarkdown('   ');
    expect(screen.getByText('This project publishes no description.')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------
// The security floor
// ---------------------------------------------------------------------------------------

describe('ModDescription — third-party text is never trusted', () => {
  it('renders an injected script tag as nothing at all', () => {
    const { container } = renderMarkdown(
      'Before <script>window.pwned = true</script><img src=x onerror="window.pwned = true"> after',
    );

    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
    // The `<img src=x onerror=…>` is raw HTML, not Markdown, so it is dropped whole.
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('Before');
    expect(container.textContent).toContain('after');
    expect(container.textContent).not.toContain('onerror');
  });

  it('refuses a javascript: link, keeping the words', () => {
    const { container } = renderMarkdown('[Click me](javascript:alert(1))');

    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('Click me');
  });

  it('refuses a data: image source', () => {
    const { container } = renderMarkdown(
      '![a picture of something](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).not.toContain('data:');
    expect(container.textContent).not.toContain('base64');
    expect(container.textContent).toBe('a picture of something');
  });

  it('marks every outbound link so a new tab cannot reach back', () => {
    renderMarkdown('[Modrinth](https://modrinth.com)');

    const link = screen.getByRole('link', { name: 'Modrinth' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(link.getAttribute('rel')).toContain('nofollow');
  });

  it('never emits an image tag, so a description cannot phone home', () => {
    const { container } = renderMarkdown(
      '![a screenshot of the config screen](https://cdn.modrinth.com/a.png)',
    );

    // The caption survives; the request does not.
    expect(container.textContent).toBe('a screenshot of the config screen');
    expect(container.querySelector('img')).toBeNull();
  });
});
