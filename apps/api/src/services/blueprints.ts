import {
  blueprintSchema,
  blueprintSummarySchema,
  type Blueprint,
  type BlueprintCategory,
  type BlueprintFileTemplate,
  type BlueprintSummary,
  type BlueprintVariable,
} from '@platter/shared';
import {
  BLUEPRINT_DEFINITIONS,
  ENVIRONMENT_HOOKS,
  type BlueprintDefinition,
  type BlueprintServerContext,
} from '../blueprints/index.js';
import { internal, notFound, zodDetails } from '../lib/errors.js';

/**
 * The catalogue, parsed once at import.
 *
 * Every blueprint is validated the moment this module loads, and a bad one throws before the
 * HTTP server binds. That is deliberate: the alternative is a definition with a typo sitting
 * quietly in the picker until somebody creates a server from it, and then failing somewhere
 * far from the cause. A catalogue is small, static and entirely ours — there is no reason to
 * discover a problem in it at runtime.
 */

// ---------------------------------------------------------------------------
// Load-time validation
// ---------------------------------------------------------------------------

/** Values a variable may be given, mirroring what ends up in the container environment. */
const MAX_VARIABLE_VALUE_LENGTH = 2048;

/**
 * Tags that mean "whatever was pushed most recently".
 *
 * A blueprint pinned to one of these is a time bomb: an upstream release retroactively
 * changes what every server on that blueprint runs, all at once, with no change on our side
 * to point at when they break. Digests and dated tags are the only acceptable pins.
 */
const MOVING_TAGS = new Set([
  'latest',
  'stable',
  'dev',
  'develop',
  'devel',
  'main',
  'master',
  'edge',
  'nightly',
  'testing',
  'unstable',
  'rolling',
]);

function fail(key: string, problem: string): never {
  throw internal(`Blueprint "${key}" is invalid: ${problem}`);
}

function assertPinnedImage(key: string, image: string): void {
  if (image.includes('@sha256:')) return;

  // Only the last path segment can carry a tag; a registry host may contain a port colon.
  const lastSegment = image.slice(image.lastIndexOf('/') + 1);
  const separator = lastSegment.lastIndexOf(':');
  if (separator < 1) {
    fail(key, `image "${image}" has no tag or digest — pin it so an upstream push cannot move it`);
  }
  const tag = lastSegment.slice(separator + 1);
  if (MOVING_TAGS.has(tag.toLowerCase())) {
    fail(key, `image tag "${tag}" moves; pin a version tag or a digest instead`);
  }
}

function assertPorts(blueprint: Blueprint): void {
  const primaries = blueprint.ports.filter((port) => port.primary);
  if (primaries.length !== 1) {
    fail(
      blueprint.key,
      `${primaries.length} ports are marked primary; exactly one is the address players use`,
    );
  }

  const names = new Set<string>();
  for (const port of blueprint.ports) {
    if (names.has(port.name)) fail(blueprint.key, `duplicate port name "${port.name}"`);
    names.add(port.name);
  }
}

function assertVariable(key: string, variable: BlueprintVariable): void {
  if (variable.type === 'enum') {
    const values = new Set(variable.options.map((option) => option.value));
    if (values.size !== variable.options.length) {
      fail(key, `variable ${variable.key} has duplicate enum values`);
    }
    if (variable.default !== null && !values.has(String(variable.default))) {
      fail(key, `variable ${variable.key} defaults to a value that is not one of its options`);
    }
  }

  if (variable.default === null) return;

  if (variable.type === 'number') {
    const value = Number(variable.default);
    if (!Number.isFinite(value)) fail(key, `variable ${variable.key} has a non-numeric default`);
    if (variable.min !== null && value < variable.min) {
      fail(key, `variable ${variable.key} defaults below its own minimum`);
    }
    if (variable.max !== null && value > variable.max) {
      fail(key, `variable ${variable.key} defaults above its own maximum`);
    }
    return;
  }

  if (variable.type === 'string' || variable.type === 'password') {
    const value = String(variable.default);
    // An empty default means "unset", which is exactly what a required secret should ship as,
    // so the length and pattern rules do not apply to it.
    if (value.length === 0) return;
    if (variable.min !== null && value.length < variable.min) {
      fail(key, `variable ${variable.key} defaults shorter than its own minimum length`);
    }
    if (variable.max !== null && value.length > variable.max) {
      fail(key, `variable ${variable.key} defaults longer than its own maximum length`);
    }
    if (variable.pattern !== null && !compilePattern(key, variable).test(value)) {
      fail(key, `variable ${variable.key} defaults to a value its own pattern rejects`);
    }
  }
}

/**
 * Compiled variable patterns, keyed by source.
 *
 * Only written while the catalogue loads, so it is bounded by the catalogue rather than by
 * anything a request can influence — a cache in a daemon that runs for months has to be.
 */
