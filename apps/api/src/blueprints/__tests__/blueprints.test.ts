import { describe, expect, it } from 'vitest';
import { PlatterError, blueprintSchema, type Blueprint } from '@platter/shared';
import {
  BLUEPRINT_DEFINITIONS,
  ENVIRONMENT_HOOKS,
  compareMinecraftVersions,
  jvmHeapMb,
  minecraftAcceptsPlugins,
  minecraftModTarget,
  minecraftServerType,
  minecraftSupportsRcon,
  minecraftVersionAtLeast,
  parseMinecraftVersion,
} from '../index.js';
import {
  buildEnvironment,
  getBlueprint,
  listBlueprintSummaries,
  listBlueprints,
  renderFileTemplates,
  validateVariables,
} from '../../services/blueprints.js';
import type { BlueprintServerContext } from '../index.js';

const blueprints = listBlueprints();

function serverContext(overrides: Partial<BlueprintServerContext> = {}): BlueprintServerContext {
  return {
    id: 'srv_test',
    name: 'test',
    limits: { memoryMb: 4096, cpuCores: 2 },
    allocations: [
      {
        name: 'game',
        hostIp: '0.0.0.0',
        hostPort: 25731,
        containerPort: 25565,
        protocol: 'tcp',
        primary: true,
      },
    ],
    ...overrides,
  };
}

