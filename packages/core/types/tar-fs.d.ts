/**
 * Types for `tar-fs` v3.
 *
 * The published `@types/tar-fs` package describes v2, whose header type has no `linkname` —
 * which is precisely the field the archive-extraction guard needs in order to reject a symlink
 * entry pointing outside the destination. Using the v2 types here would mean casting away the
 * one property that stops a "Zip Slip" style escape, so the surface Platter actually uses is
 * declared here instead, against v3's real shape.
 */
declare module 'tar-fs' {
  import type { Readable, Writable } from 'node:stream';

  export interface TarHeader {
    name: string;
    mode?: number;
    uid?: number;
    gid?: number;
    size?: number;
    mtime?: Date;
    type?:
      | 'file'
      | 'link'
      | 'symlink'
      | 'character-device'
      | 'block-device'
      | 'directory'
      | 'fifo'
      | 'contiguous-file'
      | 'pax-header'
      | 'pax-global-header'
      | 'gnu-long-link-path'
      | 'gnu-long-path';
    /** Target of a symlink or hard link. Absent for regular files. */
    linkname?: string | undefined;
    uname?: string;
    gname?: string;
    devmajor?: number;
    devminor?: number;
  }

  export interface PackOptions {
    /** Return true to SKIP the entry. */
    ignore?: ((name: string) => boolean) | undefined;
    /** Alias of `ignore`. */
    filter?: ((name: string) => boolean) | undefined;
    entries?: string[] | undefined;
    dereference?: boolean | undefined;
    map?: ((header: TarHeader) => TarHeader) | undefined;
    mapStream?: ((fileStream: Readable, header: TarHeader) => Readable) | undefined;
    strict?: boolean | undefined;
    readable?: boolean | undefined;
    writable?: boolean | undefined;
    finish?: ((pack: Readable) => void) | undefined;
  }

  export interface ExtractOptions {
    /** Return true to SKIP the entry. */
    ignore?: ((name: string, header?: TarHeader) => boolean) | undefined;
    filter?: ((name: string, header?: TarHeader) => boolean) | undefined;
    map?: ((header: TarHeader) => TarHeader) | undefined;
    mapStream?: ((fileStream: Readable, header: TarHeader) => Readable) | undefined;
    readable?: boolean | undefined;
    writable?: boolean | undefined;
    strict?: boolean | undefined;
    strip?: number | undefined;
    dmode?: number | undefined;
    fmode?: number | undefined;
    umask?: number | undefined;
    /** v3: refuse entries that resolve outside `cwd`. Platter checks this itself as well. */
    validate?: ((path: string, root: string) => boolean) | undefined;
    finish?: (() => void) | undefined;
  }

  export function pack(cwd: string, options?: PackOptions): Readable;
  export function extract(cwd: string, options?: ExtractOptions): Writable;
}
