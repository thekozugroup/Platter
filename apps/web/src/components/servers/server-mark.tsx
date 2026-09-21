import { useState } from 'react';
import type { BlueprintSummary } from '@platter/shared';
import { GameIcon, type GameIconSize } from '@/components/common/game-icon';
import { useServerModpack } from '@/hooks';
import { cn } from '@/lib/utils';

/**
 * What a server looks like in a list.
 *
 * For most servers that is the game's mark. For one running a published modpack it is the
 * pack's own artwork, because that is what the server *is* to the person running it: three
 * Minecraft servers wearing three identical pickaxes is the monogram problem again, one
 * level up — a list you have to read the labels of.
 *
 * The pack is resolved by a separate request, deliberately: answering it means asking
 * Modrinth or Feed the Beast, and the dashboard has to paint whether or not they are
 * reachable. Until it resolves, and forever if it never does, this is exactly the game mark
 * it replaces — there is no spinner and no gap, because the fallback is not a degraded
 * state, it is a correct picture of the server.
 */

/** `GameIcon`'s sizes, in pixels, so the artwork lands on the same grid as the mark. */
const SIZE_CLASS: Record<GameIconSize, string> = {
  xs: 'size-5',
  sm: 'size-7',
  md: 'size-11',
  lg: 'size-16',
};

export interface ServerMarkProps {
  serverId: string;
  serverName: string;
  blueprintKey: string;
  /** The game's own mark, used until a pack resolves and whenever one does not. */
  blueprint?: Pick<BlueprintSummary, 'icon'> | undefined;
  size?: GameIconSize;
  /** Accessible name. Omit where the server's name is already written beside the mark. */
  label?: string | undefined;
  className?: string | undefined;
}

export function ServerMark({
  serverId,
  serverName,
  blueprintKey,
  blueprint,
  size = 'md',
  label,
  className,
}: ServerMarkProps) {
  const [failed, setFailed] = useState(false);
  const modpack = useServerModpack(serverId);
  const iconUrl = modpack.data?.modpack?.iconUrl ?? null;

  const mark = (
    <GameIcon
      blueprintKey={blueprintKey}
      className={className}
      glyph={blueprint?.icon.glyph}
      hue={blueprint?.icon.hue}
      monogram={blueprint?.icon.monogram}
      name={serverName}
      size={size}
      {...(label ? { label } : {})}
    />
  );

  if (iconUrl === null || failed) return mark;

  /*
   * Square, like every other piece of content imagery in the product: the design language
   * rests on rounded chrome against square content, and artwork that borrows the chrome's
   * radius erases the one contrast the whole system is built on.
   *
   * A failed load falls back to the mark rather than to a broken-image glyph. Registry
   * artwork is remote, and a self-hosted panel on a locked-down network frequently cannot
   * reach it — a row of broken tiles reads as a broken product.
   */
  return (
    <img
      alt=""
      className={cn('shrink-0 bg-fill-tertiary object-cover', SIZE_CLASS[size], className)}
      loading="lazy"
      onError={() => setFailed(true)}
      src={iconUrl}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    />
  );
}
