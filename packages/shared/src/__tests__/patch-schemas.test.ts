import { describe, expect, it } from 'vitest';
import {
  createNodeRequestSchema,
  updateNodeRequestSchema,
  updateServerRequestSchema,
} from '../index.js';

/**
 * A PATCH body says what changed. Anything it leaves out must survive untouched.
 *
 * These guard a real regression: the update schemas were built with `.partial()` over
 * shapes carrying `.default()`, which yields `ZodOptional<ZodDefault<T>>` — and Zod still
 * fills the inner default for an absent key. Parsing `{ memoryTotalMb }` produced a full
 * object pinned to create-time defaults, and the route wrote all of it.
 */
describe('PATCH schemas leave omitted fields alone', () => {
  it('does not invent node fields the caller never sent', () => {
    const parsed = updateNodeRequestSchema.parse({ memoryTotalMb: 65536 });

    expect(Object.keys(parsed)).toEqual(['memoryTotalMb']);
    // The damaging four: a capacity edit must not repoint the node or reset its address.
    expect(parsed).not.toHaveProperty('driver');
    expect(parsed).not.toHaveProperty('endpoint');
    expect(parsed).not.toHaveProperty('publicHost');
    expect(parsed).not.toHaveProperty('description');
  });

  it('still rejects a node PATCH with nothing in it', () => {
    // Previously the defaults filled the object, so this refine could never fire.
    expect(() => updateNodeRequestSchema.parse({})).toThrow(/Nothing to update/);
  });

  it('keeps validation on the fields a node PATCH does send', () => {
    expect(() => updateNodeRequestSchema.parse({ memoryTotalMb: 128 })).toThrow();
    expect(() => updateNodeRequestSchema.parse({ driver: 'not-a-driver' })).toThrow();
    expect(updateNodeRequestSchema.parse({ driver: 'mock' })).toEqual({ driver: 'mock' });
  });

  it('does not reset swap or IO weight when only memory is edited', () => {
    const parsed = updateServerRequestSchema.parse({
      limits: { memoryMb: 8192, diskMb: 20480, cpuCores: 2 },
    });

    expect(parsed.limits).toEqual({ memoryMb: 8192, diskMb: 20480, cpuCores: 2 });
    expect(parsed.limits).not.toHaveProperty('swapMb');
    expect(parsed.limits).not.toHaveProperty('ioWeight');
  });

  it('still applies defaults on create, where they belong', () => {
    const parsed = createNodeRequestSchema.parse({ name: 'Local' });

    expect(parsed.driver).toBe('docker');
    expect(parsed.publicHost).toBe('127.0.0.1');
    expect(parsed.portRangeStart).toBe(25000);
  });
});