const COMPILED_PATTERNS = new Map<string, RegExp>();

function compilePattern(key: string, variable: BlueprintVariable): RegExp {
  if (variable.pattern === null) fail(key, `variable ${variable.key} has no pattern to compile`);

  const cached = COMPILED_PATTERNS.get(variable.pattern);
  if (cached) return cached;

  try {
    return new RegExp(variable.pattern);
  } catch (error) {
    throw internal(`Blueprint "${key}" variable ${variable.key} has an invalid pattern`, error);
  }
}

const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function placeholdersIn(template: string): string[] {
  // `matchAll` needs the /g flag and resets lastIndex itself, so the shared regex is safe here.
  return [...template.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] ?? '');
}

function assertFiles(blueprint: Blueprint): void {
  const declared = new Set(blueprint.variables.map((variable) => variable.key));
  const paths = new Set<string>();

  for (const file of blueprint.files) {
    if (paths.has(file.path)) fail(blueprint.key, `duplicate file template path "${file.path}"`);
    paths.add(file.path);

    // Templates are written relative to the data volume and must stay inside it: an absolute
    // path or a `..` segment would let a blueprint write outside the server's own directory.
    if (file.path.startsWith('/') || file.path.includes('\\')) {
      fail(blueprint.key, `file template path "${file.path}" must be relative to the data volume`);
    }
    if (file.path.split('/').some((segment) => segment === '..' || segment === '.')) {
      fail(blueprint.key, `file template path "${file.path}" must not contain . or .. segments`);
    }

    for (const placeholder of placeholdersIn(file.template)) {
      if (!declared.has(placeholder)) {
        fail(blueprint.key, `file "${file.path}" refers to unknown variable {{${placeholder}}}`);
      }
    }
  }
}

function assertSignals(blueprint: Blueprint): void {
  const groups: Array<[string, readonly string[]]> = [
    ['ready', blueprint.signals.ready],
    ['crash', blueprint.signals.crash],
    ['playerJoin', blueprint.signals.playerJoin],
    ['playerLeave', blueprint.signals.playerLeave],
  ];

  for (const [name, patterns] of groups) {
    for (const pattern of patterns) {
      try {
        new RegExp(pattern);
      } catch (error) {
        throw internal(
          `Blueprint "${blueprint.key}" has an invalid ${name} pattern: ${pattern}`,
          error,
        );
      }
    }
  }

  // Without a ready pattern nothing ever promotes the server out of `starting`, so it would
  // spin forever in the UI while the game behind it is perfectly healthy.
  if (blueprint.signals.ready.length === 0) {
    fail(blueprint.key, 'no ready pattern — the server could never leave the starting state');
  }
}

function parseDefinition(definition: BlueprintDefinition): Blueprint {
  const parsed = blueprintSchema.safeParse(definition);
  if (!parsed.success) {
    const details = Object.entries(zodDetails(parsed.error))
      .map(([path, messages]) => `${path}: ${messages.join('; ')}`)
      .join(', ');
    throw internal(`Blueprint "${String(definition.key)}" does not match the schema — ${details}`);
  }
  return parsed.data;
}

function loadCatalogue(): ReadonlyMap<string, Blueprint> {
  const catalogue = new Map<string, Blueprint>();

  for (const definition of BLUEPRINT_DEFINITIONS) {
    const blueprint = parseDefinition(definition);
    if (catalogue.has(blueprint.key)) fail(blueprint.key, 'duplicate blueprint key');

    assertPinnedImage(blueprint.key, blueprint.image);
    assertPorts(blueprint);
    assertSignals(blueprint);
    assertFiles(blueprint);

    if (!blueprint.dataPath.startsWith('/')) {
      fail(blueprint.key, `dataPath "${blueprint.dataPath}" must be absolute`);
    }
    if (blueprint.recommendedMemoryMb < blueprint.minMemoryMb) {
      fail(blueprint.key, 'recommended memory is below the minimum');
    }
    if (blueprint.stop.strategy === 'command' && !blueprint.stop.command) {
      fail(blueprint.key, 'stop strategy is `command` but no command is set');
    }

    const seen = new Set<string>();
    for (const variable of blueprint.variables) {
      if (seen.has(variable.key)) fail(blueprint.key, `duplicate variable ${variable.key}`);
      seen.add(variable.key);
      assertVariable(blueprint.key, variable);
      // Compiling here is what makes every later `compilePattern` a map lookup, and it means
      // an unparseable pattern fails startup rather than one operator's form submission.
      if (variable.pattern !== null) {
        COMPILED_PATTERNS.set(variable.pattern, compilePattern(blueprint.key, variable));
      }
    }

    catalogue.set(blueprint.key, blueprint);
  }

  for (const key of ENVIRONMENT_HOOKS.keys()) {
    // A hook whose blueprint was renamed would otherwise silently stop running, and the only
    // symptom would be a Minecraft server sized wrong.
    if (!catalogue.has(key))
      fail(key, 'an environment hook is registered for a blueprint that does not exist');
  }

  return catalogue;
}

