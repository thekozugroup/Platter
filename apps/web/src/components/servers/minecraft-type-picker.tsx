import { useMemo, useState } from 'react';
import type { BlueprintVariable } from '@platter/shared';
import { ChevronDown } from 'pixelarticons/react/ChevronDown.js';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';

/**
 * Minecraft's server type — the single most consequential and most misunderstood choice a new
 * operator makes, and the reason this is not a dropdown of twenty jar names.
 *
 * "PAPER", "FABRIC" and "AUTO_CURSEFORGE" mean nothing to someone setting up a server for
 * their friends. What they need to know is: does it take plugins, does it take mods, and which
 * one do most people pick. So the twenty-odd values collapse into six plain-language families,
 * each stating in a sentence what it is and what it accepts, with Paper preselected and the
 * reason for that visible rather than implied.
 *
 * The option list itself still comes from the blueprint's own `TYPE` enum, so a type added to
 * the blueprint appears here without a code change. Only the *copy* lives in this file: a type
 * Platter has no sentence for lands in its family's "more" list with the blueprint's own label.
 */

const TYPE_VARIABLE_KEY = 'TYPE';

/** The type everyone should start on, and the one the blueprint already defaults to. */
export const RECOMMENDED_TYPE = 'PAPER';

type FamilyKey = 'vanilla' | 'plugins' | 'mods' | 'hybrid' | 'modpack' | 'utility' | 'custom';

interface Family {
  key: FamilyKey;
  title: string;
  /** One sentence, no jargon beyond the words this audience already uses. */
  blurb: string;
}

/**
 * Order matters: this is the order of increasing commitment. Vanilla, then the thing most
 * public servers actually run, then mods, then the rest.
 */
const FAMILIES: readonly Family[] = [
  {
    key: 'vanilla',
    title: 'Vanilla',
    blurb: 'The official server from Mojang. No mods, no plugins — exactly the game as shipped.',
  },
  {
    key: 'plugins',
    title: 'Plugins',
    blurb:
      'Vanilla gameplay plus server-side plugins: permissions, land claims, minigames, anti-grief. Much faster than vanilla, and players join with an unmodified client.',
  },
  {
    key: 'mods',
    title: 'Mod loaders',
    blurb:
      'For mods that add blocks, mobs and machines. Every player has to install the same mods and loader on their own client.',
  },
  {
    key: 'modpack',
    title: 'Modpacks',
    blurb:
      'Installs a published pack — CurseForge, Modrinth or Feed the Beast — and keeps it in sync on every restart. The pack chooses the loader and the version for you.',
  },
  {
    key: 'hybrid',
    title: 'Mods and plugins together',
    blurb:
      'Runs both at once. Powerful, and the least stable option here: expect bugs neither project will support.',
  },
  {
    key: 'utility',
    title: 'Utility servers',
    blurb:
      'Not a game world. A limbo holds players in a void room while the real server restarts.',
  },
  {
    key: 'custom',
    title: 'Custom jar',
    blurb: 'Runs a server jar you point at by URL or by path on the volume. You own what it does.',
  },
];

interface TypeCopy {
  /** Overrides the blueprint's own label, which carries a family suffix this UI supplies. */
  label: string;
  family: FamilyKey;
  /** What third-party code it accepts, in the words the ecosystem itself uses. */
  accepts: 'plugins' | 'mods' | 'both' | 'none';
  blurb: string;
  /** Shown without a disclosure. Everything else is behind "more". */
  primary?: boolean;
}

/**
 * Presentation copy only — the source of truth for which types exist is the blueprint. Keys
 * are the literal `TYPE` values the container image dispatches on.
 */
