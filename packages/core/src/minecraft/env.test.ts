import { serverSettingsSchema } from '@platter/shared';
import { describe, expect, it } from 'vitest';
import { BLOCKED_ENV, buildContainerEnv } from './env';
import { selectImage } from './manifest';

const settings = serverSettingsSchema.parse({});

const base = {
  loader: 'paper' as const,
  gameVersion: '1.21.4',
  settings,
  memoryMiB: 4096,
  rconPassword: 'secret-password',
};

describe('buildContainerEnv', () => {
  it('accepts the EULA and pins the exact version', () => {
    const env = buildContainerEnv(base);
    expect(env.EULA).toBe('TRUE');
    expect(env.TYPE).toBe('PAPER');
    // Never LATEST: the image upgrades on restart when told LATEST, which would silently migrate
    // somebody's world to a new Minecraft version and strand their mods.
    expect(env.VERSION).toBe('1.21.4');
    expect(env.VERSION).not.toBe('LATEST');
  });

  it('leaves the JVM headroom below the container limit', () => {
    // Handing the whole limit to -Xmx gets the container OOM-killed by the kernel with nothing
    // useful in the log — Netty's off-heap buffers and metaspace live outside the heap.
    const env = buildContainerEnv(base);
    const heap = Number(env.MAX_MEMORY?.replace('M', ''));
    expect(heap).toBeLessThan(4096);
    expect(heap).toBeGreaterThan(2048);
  });

  it('enables Aikar flags only when the heap is large enough to benefit', () => {
    expect(buildContainerEnv({ ...base, memoryMiB: 4096 }).USE_AIKAR_FLAGS).toBe('TRUE');
    // Below ~2 GiB the region sizing Aikar's flags assume does not hold and defaults do better.
    expect(buildContainerEnv({ ...base, memoryMiB: 1024 }).USE_AIKAR_FLAGS).toBe('FALSE');
  });

  it('enables RCON with the supplied password', () => {
    const env = buildContainerEnv(base);
    expect(env.ENABLE_RCON).toBe('TRUE');
    expect(env.RCON_PASSWORD).toBe('secret-password');
    // RCON traffic in chat would leak every administrative action to anyone opped.
    expect(env.BROADCAST_RCON_TO_OPS).toBe('FALSE');
  });

  it('gives shutdown enough time to flush chunks', () => {
    const env = buildContainerEnv(base);
    expect(Number(env.STOP_DURATION)).toBeGreaterThanOrEqual(60);
  });

  it('omits optional settings rather than sending empty strings', () => {
    // The image treats an empty value as "clear this property" and an absent variable as "leave
    // it alone". Sending "" for an unset seed would wipe a configured one.
    const env = buildContainerEnv(base);
    expect(env.SEED).toBeUndefined();
    expect(env.LEVEL_TYPE).toBeUndefined();
  });

  it('sends a seed when one is set, including a negative one', () => {
    const env = buildContainerEnv({
      ...base,
      settings: serverSettingsSchema.parse({ levelSeed: '-1234567890' }),
    });
    expect(env.SEED).toBe('-1234567890');
  });

  it('enables and enforces the whitelist together', () => {
    const env = buildContainerEnv({
      ...base,
      settings: serverSettingsSchema.parse({ whitelistEnabled: true, whitelist: ['alice', 'bob'] }),
    });
    expect(env.ENABLE_WHITELIST).toBe('TRUE');
    // Enabling without enforcing lets already-connected players stay, which is not what anyone
    // means by "turn on the whitelist".
    expect(env.ENFORCE_WHITELIST).toBe('TRUE');
    expect(env.WHITELIST).toBe('alice,bob');
  });

  it('passes extra properties through as newline-delimited pairs', () => {
    const env = buildContainerEnv({
      ...base,
      settings: serverSettingsSchema.parse({
        extraProperties: { 'rate-limit': '20', 'text-filtering-config': 'x' },
      }),
    });
    expect(env.CUSTOM_SERVER_PROPERTIES).toBe('rate-limit=20\ntext-filtering-config=x');
  });

  it('lets extraEnv override Platter’s own opinions', () => {
    const env = buildContainerEnv({
      ...base,
      settings: serverSettingsSchema.parse({
        extraEnv: { USE_AIKAR_FLAGS: 'FALSE', TZ: 'Europe/London' },
      }),
    });
    expect(env.USE_AIKAR_FLAGS).toBe('FALSE');
    expect(env.TZ).toBe('Europe/London');
  });

  it('refuses the pack-env variables that would let a download run shell', () => {
    // LOAD_ENV_FROM_* sources a file from a downloaded artefact with bash, and its values
    // override the ones Platter sets — so a hostile pack could rewrite RCON_PASSWORD or UID.
    // That is arbitrary code execution by design.
    const env = buildContainerEnv({
      ...base,
      settings: serverSettingsSchema.parse({
        extraEnv: {
          LOAD_ENV_FROM_FILE: '/data/evil.env',
          LOAD_ENV_FROM_GENERIC_PACK: 'true',
        },
      }),
    });
    expect(env.LOAD_ENV_FROM_FILE).toBeUndefined();
    expect(env.LOAD_ENV_FROM_GENERIC_PACK).toBeUndefined();
  });

  it('refuses to let extraEnv change identity or the RCON password', () => {
    const env = buildContainerEnv({
      ...base,
      settings: serverSettingsSchema.parse({
        extraEnv: { RCON_PASSWORD: 'hijacked', UID: '0', EULA: 'FALSE', ENABLE_RCON: 'FALSE' },
      }),
    });
    expect(env.RCON_PASSWORD).toBe('secret-password');
    expect(env.UID).toBeUndefined();
    expect(env.EULA).toBe('TRUE');
    expect(env.ENABLE_RCON).toBe('TRUE');
  });

  it('blocks every variable it claims to block', () => {
    const hostile = Object.fromEntries([...BLOCKED_ENV].map((key) => [key, 'x']));
    const env = buildContainerEnv({
      ...base,
      settings: serverSettingsSchema.parse({ extraEnv: hostile }),
    });
    for (const key of BLOCKED_ENV) {
      expect(env[key]).not.toBe('x');
    }
  });

  it('drops TYPE and VERSION for a modpack, which decides both itself', () => {
    const env = buildContainerEnv({
      ...base,
      modrinthModpack: { projectId: 'fabulously-optimized', versionId: 'abc' },
    });
    expect(env.MODPACK_PLATFORM).toBe('MODRINTH');
    expect(env.MODRINTH_MODPACK).toBe('fabulously-optimized');
    // The image warns against setting both; the pack owns the loader and version.
    expect(env.TYPE).toBeUndefined();
    expect(env.VERSION).toBeUndefined();
  });

  it('ignores a CurseForge modpack without an API key', () => {
    const env = buildContainerEnv({ ...base, curseforgeModpack: { slug: 'all-the-mods-9' } });
    expect(env.MODPACK_PLATFORM).toBeUndefined();
    expect(env.TYPE).toBe('PAPER');
  });

  it('identifies a CurseForge modpack by slug, not by file id alone', () => {
    // The image treats CF_FILE_ID as a pin on top of CF_SLUG or CF_PAGE_URL. Sending only the
    // file id runs `install-curseforge --file-id=…` with no project to install it from.
    const env = buildContainerEnv({
      ...base,
      curseforgeModpack: { slug: 'all-the-mods-9', fileId: '4248390' },
      curseforgeApiKey: 'key',
    });
    expect(env.MODPACK_PLATFORM).toBe('AUTO_CURSEFORGE');
    expect(env.CF_SLUG).toBe('all-the-mods-9');
    expect(env.CF_FILE_ID).toBe('4248390');
    // The pack decides the loader and version.
    expect(env.TYPE).toBeUndefined();
    expect(env.VERSION).toBeUndefined();
  });

  it('accepts a page URL instead of a slug, and leaves the build unpinned', () => {
    const env = buildContainerEnv({
      ...base,
      curseforgeModpack: {
        pageUrl: 'https://www.curseforge.com/minecraft/modpacks/all-the-mods-9',
      },
      curseforgeApiKey: 'key',
    });
    expect(env.CF_PAGE_URL).toContain('all-the-mods-9');
    expect(env.CF_SLUG).toBeUndefined();
    expect(env.CF_FILE_ID).toBeUndefined();
  });
});

