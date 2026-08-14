import type React from 'react';
import { cn } from '@/lib/utils';

/**
 * Platter's mark — the same path as `public/logo.svg`, kept byte-identical.
 *
 * Inlined as a component rather than loaded from `/logo.svg` through an `<img>`, for two
 * reasons that both matter here. The mark has to take `currentColor` — the design system has
 * no brand hue, so the mark is whatever colour the text beside it is, in both themes and in
 * the sidebar's muted-then-hover states — and an `<img>` cannot inherit colour. And the mark
 * sits in the first paint of the login screen, where a second network round trip for a 550
 * byte file is a visible pop-in on a cold load.
 *
 * `public/logo.svg` stays for the surfaces that cannot run React — the README header, and
 * anything linking to a file. Its path data and this one are the same string; changing one
 * without the other is the bug to watch for.
 *
 * Decorative by default, and today that covers every call site: the sidebar, the mobile
 * header, the login screen and first-run setup all write "Platter" immediately beside it, so
 * naming the graphic too would announce the product twice. `title` exists for a surface that
 * shows the mark alone, and turns it into a named `img` rather than a hidden one.
 */
export interface PlatterMarkProps extends React.SVGProps<SVGSVGElement> {
  /** Accessible name. Omit when "Platter" is already written next to the mark. */
  title?: string | undefined;
}

export function PlatterMark({ className, title, ...props }: PlatterMarkProps) {
  return (
    <svg
      aria-hidden={title ? undefined : true}
      className={cn('size-6 shrink-0', className)}
      fill="currentColor"
      role={title ? 'img' : undefined}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <path d="M6 2h8v2H6zM4 4h12v2H4zM2 6h16v8H2zM4 14h12v2H4zM6 16h8v2H6zM16 16h2v2h-2zM18 18h2v2h-2zM20 20h2v2h-2z" />
    </svg>
  );
}
