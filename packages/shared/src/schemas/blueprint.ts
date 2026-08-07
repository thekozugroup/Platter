import { z } from 'zod';
import {
  BLUEPRINT_CATEGORIES,
  LIMITS,
  STOP_STRATEGIES,
  VARIABLE_TYPES,
} from '../domain.js';
import { portSchema } from './common.js';

/**
 * A blueprint (a "platter") is a declarative recipe for one game: which image to run,
 * what the operator is allowed to configure, how to tell when it finished booting, and
 * how to shut it down cleanly. Blueprints are data, not code, so adding a game never
 * means shipping a new build.
 */

export const blueprintVariableSchema = z
  .object({
    key: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, 'Use SCREAMING_SNAKE_CASE')
      .max(128),
    label: z.string().min(1).max(80),
    description: z.string().max(400).default(''),
    type: z.enum(VARIABLE_TYPES),
    default: z.union([z.string(), z.number(), z.boolean()]).nullable().default(null),
    required: z.boolean().default(false),
    /** Options for `enum` variables, as value/label pairs so the UI can be friendly. */
    options: z
      .array(z.object({ value: z.string(), label: z.string() }))
      .default([]),
    min: z.number().nullable().default(null),
    max: z.number().nullable().default(null),
    /** Extra validation for `string` variables, as a RegExp source string. */
    pattern: z.string().nullable().default(null),
    /** Hidden variables are set by the blueprint itself and never shown to operators. */
    hidden: z.boolean().default(false),
    /** Advanced variables are collapsed behind a disclosure in the UI. */
    advanced: z.boolean().default(false),
  })
  .superRefine((variable, ctx) => {
    if (variable.type === 'enum' && variable.options.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Enum variables need at least one option',
        path: ['options'],
      });
    }
    if (variable.min !== null && variable.max !== null && variable.min > variable.max) {
      ctx.addIssue({ code: 'custom', message: 'min cannot exceed max', path: ['min'] });
    }
  });
export type BlueprintVariable = z.infer<typeof blueprintVariableSchema>;

export const blueprintPortSchema = z.object({
  /** Stable name used by the UI and by variable interpolation, e.g. `game`, `query`, `rcon`. */
  name: z.string().min(1).max(32),
  label: z.string().min(1).max(48),
  containerPort: portSchema,
  protocol: z.enum(['tcp', 'udp']).default('tcp'),
  /** The primary port is the one shown as "the address" and used for connectivity checks. */
  primary: z.boolean().default(false),
});
export type BlueprintPort = z.infer<typeof blueprintPortSchema>;

export const blueprintFileTemplateSchema = z.object({
  /** Path relative to the server's data volume. */
  path: z.string().min(1).max(512),
  /** File body; `{{VAR}}` placeholders are replaced with variable values at render time. */
  template: z.string(),
  /** Parsed format, so the UI can offer a structured editor and the AI can edit safely. */
  format: z.enum(['properties', 'yaml', 'json', 'ini', 'toml', 'text']).default('text'),
  /** Re-render on every boot, or only when the file is missing. */
  overwrite: z.boolean().default(false),
});
export type BlueprintFileTemplate = z.infer<typeof blueprintFileTemplateSchema>;

/**
 * Log-line heuristics. Game servers do not have a machine-readable "I'm up" signal, so
 * each blueprint declares the patterns that mean ready / crashed / player-joined.
 */
export const blueprintSignalsSchema = z.object({
  ready: z.array(z.string()).default([]),
  crash: z.array(z.string()).default([]),
  playerJoin: z.array(z.string()).default([]),
  playerLeave: z.array(z.string()).default([]),
});
export type BlueprintSignals = z.infer<typeof blueprintSignalsSchema>;

export const blueprintSchema = z.object({
  /** Stable slug, e.g. `minecraft-java`. This is the join key used by servers. */
  key: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/, 'Lowercase slug'),
  name: z.string().min(1).max(80),
  game: z.string().min(1).max(80),
  summary: z.string().max(200).default(''),
  description: z.string().max(4000).default(''),
  category: z.enum(BLUEPRINT_CATEGORIES).default('other'),
  /** Container image, digest-pinnable. */
  image: z.string().min(1).max(400),
  /** Two-letter monogram plus a hue, so the UI needs no image assets to look intentional. */
  icon: z.object({
    monogram: z.string().min(1).max(3),
    hue: z.number().int().min(0).max(360),
  }),
  minMemoryMb: z.number().int().min(LIMITS.minMemoryMb).max(LIMITS.maxMemoryMb),
  recommendedMemoryMb: z.number().int().min(LIMITS.minMemoryMb).max(LIMITS.maxMemoryMb),
  minDiskMb: z.number().int().min(LIMITS.minDiskMb).max(LIMITS.maxDiskMb),
  ports: z.array(blueprintPortSchema).min(1),
  variables: z.array(blueprintVariableSchema).default([]),
  files: z.array(blueprintFileTemplateSchema).default([]),
  signals: blueprintSignalsSchema.default({
    ready: [],
    crash: [],
    playerJoin: [],
    playerLeave: [],
  }),
  /** Optional override; most images have a correct ENTRYPOINT already. */
  command: z.array(z.string()).nullable().default(null),
  stop: z.object({
    strategy: z.enum(STOP_STRATEGIES).default('signal'),
    /** Console command for `command` strategy (e.g. `stop`, `quit`). */
    command: z.string().nullable().default(null),
    signal: z.string().default('SIGTERM'),
    timeoutSeconds: z.number().int().min(1).max(600).default(30),
  }),
  /** Absolute path inside the container where the game data volume is mounted. */
  dataPath: z.string().min(1).default('/data'),
  /** Feature flags that light up UI affordances (console input, mod browser, …). */
  features: z
    .object({
      console: z.boolean().default(true),
      rcon: z.boolean().default(false),
      mods: z.boolean().default(false),
      worldUpload: z.boolean().default(true),
      playerList: z.boolean().default(false),
    })
    .default({
      console: true,
      rcon: false,
      mods: false,
      worldUpload: true,
      playerList: false,
    }),
  /** Human docs link shown in the UI's help affordance. */
  docsUrl: z.string().url().nullable().default(null),
});
export type Blueprint = z.infer<typeof blueprintSchema>;

/** Trimmed shape for the blueprint picker — no templates, no hidden variables. */
export const blueprintSummarySchema = blueprintSchema.pick({
  key: true,
  name: true,
  game: true,
  summary: true,
  category: true,
  icon: true,
  minMemoryMb: true,
  recommendedMemoryMb: true,
  minDiskMb: true,
  features: true,
});
export type BlueprintSummary = z.infer<typeof blueprintSummarySchema>;