const TYPE_COPY: Record<string, TypeCopy> = {
  VANILLA: {
    label: 'Vanilla',
    family: 'vanilla',
    accepts: 'none',
    blurb: 'Mojang’s own server jar. Nothing added, nothing removed.',
    primary: true,
  },

  PAPER: {
    label: 'Paper',
    family: 'plugins',
    accepts: 'plugins',
    blurb:
      'The usual choice. Large performance gains over vanilla and the widest plugin support anywhere.',
    primary: true,
  },
  PURPUR: {
    label: 'Purpur',
    family: 'plugins',
    accepts: 'plugins',
    blurb: 'Paper plus several hundred extra gameplay toggles. Paper plugins drop straight in.',
  },
  SPIGOT: {
    label: 'Spigot',
    family: 'plugins',
    accepts: 'plugins',
    blurb: 'Built from source on first boot, so the first start is slow. Paper supersedes it.',
  },
  BUKKIT: {
    label: 'CraftBukkit',
    family: 'plugins',
    accepts: 'plugins',
    blurb: 'The original plugin server. Kept for very old plugins; slower than Paper in every way.',
  },
  FOLIA: {
    label: 'Folia',
    family: 'plugins',
    accepts: 'plugins',
    blurb: 'Multithreaded, for very large player counts. Most plugins need a Folia-specific build.',
  },
  PUFFERFISH: {
    label: 'Pufferfish',
    family: 'plugins',
    accepts: 'plugins',
    blurb: 'Paper fork tuned for big servers, with more aggressive entity and mob optimisation.',
  },
  LEAF: {
    label: 'Leaf',
    family: 'plugins',
    accepts: 'plugins',
    blurb: 'Paper fork focused on throughput. A few optimisations change vanilla behaviour slightly.',
  },

  FABRIC: {
    label: 'Fabric',
    family: 'mods',
    accepts: 'mods',
    blurb: 'Lightweight loader that reaches new Minecraft versions first. Popular for smaller mod sets.',
    primary: true,
  },
  FORGE: {
    label: 'Forge',
    family: 'mods',
    accepts: 'mods',
    blurb: 'The oldest loader, and the one most large modpacks were built against.',
    primary: true,
  },
  NEOFORGE: {
    label: 'NeoForge',
    family: 'mods',
    accepts: 'mods',
    blurb: 'The community fork of Forge, and the default for Forge-style mods on 1.20.2 and later.',
    primary: true,
  },
  QUILT: {
    label: 'Quilt',
    family: 'mods',
    accepts: 'mods',
    blurb: 'Fabric fork. Runs most Fabric mods, though a few refuse to load.',
  },
  SPONGEVANILLA: {
    label: 'SpongeVanilla',
    family: 'mods',
    accepts: 'mods',
    blurb: 'The Sponge plugin platform on the vanilla server. Its plugins live in mods/, not plugins/.',
  },

  AUTO_CURSEFORGE: {
    label: 'CurseForge pack',
    family: 'modpack',
    accepts: 'mods',
    blurb: 'Installs a CurseForge pack from its slug. Needs a free CurseForge API key.',
    primary: true,
  },
  MODRINTH: {
    label: 'Modrinth pack',
    family: 'modpack',
    accepts: 'mods',
    blurb: 'Installs a Modrinth pack from its project slug or URL. No API key needed.',
    primary: true,
  },
  FTBA: {
    label: 'Feed the Beast pack',
    family: 'modpack',
    accepts: 'mods',
    blurb: 'Installs an FTB pack by its numeric id from the FTB API.',
  },

  MOHIST: {
    label: 'Mohist',
    family: 'hybrid',
    accepts: 'both',
    blurb: 'Forge mods plus Bukkit plugins. Hybrids trade stability for that.',
  },
  MAGMA_MAINTAINED: {
    label: 'Magma Maintained',
    family: 'hybrid',
    accepts: 'both',
    blurb: 'The maintained continuation of Magma. Prefer it over Magma on current versions.',
  },
  MAGMA: {
    label: 'Magma (legacy)',
    family: 'hybrid',
    accepts: 'both',
    blurb: 'No longer developed. Only for pinning an old version you already run.',
  },
  ARCLIGHT: {
    label: 'Arclight',
    family: 'hybrid',
    accepts: 'both',
    blurb: 'The Bukkit API implemented on top of Forge, Fabric or NeoForge.',
  },
  KETTING: {
    label: 'Ketting',
    family: 'hybrid',
    accepts: 'both',
    blurb: 'Forge plus Bukkit for recent Minecraft versions.',
  },
  CRUCIBLE: {
    label: 'Crucible',
    family: 'hybrid',
    accepts: 'both',
    blurb: 'For 1.7.10 modpacks that also want Bukkit plugins.',
  },
  BANNER: {
    label: 'Banner',
    family: 'hybrid',
    accepts: 'both',
    blurb: 'Fabric mods plus Bukkit plugins.',
  },
  YOUER: {
    label: 'Youer',
    family: 'hybrid',
    accepts: 'both',
    blurb: 'The Mohist team’s newer hybrid, targeting current Minecraft versions.',
  },

  LIMBO: {
    label: 'Limbo',
    family: 'utility',
    accepts: 'none',
    blurb: 'Holds players in a void room while the real server restarts.',
  },
  NANOLIMBO: {
    label: 'NanoLimbo',
    family: 'utility',
    accepts: 'none',
    blurb: 'Smaller, faster limbo. Same purpose, lower footprint.',
  },

  CUSTOM: {
    label: 'Custom server jar',
    family: 'custom',
    accepts: 'none',
    blurb: 'Runs a jar you supply by URL or by path on the volume.',
    primary: true,
  },
};

