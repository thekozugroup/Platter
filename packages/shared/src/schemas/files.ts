import { z } from 'zod';
import { LIMITS } from '../domain.js';
import { isoDateSchema } from './common.js';

/**
 * File paths are always relative to the server's data volume and are normalised and
 * rejected server-side if they escape it. The schema catches the obvious attempts early
 * so a traversal never reaches the driver.
 */
export const serverPathSchema = z
  .string()
  .max(1024)
  .transform((value) => value.replace(/\\/g, '/'))
  .refine((value) => !value.includes('\0'), 'Invalid path')
  .refine(
    (value) => !value.split('/').includes('..'),
    'Paths cannot traverse outside the server directory',
  );

export const fileEntrySchema = z.object({
  name: z.string(),
  /** Path relative to the data volume root, without a leading slash. */
  path: z.string(),
  type: z.enum(['file', 'directory', 'symlink']),
  sizeBytes: z.number().int(),
  /** Unix mode as a four-digit octal string, e.g. `0644`. */
  mode: z.string(),
  modifiedAt: isoDateSchema,
  /** Best-effort MIME type, used to pick an editor or preview. */
  mimeType: z.string().nullable(),
  /** True when the file is small enough and looks like text — i.e. the editor can open it. */
  editable: z.boolean(),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const listFilesQuerySchema = z.object({
  path: serverPathSchema.default(''),
});

export const listFilesResponseSchema = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  entries: z.array(fileEntrySchema),
});
export type ListFilesResponse = z.infer<typeof listFilesResponseSchema>;

export const readFileQuerySchema = z.object({
  path: serverPathSchema,
});

export const readFileResponseSchema = z.object({
  path: z.string(),
  content: z.string(),
  sizeBytes: z.number().int(),
  /** True when the file was cut off at the read limit. */
  truncated: z.boolean(),
  mimeType: z.string().nullable(),
});

export const writeFileRequestSchema = z.object({
  path: serverPathSchema,
  content: z.string().max(LIMITS.maxFileEditBytes),
});

export const createDirectoryRequestSchema = z.object({
  path: serverPathSchema,
});

export const renameFileRequestSchema = z.object({
  from: serverPathSchema,
  to: serverPathSchema,
});

export const deleteFilesRequestSchema = z.object({
  paths: z.array(serverPathSchema).min(1).max(500),
});

export const compressFilesRequestSchema = z.object({
  paths: z.array(serverPathSchema).min(1).max(500),
  /** Destination archive path; defaults to a timestamped name in the same directory. */
  destination: serverPathSchema.optional(),
});

export const extractArchiveRequestSchema = z.object({
  path: serverPathSchema,
  destination: serverPathSchema.default(''),
});
