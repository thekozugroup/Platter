export * from './domain.js';
export * from './errors.js';
export * from './format.js';
export * from './ws.js';

export * from './schemas/ai.js';
export * from './schemas/audit.js';
export * from './schemas/auth.js';
export * from './schemas/backup.js';
export * from './schemas/blueprint.js';
export * from './schemas/common.js';
export * from './schemas/files.js';
export * from './schemas/node.js';
export * from './schemas/server.js';
export * from './schemas/user.js';

/** Wire version. Bumped when a breaking change lands in any schema above. */
export const API_VERSION = 'v1';
export const API_PREFIX = '/api/v1';