const ACCEPTS_LABEL: Record<TypeCopy['accepts'], string> = {
  plugins: 'Takes plugins',
  mods: 'Takes mods',
  both: 'Takes mods and plugins',
  none: 'No mods or plugins',
};

interface TypeOption extends TypeCopy {
  value: string;
}

/**
 * The blueprint labels its enum options `"<Name> — <Family>"`. Where Platter has no copy for a
 * value it still has to appear, so the name is recovered from that label and the option lands
 * in the family the blueprint itself declared, or in "custom" if even that is unrecognisable.
 */
function fallbackCopy(option: { value: string; label: string }): TypeCopy {
  const [name = option.value, family = ''] = option.label.split(' — ');
  const normalised = family.toLowerCase();

  const guessed: FamilyKey = normalised.startsWith('plugins')
    ? 'plugins'
    : normalised.startsWith('mod loader')
      ? 'mods'
      : normalised.startsWith('mods +')
        ? 'hybrid'
        : normalised.startsWith('modpack')
          ? 'modpack'
          : normalised.startsWith('utility')
            ? 'utility'
            : normalised.startsWith('vanilla')
              ? 'vanilla'
              : 'custom';

  return {
    label: name,
    family: guessed,
    accepts: guessed === 'mods' || guessed === 'modpack' ? 'mods' : guessed === 'plugins' ? 'plugins' : guessed === 'hybrid' ? 'both' : 'none',
    blurb: 'Added by this blueprint. See the game’s own documentation for what it changes.',
  };
}

const OPTION_CARD = cn(
  'w-full flex-row-reverse items-start justify-between gap-3',
  'rounded-md border border-separator-strong bg-surface p-4 text-start',
  'transition-colors duration-150 ease-standard',
  'hover:bg-surface-hover',
  'has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2',
  'has-[input:focus-visible]:outline-label',
  'data-[state=checked]:border-label data-[state=checked]:bg-surface-active',
  'motion-reduce:transition-none!',
);

function OptionCard({ option, recommended }: { option: TypeOption; recommended: boolean }) {
  return (
    <RadioGroupItem className={OPTION_CARD} value={option.value}>
      <span className="flex flex-col gap-1.5">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-body font-semibold tracking-title text-label">{option.label}</span>
          {recommended ? (
            <span className="rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption-2 font-medium text-label-secondary">
              Recommended
            </span>
          ) : null}
        </span>
        <span className="text-footnote font-normal text-balance text-label-secondary">
          {option.blurb}
        </span>
        <span className="text-caption font-normal text-label-secondary">
          {ACCEPTS_LABEL[option.accepts]} · <code className="font-mono">{option.value}</code>
        </span>
      </span>
    </RadioGroupItem>
  );
}

