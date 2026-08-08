import type { z } from 'zod';
import type { blueprintSchema, Blueprint, ServerAllocation } from '@platter/shared';
import { counterStrike2Blueprint } from './counter-strike-2.js';
import { dontStarveTogetherBlueprint } from './dont-starve-together.js';
import { enshroudedBlueprint } from './enshrouded.js';
import { factorioBlueprint } from './factorio.js';
import { minecraftBedrockBlueprint } from './minecraft-bedrock.js';
import { minecraftJavaBlueprint, minecraftJavaEnvironment } from './minecraft-java.js';
import { palworldBlueprint, palworldEnvironment } from './palworld.js';
import { projectZomboidBlueprint, projectZomboidEnvironment } from './project-zomboid.js';
import { rustBlueprint } from './rust.js';
import { satisfactoryBlueprint } from './satisfactory.js';
import { terrariaBlueprint } from './terraria.js';
import { valheimBlueprint } from './valheim.js';

/**
 * The blueprint catalogue.
 *
 * Blueprints are data, deliberately. Nothing in here executes anything or knows what a
 * container is — a blueprint says which community image to run, what an operator may change,
 * how to tell from the log that the game finished booting, and how to shut it down without
 * losing the world. Adding a game is a new file in this directory and one line below.
 *
 * `services/blueprints.ts` parses every definition against the frozen `blueprintSchema` at
 * module load, so a malformed entry stops the process at startup instead of surfacing weeks
 * later as a server that will not boot.
 */

/**
 * A blueprint before schema defaults are applied.
 *
 * Definitions are written as `z.input`, not `Blueprint`, so a file only spells out the fields
 * it actually cares about — `advanced`, `hidden`, `protocol` and the rest come from the
 * schema. The parsed, fully-populated `Blueprint` is what every consumer receives.
 */
export type BlueprintDefinition = z.input<typeof blueprintSchema>;

/**
 * The parts of a server a blueprint may look at when building its environment.
 *
 * Structurally a subset of the shared `Server` DTO, so callers pass the DTO straight through
 * rather than assembling a second object that can drift from it.
 */
export interface BlueprintServerContext {
  id: string;
  name: string;
  limits: { memoryMb: number; cpuCores: number };
  /** Host-side ports, so a blueprint can advertise the address players will actually dial. */
  allocations: readonly ServerAllocation[];
}

export interface EnvironmentHookContext {
  blueprint: Blueprint;
  /** Values already resolved from the blueprint's variables, including defaults. */
  values: Readonly<Record<string, string>>;
  server: BlueprintServerContext;
}

/**
 * Per-blueprint environment that cannot be expressed as static data — anything derived from
 * the container limits or the allocated ports.
 *
 * What a hook returns is merged over the resolved values, so a hook must decide for itself
 * whether the operator has already answered the question. Every hook here returns `{}` when
 * the corresponding variable is set, which keeps "the operator wins" true by construction.
 */
export type EnvironmentHook = (context: EnvironmentHookContext) => Record<string, string>;

/** Order matters: this is the order the blueprint picker shows, so Minecraft leads. */
export const BLUEPRINT_DEFINITIONS: readonly BlueprintDefinition[] = [
  minecraftJavaBlueprint,
  minecraftBedrockBlueprint,
  valheimBlueprint,
  palworldBlueprint,
  projectZomboidBlueprint,
  factorioBlueprint,
  satisfactoryBlueprint,
  terrariaBlueprint,
  enshroudedBlueprint,
  rustBlueprint,
  counterStrike2Blueprint,
  dontStarveTogetherBlueprint,
];

/** Keyed by blueprint key; a hook for an unknown key is rejected at load. */
export const ENVIRONMENT_HOOKS: ReadonlyMap<string, EnvironmentHook> = new Map([
  ['minecraft-java', minecraftJavaEnvironment],
  ['project-zomboid', projectZomboidEnvironment],
  ['palworld', palworldEnvironment],
]);

// Minecraft is the product's first-class game, and the mods, players and AI services all need
// to reason about its server types and versions. Re-exported here so nothing outside this
// directory has to know which file the table happens to live in.
export {
  MINECRAFT_SERVER_TYPES,
  MINECRAFT_TYPE_FAMILIES,
  compareMinecraftVersions,
  jvmHeapMb,
  minecraftAcceptsMods,
  minecraftAcceptsPlugins,
  minecraftModTarget,
  minecraftServerType,
  minecraftSupportsQuery,
  minecraftSupportsRcon,
  minecraftVersionAtLeast,
  parseMinecraftVersion,
  type MinecraftModTarget,
  type MinecraftServerTypeInfo,
  type MinecraftTypeFamily,
  type MinecraftVersionChannel,
  type ParsedMinecraftVersion,
} from './minecraft-java.js';