const CATALOGUE = loadCatalogue();

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function listBlueprints(): Blueprint[] {
  return [...CATALOGUE.values()];
}

export interface BlueprintFilter {
  category?: BlueprintCategory | undefined;
  /** Matched case-insensitively against key, name, game and summary. */
  search?: string | undefined;
  /** Only blueprints whose named feature is enabled — `rcon`, `mods`, `console`, … */
  feature?: keyof Blueprint['features'] | undefined;
}

export function listBlueprintSummaries(filter: BlueprintFilter = {}): BlueprintSummary[] {
  const search = filter.search?.trim().toLowerCase();

  return listBlueprints()
    .filter((blueprint) => {
      if (filter.category && blueprint.category !== filter.category) return false;
      if (filter.feature && !blueprint.features[filter.feature]) return false;
      if (search) {
        const haystack =
          `${blueprint.key} ${blueprint.name} ${blueprint.game} ${blueprint.summary}`.toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    })
    .map((blueprint) => blueprintSummarySchema.parse(blueprint));
}

/** Throws `not_found` for an unknown key — creation and rendering both want that. */
export function getBlueprint(key: string): Blueprint {
  const blueprint = CATALOGUE.get(key);
  if (!blueprint) throw notFound('blueprint');
  return blueprint;
}

export function hasBlueprint(key: string): boolean {
  return CATALOGUE.has(key);
}

// ---------------------------------------------------------------------------
// Variable validation
// ---------------------------------------------------------------------------

const TRUTHY = ['true', '1', 'yes', 'on'];
const FALSY = ['false', '0', 'no', 'off'];

export interface VariableValidationResult {
  ok: boolean;
  /** Normalised values, ready to store. Only populated for variables that passed. */
  values: Record<string, string>;
  /** Keyed by `variables.<KEY>`, the shape `validation_failed` details promise. */
  errors: Record<string, string[]>;
}

function addError(errors: Record<string, string[]>, key: string, message: string): void {
  const path = `variables.${key}`;
  const existing = errors[path];
  if (existing) existing.push(message);
  else errors[path] = [message];
}

function validateOne(
  blueprintKey: string,
  variable: BlueprintVariable,
  raw: string,
  errors: Record<string, string[]>,
): string | null {
  if (raw.length > MAX_VARIABLE_VALUE_LENGTH) {
    addError(errors, variable.key, `Keep this under ${MAX_VARIABLE_VALUE_LENGTH} characters.`);
    return null;
  }

  switch (variable.type) {
    case 'number': {
      const parsed = Number(raw.trim());
      if (raw.trim().length === 0 || !Number.isFinite(parsed)) {
        addError(errors, variable.key, `${variable.label} must be a number.`);
        return null;
      }
      if (variable.min !== null && parsed < variable.min) {
        addError(errors, variable.key, `${variable.label} cannot be below ${variable.min}.`);
        return null;
      }
      if (variable.max !== null && parsed > variable.max) {
        addError(errors, variable.key, `${variable.label} cannot be above ${variable.max}.`);
        return null;
      }
      // Normalised, so `007` and `7` produce the same container environment.
      return String(parsed);
    }
    case 'boolean': {
      const normalised = raw.trim().toLowerCase();
      if (TRUTHY.includes(normalised)) return 'true';
      if (FALSY.includes(normalised)) return 'false';
      addError(errors, variable.key, `${variable.label} must be true or false.`);
      return null;
    }
    case 'enum': {
      if (variable.options.some((option) => option.value === raw)) return raw;
      addError(errors, variable.key, `Choose one of the offered options for ${variable.label}.`);
      return null;
    }
    case 'string':
    case 'password': {
      // For text, `min`/`max` bound the length — there is nothing else to compare.
      if (variable.min !== null && raw.length < variable.min) {
        addError(
          errors,
          variable.key,
          `${variable.label} needs at least ${variable.min} characters.`,
        );
        return null;
      }
      if (variable.max !== null && raw.length > variable.max) {
        addError(
          errors,
          variable.key,
          `${variable.label} cannot be longer than ${variable.max} characters.`,
        );
        return null;
      }
      // Patterns were compiled once at load, so this cannot throw on a catalogue blueprint.
      if (variable.pattern !== null && !compilePattern(blueprintKey, variable).test(raw)) {
        addError(errors, variable.key, `${variable.label} is not in the expected format.`);
        return null;
      }
      return raw;
    }
  }
}

/**
 * Validates operator-supplied values against a blueprint's declared variables.
 *
 * Keys the blueprint does not declare are dropped rather than rejected: they are either a
 * stale form or an attempt to smuggle an environment variable into the container, and neither
 * deserves an error message that confirms which.
 */
export function validateVariables(
  blueprint: Blueprint,
  provided: Readonly<Record<string, string>>,
): VariableValidationResult {
  const values: Record<string, string> = {};
  const errors: Record<string, string[]> = {};

  for (const variable of blueprint.variables) {
    // Hidden variables belong to the blueprint. A request cannot set them, or a caller could
    // rewrite the port the game binds to and leave the published mapping pointing at nothing.
    const supplied = variable.hidden ? undefined : provided[variable.key];
    const fallback = variable.default === null ? undefined : String(variable.default);
    const raw = supplied !== undefined && supplied !== '' ? supplied : fallback;

    if (raw === undefined || raw === '') {
      if (variable.required) addError(errors, variable.key, `${variable.label} is required.`);
      continue;
    }

    const value = validateOne(blueprint.key, variable, raw, errors);
    if (value !== null) values[variable.key] = value;
  }

  return { ok: Object.keys(errors).length === 0, values, errors };
}

// ---------------------------------------------------------------------------
// File templates
// ---------------------------------------------------------------------------

export interface RenderedFile {
  /** Relative to the server's data volume, exactly as the blueprint declared it. */
  path: string;
  content: string;
  format: BlueprintFileTemplate['format'];
  overwrite: boolean;
}

/**
 * Makes a value safe to drop into a config file of the given format.
 *
 * A newline inside a value is the interesting case: in a line-oriented file it forges a second
 * setting, so an operator typing a server name could switch off authentication. JSON escapes
 * it properly; everything else strips it.
 */
function escapeTemplateValue(value: string, format: BlueprintFileTemplate['format']): string {
  if (format === 'json') {
    const encoded = JSON.stringify(value);
    return encoded.slice(1, -1);
  }
  return value.replace(/[\r\n]+/g, ' ');
}

/**
 * Renders a blueprint's file templates against resolved variable values.
 *
 * A `{{PLACEHOLDER}}` that names no declared variable throws rather than rendering empty: an
 * empty `password=` line looks like a deliberate choice and would silently open a server up,
 * where an exception says which blueprint is wrong. The catalogue is checked for this at load,
 * so reaching the throw means the blueprint came from somewhere else.
 *
 * A placeholder that *is* declared falls back to the variable's own default, and renders empty
 * only when there is no default either — an optional setting the operator left blank. The
 * fallback matters for hidden variables: the stored values a caller passes in may legitimately
 * not carry them, and a blank `port=` line would be a much worse answer than the blueprint's.
 */
export function renderFileTemplates(
  blueprint: Blueprint,
  variables: Readonly<Record<string, string>>,
): RenderedFile[] {
  const defaults = new Map(
    blueprint.variables.map((variable) => [
      variable.key,
      variable.default === null ? '' : String(variable.default),
    ]),
  );

  return blueprint.files.map((file) => ({
    path: file.path,
    format: file.format,
    overwrite: file.overwrite,
    content: file.template.replace(PLACEHOLDER_PATTERN, (_match, name: string) => {
      const fallback = defaults.get(name);
      if (fallback === undefined) {
        throw internal(
          `Blueprint "${blueprint.key}" file "${file.path}" refers to unknown variable {{${name}}}`,
        );
      }
      const supplied = variables[name];
      return escapeTemplateValue(
        supplied !== undefined && supplied !== '' ? supplied : fallback,
        file.format,
      );
    }),
  }));
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/**
 * The container environment for a server.
 *
 * Declared variables first — hidden ones always from the blueprint, the rest from the stored
 * values with the declared default behind them — and then the blueprint's environment hook,
 * which fills in anything that can only be known once the server has a memory limit and ports.
 *
 * Empty values are omitted rather than exported as `KEY=`. Every image in the catalogue treats
 * an unset variable as "use your default", and several would take a literal empty string as an
 * instruction to bind nothing.
 */
export function buildEnvironment(
  blueprint: Blueprint,
  values: Readonly<Record<string, string>>,
  server: BlueprintServerContext,
): Record<string, string> {
  const environment: Record<string, string> = {};

  for (const variable of blueprint.variables) {
    const fallback = variable.default === null ? '' : String(variable.default);
    const value = variable.hidden ? fallback : (values[variable.key] ?? fallback);
    if (value.length > 0) environment[variable.key] = value;
  }

  const hook = ENVIRONMENT_HOOKS.get(blueprint.key);
  if (hook) {
    Object.assign(environment, hook({ blueprint, values: environment, server }));
  }

  return environment;
}