describe('selectImage', () => {
  it('derives the Java tag from the Minecraft version', () => {
    expect(selectImage('paper', '1.21.4').image).toBe('itzg/minecraft-server:java21');
    expect(selectImage('paper', '1.18.2').image).toBe('itzg/minecraft-server:java17');
    expect(selectImage('paper', '1.12.2').image).toBe('itzg/minecraft-server:java11');
    expect(selectImage('paper', '1.8.8').image).toBe('itzg/minecraft-server:java8');
  });

  it('gives the calendar line Java 25, which is what its jars are compiled for', () => {
    // 26.x jars are class-file version 69. A Java 21 runtime refuses them outright, and since
    // the newest release is what the new-server picker defaults to, getting this wrong means
    // every server created with the defaults is dead on arrival.
    expect(selectImage('paper', '26.2').image).toBe('itzg/minecraft-server:java25');
    expect(selectImage('vanilla', '26.1.1').javaVersion).toBe(25);
  });

  it('gives 1.16.5 its own Java 16 image', () => {
    // 1.16.5 alone is compiled against a JDK its neighbours are not, and itzg publishes a java16
    // tag whose only documented purpose is that release.
    expect(selectImage('paper', '1.16.5').image).toBe('itzg/minecraft-server:java16');
    expect(selectImage('paper', '1.16.4').image).toBe('itzg/minecraft-server:java11');
  });

  it('drops Forge below 1.18 to Java 8 despite the version floor', () => {
    // Those builds use the old ForgeGradle launcher and genuinely need Java 8. The failure is a
    // ClassCastException deep in cpw.mods.modlauncher that looks nothing like a Java problem.
    const forge = selectImage('forge', '1.16.5');
    expect(forge.javaVersion).toBe(8);
    expect(forge.reason).toContain('Java 8');

    // Fabric on the same version has no such constraint.
    expect(selectImage('fabric', '1.16.5').javaVersion).toBe(16);
    // …and above 1.18 Forge follows the normal floor again.
    expect(selectImage('forge', '1.20.1').javaVersion).toBe(17);
    expect(selectImage('forge', '1.21.4').javaVersion).toBe(21);
  });

  it('honours a configured mirror repository', () => {
    expect(selectImage('paper', '1.21.4', 'registry.internal/mc').image).toBe(
      'registry.internal/mc:java21'
    );
  });

  it('explains its choice', () => {
    expect(selectImage('paper', '1.21.4').reason).toMatch(/Java 21/);
  });
});