describe('catalogue', () => {
  it('loads every definition', () => {
    expect(blueprints).toHaveLength(BLUEPRINT_DEFINITIONS.length);
    expect(blueprints.length).toBeGreaterThanOrEqual(12);
  });

  it('leads with Minecraft', () => {
    expect(blueprints[0]?.key).toBe('minecraft-java');
    expect(blueprints[1]?.key).toBe('minecraft-bedrock');
  });

  it.each(blueprints.map((blueprint) => [blueprint.key, blueprint] as const))(
    '%s parses against the frozen schema',
    (_key, blueprint) => {
      expect(() => blueprintSchema.parse(blueprint)).not.toThrow();
    },
  );

  it.each(blueprints.map((blueprint) => [blueprint.key, blueprint] as const))(
    '%s has exactly one primary port and unique port names',
    (_key, blueprint) => {
      expect(blueprint.ports.filter((port) => port.primary)).toHaveLength(1);
      const names = blueprint.ports.map((port) => port.name);
      expect(new Set(names).size).toBe(names.length);
    },
  );

  it.each(blueprints.map((blueprint) => [blueprint.key, blueprint] as const))(
    '%s recommends at least its minimum memory',
    (_key, blueprint) => {
      expect(blueprint.recommendedMemoryMb).toBeGreaterThanOrEqual(blueprint.minMemoryMb);
    },
  );

  it.each(blueprints.map((blueprint) => [blueprint.key, blueprint] as const))(
    '%s has signal patterns that compile',
    (_key, blueprint) => {
      const patterns = [
        ...blueprint.signals.ready,
        ...blueprint.signals.crash,
        ...blueprint.signals.playerJoin,
        ...blueprint.signals.playerLeave,
      ];
      expect(patterns.length).toBeGreaterThan(0);
      for (const pattern of patterns) {
        expect(() => new RegExp(pattern)).not.toThrow();
      }
      expect(blueprint.signals.ready.length).toBeGreaterThan(0);
    },
  );

  it.each(blueprints.map((blueprint) => [blueprint.key, blueprint] as const))(
    '%s has variable patterns that compile',
    (_key, blueprint) => {
      for (const variable of blueprint.variables) {
        if (variable.pattern === null) continue;
        expect(() => new RegExp(variable.pattern as string)).not.toThrow();
      }
    },
  );

  it.each(blueprints.map((blueprint) => [blueprint.key, blueprint] as const))(
    '%s pins its image to a tag or digest that cannot move',
    (_key, blueprint) => {
      const moving = /(?::(latest|stable|dev|main|master|edge|nightly)$)/;
      expect(blueprint.image).toMatch(/[@:]/);
      expect(blueprint.image).not.toMatch(moving);
    },
  );

  it.each(blueprints.map((blueprint) => [blueprint.key, blueprint] as const))(
    '%s stops in a way that cannot corrupt a save',
    (_key, blueprint) => {
      if (blueprint.stop.strategy === 'command') {
        expect(blueprint.stop.command).toBeTruthy();
        // A console command is only deliverable if the console is wired up.
        expect(blueprint.features.console).toBe(true);
      } else {
        expect(blueprint.stop.command).toBeNull();
        expect(blueprint.stop.signal).toMatch(/^SIG[A-Z]+$/);
      }
      expect(blueprint.stop.timeoutSeconds).toBeGreaterThan(0);
    },
  );

  it('registers environment hooks only for blueprints that exist', () => {
    for (const key of ENVIRONMENT_HOOKS.keys()) {
      expect(() => getBlueprint(key)).not.toThrow();
    }
  });

  it('throws not_found for an unknown key', () => {
    try {
      getBlueprint('halo-3');
      expect.unreachable('getBlueprint should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PlatterError);
      expect((error as PlatterError).code).toBe('not_found');
    }
  });
});

describe('listBlueprintSummaries', () => {
  it('drops variables and templates', () => {
    const [summary] = listBlueprintSummaries();
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty('variables');
    expect(summary).not.toHaveProperty('files');
    expect(summary).not.toHaveProperty('image');
  });

  it('filters by category, feature and search', () => {
    expect(listBlueprintSummaries({ category: 'sandbox' }).every((b) => b.key !== 'valheim')).toBe(
      true,
    );
    expect(listBlueprintSummaries({ feature: 'rcon' }).every((b) => b.features.rcon)).toBe(true);
    expect(listBlueprintSummaries({ search: 'MINECRAFT' })).toHaveLength(2);
    expect(listBlueprintSummaries({ search: 'no such game' })).toHaveLength(0);
  });
});

describe('minecraft server types', () => {
  const minecraft = getBlueprint('minecraft-java');
  const typeVariable = minecraft.variables.find((variable) => variable.key === 'TYPE');

  it('offers every type as a guided option', () => {
    expect(typeVariable?.type).toBe('enum');
    const values = typeVariable?.options.map((option) => option.value) ?? [];
    for (const expected of [
      'VANILLA',
      'PAPER',
      'PURPUR',
      'SPIGOT',
      'BUKKIT',
      'FOLIA',
      'PUFFERFISH',
      'LEAF',
      'FABRIC',
      'FORGE',
      'NEOFORGE',
      'QUILT',
      'MOHIST',
      'MAGMA',
      'ARCLIGHT',
      'KETTING',
      'CRUCIBLE',
      'SPONGEVANILLA',
      'LIMBO',
      'AUTO_CURSEFORGE',
      'MODRINTH',
      'FTBA',
      'CUSTOM',
    ]) {
      expect(values).toContain(expected);
    }
  });

  it('routes mods and plugins to the right directory', () => {
    expect(minecraftModTarget('PAPER')).toBe('plugins');
    expect(minecraftModTarget('purpur')).toBe('plugins');
    expect(minecraftModTarget('FABRIC')).toBe('mods');
    expect(minecraftModTarget('NEOFORGE')).toBe('mods');
    expect(minecraftModTarget('MODRINTH')).toBe('mods');
    expect(minecraftModTarget('VANILLA')).toBeNull();
    expect(minecraftModTarget('CUSTOM')).toBeNull();
    expect(minecraftModTarget('NOT_A_TYPE')).toBeNull();
  });

  it('knows hybrids take both', () => {
    expect(minecraftAcceptsPlugins('MOHIST')).toBe(true);
    expect(minecraftAcceptsPlugins('FABRIC')).toBe(false);
    expect(minecraftServerType('ARCLIGHT')?.family).toBe('hybrid');
  });

  it('does not claim RCON for servers that have none', () => {
    expect(minecraftSupportsRcon('PAPER')).toBe(true);
    expect(minecraftSupportsRcon('LIMBO')).toBe(false);
    expect(minecraftSupportsRcon('NOT_A_TYPE')).toBe(false);
  });

  it('requires the EULA and never pre-accepts it', () => {
    const eula = minecraft.variables.find((variable) => variable.key === 'EULA');
    expect(eula?.required).toBe(true);
    expect(eula?.default).toBeNull();
    expect(eula?.hidden).toBe(false);
  });
});

describe('compareMinecraftVersions', () => {
  it('orders 1.9 below 1.10, which string comparison gets backwards', () => {
    expect('1.9' > '1.10').toBe(true);
    expect(compareMinecraftVersions('1.9', '1.10')).toBeLessThan(0);
    expect(compareMinecraftVersions('1.10', '1.9')).toBeGreaterThan(0);
  });

  it('orders patch releases above their base version', () => {
    expect(compareMinecraftVersions('1.20.2', '1.20')).toBeGreaterThan(0);
    expect(compareMinecraftVersions('1.20', '1.9')).toBeGreaterThan(0);
    expect(compareMinecraftVersions('1.20', '1.20.0')).toBe(0);
    expect(compareMinecraftVersions('1.21.4', '1.21.10')).toBeLessThan(0);
  });

  it('sorts a list the way a human would', () => {
    const sorted = ['1.10', '1.9', '1.20.2', '1.8.9', '1.20', '1.21'].sort(
      compareMinecraftVersions,
    );
    expect(sorted).toEqual(['1.8.9', '1.9', '1.10', '1.20', '1.20.2', '1.21']);
  });

  it('places pre-releases and candidates below the final release', () => {
    expect(compareMinecraftVersions('1.20.5-pre3', '1.20.5')).toBeLessThan(0);
    expect(compareMinecraftVersions('1.20.5-pre1', '1.20.5-pre3')).toBeLessThan(0);
    expect(compareMinecraftVersions('1.20.5-pre3', '1.20.5-rc1')).toBeLessThan(0);
    expect(compareMinecraftVersions('1.20.5-rc1', '1.20.4')).toBeGreaterThan(0);
  });

  it('orders snapshots among themselves and above releases', () => {
    expect(compareMinecraftVersions('24w14a', '24w13b')).toBeGreaterThan(0);
    expect(compareMinecraftVersions('24w14a', '24w14b')).toBeLessThan(0);
    expect(compareMinecraftVersions('23w45a', '24w01a')).toBeLessThan(0);
    expect(compareMinecraftVersions('24w14a', '1.21')).toBeGreaterThan(0);
  });

  it('ranks the moving aliases above everything concrete', () => {
    expect(compareMinecraftVersions('LATEST', '1.21')).toBeGreaterThan(0);
    expect(compareMinecraftVersions('LATEST', 'SNAPSHOT')).toBeGreaterThan(0);
    expect(compareMinecraftVersions('SNAPSHOT', '24w14a')).toBeGreaterThan(0);
  });

  it('is a total order even for values it cannot parse', () => {
    expect(compareMinecraftVersions('nonsense', 'nonsense')).toBe(0);
    expect(compareMinecraftVersions('1.20', 'nonsense')).toBeGreaterThan(0);
    expect(compareMinecraftVersions('nonsense', '1.20')).toBeLessThan(0);
    expect(parseMinecraftVersion('nonsense')).toBeNull();
    expect(parseMinecraftVersion('')).toBeNull();
  });

  it('backs minecraftVersionAtLeast', () => {
    expect(minecraftVersionAtLeast('1.20.4', '1.20')).toBe(true);
    expect(minecraftVersionAtLeast('1.9', '1.10')).toBe(false);
    expect(minecraftVersionAtLeast('1.20', '1.20')).toBe(true);
  });
});

describe('jvmHeapMb', () => {
  it('always leaves the container room outside the heap', () => {
    for (const limit of [1024, 2048, 4096, 8192, 16384, 65536]) {
      const heap = jvmHeapMb(limit);
      expect(heap).toBeLessThan(limit);
      expect(heap).toBeGreaterThan(0);
    }
  });

  it('reserves at least half a gigabyte', () => {
    expect(1024 - jvmHeapMb(1024)).toBeGreaterThanOrEqual(512);
    expect(4096 - jvmHeapMb(4096)).toBeGreaterThanOrEqual(512);
  });
});

describe('validateVariables', () => {
  const minecraft = getBlueprint('minecraft-java');

  it('applies defaults and normalises values', () => {
    const result = validateVariables(minecraft, { EULA: 'yes' });
    expect(result.ok).toBe(true);
    expect(result.values['EULA']).toBe('true');
    expect(result.values['TYPE']).toBe('PAPER');
    expect(result.values['MAX_PLAYERS']).toBe('20');
  });

  it('catches a missing required variable', () => {
    const result = validateVariables(minecraft, {});
    expect(result.ok).toBe(false);
    expect(result.errors['variables.EULA']).toBeDefined();
  });

  it('catches a bad enum choice', () => {
    const result = validateVariables(minecraft, { EULA: 'true', TYPE: 'BEDROCK' });
    expect(result.ok).toBe(false);
    expect(result.errors['variables.TYPE']?.[0]).toMatch(/offered options/);
  });

  it('catches an out-of-range number', () => {
    const low = validateVariables(minecraft, { EULA: 'true', MAX_PLAYERS: '0' });
    expect(low.ok).toBe(false);
    expect(low.errors['variables.MAX_PLAYERS']?.[0]).toMatch(/cannot be below 1/);

    const high = validateVariables(minecraft, { EULA: 'true', VIEW_DISTANCE: '999' });
    expect(high.ok).toBe(false);
    expect(high.errors['variables.VIEW_DISTANCE']?.[0]).toMatch(/cannot be above 32/);

    const wrong = validateVariables(minecraft, { EULA: 'true', MAX_PLAYERS: 'lots' });
    expect(wrong.ok).toBe(false);
    expect(wrong.errors['variables.MAX_PLAYERS']?.[0]).toMatch(/must be a number/);
  });

  it('catches a value the pattern rejects', () => {
    const result = validateVariables(minecraft, { EULA: 'true', VERSION: '1.20; rm -rf /' });
    expect(result.ok).toBe(false);
    expect(result.errors['variables.VERSION']).toBeDefined();
  });

  it('reports every bad field at once, not just the first', () => {
    const result = validateVariables(minecraft, { TYPE: 'NOPE', MAX_PLAYERS: '-5' });
    expect(Object.keys(result.errors).sort()).toEqual([
      'variables.EULA',
      'variables.MAX_PLAYERS',
      'variables.TYPE',
    ]);
  });

  it('drops undeclared keys instead of exporting them', () => {
    const result = validateVariables(minecraft, { EULA: 'true', LD_PRELOAD: '/tmp/evil.so' });
    expect(result.ok).toBe(true);
    expect(result.values['LD_PRELOAD']).toBeUndefined();
  });

  it('ignores an attempt to set a hidden variable', () => {
    const result = validateVariables(minecraft, { EULA: 'true', SERVER_PORT: '1234' });
    expect(result.values['SERVER_PORT']).toBe('25565');
  });

  it('enforces a minimum length on a password', () => {
    const zomboid = getBlueprint('project-zomboid');
    const result = validateVariables(zomboid, {
      ADMIN_PASSWORD: 'short',
      RCON_PASSWORD: 'shorter',
    });
    expect(result.ok).toBe(false);
    expect(result.errors['variables.ADMIN_PASSWORD']?.[0]).toMatch(/at least 8 characters/);
  });
});

describe('renderFileTemplates', () => {
  const terraria = getBlueprint('terraria');
  const factorio = getBlueprint('factorio');

  it('substitutes declared placeholders', () => {
    const { values } = validateVariables(terraria, { WORLD_NAME: 'Corruption', MAX_PLAYERS: '4' });
    const [file] = renderFileTemplates(terraria, values);
    expect(file?.path).toBe('config/serverconfig.txt');
    expect(file?.content).toContain('worldname=Corruption');
    expect(file?.content).toContain('maxplayers=4');
    expect(file?.content).not.toContain('{{');
  });

  it('renders a declared placeholder with no value as empty', () => {
    const { values } = validateVariables(terraria, {});
    const [file] = renderFileTemplates(terraria, values);
    // SEED has an empty default, so it is absent from `values` and renders blank.
    expect(file?.content).toContain('seed=\n');
  });

  it('produces valid JSON for a JSON template', () => {
    const { values } = validateVariables(factorio, {
      RCON_PASSWORD: 'hunter2hunter2',
      SERVER_NAME: 'The "Best" Server',
    });
    const settings = renderFileTemplates(factorio, values).find(
      (file) => file.path === 'config/server-settings.json',
    );
    expect(settings).toBeDefined();
    const parsed = JSON.parse(settings?.content ?? '') as { name: string; max_players: number };
    expect(parsed.name).toBe('The "Best" Server');
    expect(parsed.max_players).toBe(0);
  });

  it('cannot be used to forge an extra config line', () => {
    const { values } = validateVariables(terraria, { MOTD: 'hello\npassword=letmein' });
    const [file] = renderFileTemplates(terraria, values);
    expect(file?.content).not.toContain('\npassword=letmein');
    expect(file?.content).toContain('password=\n');
  });

  it('refuses an unknown placeholder rather than emptying it', () => {
    const forged: Blueprint = {
      ...terraria,
      files: [
        {
          path: 'config/serverconfig.txt',
          template: 'password={{NOT_DECLARED}}\n',
          format: 'properties',
          overwrite: true,
        },
      ],
    };
    expect(() => renderFileTemplates(forged, {})).toThrow(PlatterError);
    expect(() => renderFileTemplates(forged, {})).toThrow(/NOT_DECLARED/);
  });
});

describe('buildEnvironment', () => {
  it('sizes the Java heap below the container limit', () => {
    const minecraft = getBlueprint('minecraft-java');
    const { values } = validateVariables(minecraft, { EULA: 'true' });
    const environment = buildEnvironment(minecraft, values, serverContext());

    const heap = Number(environment['MAX_MEMORY']?.replace(/M$/, ''));
    expect(heap).toBeGreaterThan(0);
    expect(heap).toBeLessThan(4096);
    expect(environment['INIT_MEMORY']).toBe(environment['MAX_MEMORY']);
    expect(environment['EULA']).toBe('true');
    expect(environment['SERVER_PORT']).toBe('25565');
  });

  it('leaves an explicit memory override alone', () => {
    const minecraft = getBlueprint('minecraft-java');
    const { values } = validateVariables(minecraft, { EULA: 'true', MEMORY: '3G' });
    const environment = buildEnvironment(minecraft, values, serverContext());
    expect(environment['MEMORY']).toBe('3G');
    expect(environment['MAX_MEMORY']).toBeUndefined();
  });

  it('advertises the published host port for Palworld', () => {
    const palworld = getBlueprint('palworld');
    const { values } = validateVariables(palworld, {});
    const environment = buildEnvironment(palworld, values, serverContext());
    expect(environment['PUBLIC_PORT']).toBe('25731');
    expect(environment['PORT']).toBe('8211');
  });

  it('omits empty values instead of exporting KEY=', () => {
    const minecraft = getBlueprint('minecraft-java');
    const { values } = validateVariables(minecraft, { EULA: 'true' });
    const environment = buildEnvironment(minecraft, values, serverContext());
    expect(environment['SEED']).toBeUndefined();
    expect(Object.values(environment).every((value) => value.length > 0)).toBe(true);
  });

  it('sizes the Zomboid heap below the container limit too', () => {
    const zomboid = getBlueprint('project-zomboid');
    const { values } = validateVariables(zomboid, {
      ADMIN_PASSWORD: 'hunter2hunter2',
      RCON_PASSWORD: 'hunter2hunter2',
    });
    const environment = buildEnvironment(
      zomboid,
      values,
      serverContext({ limits: { memoryMb: 8192, cpuCores: 4 } }),
    );
    expect(Number(environment['MAX_RAM']?.replace(/m$/, ''))).toBeLessThan(8192);
  });
});