function FamilySection({
  family,
  options,
  value,
}: {
  family: Family;
  options: TypeOption[];
  value: string;
}) {
  const primary = options.filter((option) => option.primary);
  const rest = options.filter((option) => !option.primary);
  // A type chosen from the overflow list must not vanish behind a closed disclosure.
  const [showRest, setShowRest] = useState(() => rest.some((option) => option.value === value));

  const shown = primary.length > 0 ? primary : rest;
  const hidden = primary.length > 0 ? rest : [];

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        {/* h3 would inherit the pixel display face; at this size it is unreadable. */}
        <h3 className="font-sans text-title-3 font-semibold text-label">{family.title}</h3>
        <p className="max-w-prose text-subhead text-balance text-label-secondary">{family.blurb}</p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {shown.map((option) => (
          <OptionCard
            key={option.value}
            option={option}
            recommended={option.value === RECOMMENDED_TYPE}
          />
        ))}
        {showRest
          ? hidden.map((option) => (
              <OptionCard key={option.value} option={option} recommended={false} />
            ))
          : null}
      </div>

      {hidden.length > 0 && !showRest ? (
        <Button
          className="h-11 w-fit rounded-button px-4 text-subhead font-medium text-label-secondary"
          onClick={() => setShowRest(true)}
          variant="ghost"
        >
          <ChevronDown aria-hidden />
          {`Show ${hidden.length} more ${family.title.toLowerCase()} option${hidden.length === 1 ? '' : 's'}`}
        </Button>
      ) : null}
    </section>
  );
}

export interface MinecraftTypePickerProps {
  /** The blueprint's own `TYPE` variable. Its `options` are the source of truth. */
  variable: BlueprintVariable;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

export function MinecraftTypePicker({
  variable,
  value,
  onChange,
  className,
}: MinecraftTypePickerProps) {
  const grouped = useMemo(() => {
    const byFamily = new Map<FamilyKey, TypeOption[]>();

    for (const option of variable.options) {
      const copy = TYPE_COPY[option.value] ?? fallbackCopy(option);
      const bucket = byFamily.get(copy.family) ?? [];
      bucket.push({ ...copy, value: option.value });
      byFamily.set(copy.family, bucket);
    }

    return FAMILIES.map((family) => ({ family, options: byFamily.get(family.key) ?? [] })).filter(
      (group) => group.options.length > 0,
    );
  }, [variable.options]);

  const selected = value === '' ? RECOMMENDED_TYPE : value;
  const selectedCopy = TYPE_COPY[selected];

  return (
    <div className={cn('flex flex-col gap-8', className)}>
      <p className="max-w-prose text-body text-balance text-label-secondary">
        This decides what your server can run. You can change it later, but switching between
        plugins and mods usually means starting the world over — so it is worth a minute now.
      </p>

      <RadioGroup
        aria-label={variable.label}
        className="gap-8"
        // Ark reports `null` when a group is cleared. A server has to have a type, so a clear
        // is not a state this picker can be in.
        onValueChange={({ value: next }) => {
          if (next !== null) onChange(next);
        }}
        value={selected}
      >
        {grouped.map((group) => (
          <FamilySection
            family={group.family}
            key={group.family.key}
            options={group.options}
            value={selected}
          />
        ))}
      </RadioGroup>

      <p aria-live="polite" className="sr-only" role="status">
        {selectedCopy
          ? `${selectedCopy.label} selected. ${ACCEPTS_LABEL[selectedCopy.accepts]}.`
          : `${selected} selected.`}
      </p>
    </div>
  );
}

/** Whether this blueprint is the one the type picker knows how to explain. */
export function hasMinecraftTypePicker(blueprintKey: string): boolean {
  return blueprintKey === 'minecraft-java';
}

/**
 * The plain-language name for a `TYPE` value, for prose elsewhere in the app.
 *
 * Sentences read to a non-technical operator must never shout `FABRIC` or `AUTO_CURSEFORGE`
 * at them. The raw value keeps its place inside the picker's own `<code>` metadata line,
 * where it is marked up as the technical identifier it is.
 */
export function minecraftTypeLabel(value: string): string {
  return TYPE_COPY[value]?.label ?? value;
}

export { TYPE_VARIABLE_KEY };
