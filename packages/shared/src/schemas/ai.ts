import { z } from 'zod';
import { idSchema, isoDateSchema, portSchema } from './common.js';
import { resourceLimitsSchema } from './server.js';

/**
 * The AI layer is advisory by design: every model output lands in a *proposal* the
 * operator confirms. Nothing here mutates a server on its own — that keeps a
 * hallucinated `rm -rf` from ever becoming an executed action.
 */

// ---------------------------------------------------------------------------
// Natural-language provisioning
// ---------------------------------------------------------------------------

export const provisionRequestSchema = z.object({
  prompt: z.string().min(3).max(2000),
  /** Narrow the model to one game when the user already picked from the grid. */
  blueprintKey: z.string().optional(),
});
export type ProvisionRequest = z.infer<typeof provisionRequestSchema>;

/**
 * A ready-to-confirm server spec. The API re-validates every field against the
 * blueprint before it is offered, so an out-of-range value never reaches the form.
 */
export const provisionProposalSchema = z.object({
  blueprintKey: z.string(),
  name: z.string(),
  description: z.string(),
  limits: resourceLimitsSchema,
  variables: z.record(z.string(), z.string()),
  ports: z.record(z.string(), portSchema).default({}),
  /** One short sentence per decision, shown next to the field it explains. */
  rationale: z.array(z.object({ field: z.string(), reason: z.string() })).default([]),
  /** Things the model was unsure about — rendered as questions, not silently guessed. */
  clarifications: z.array(z.string()).default([]),
  /** 0–1; below the confidence floor the UI leads with the form, not the proposal. */
  confidence: z.number().min(0).max(1),
});
export type ProvisionProposal = z.infer<typeof provisionProposalSchema>;

// ---------------------------------------------------------------------------
// Diagnosis
// ---------------------------------------------------------------------------

export const diagnoseRequestSchema = z.object({
  /** Defaults to the tail of the current log buffer when omitted. */
  logExcerpt: z.string().max(60_000).optional(),
  question: z.string().max(1000).optional(),
});

export const diagnosisSeveritySchema = z.enum(['info', 'warning', 'critical']);

export const suggestedFixSchema = z.object({
  title: z.string(),
  description: z.string(),
  /** What the operator would be agreeing to, expressed as a reviewable change. */
  kind: z.enum(['variable', 'file', 'resource', 'command', 'manual']),
  /** For `variable`: the key and proposed value. */
  variableKey: z.string().nullable().default(null),
  variableValue: z.string().nullable().default(null),
  /** For `file`: path plus the full proposed contents, diffed in the UI before applying. */
  filePath: z.string().nullable().default(null),
  fileContent: z.string().nullable().default(null),
  /** For `resource`: the partial limits patch. */
  limits: resourceLimitsSchema.partial().nullable().default(null),
  /** For `command`: a console command, never a shell command. */
  command: z.string().nullable().default(null),
  /** Applying this needs a restart to take effect. */
  requiresRestart: z.boolean().default(false),
});
export type SuggestedFix = z.infer<typeof suggestedFixSchema>;

export const diagnosisSchema = z.object({
  summary: z.string(),
  severity: diagnosisSeveritySchema,
  /** The specific log lines the conclusion rests on, so the operator can check the work. */
  evidence: z.array(z.string()).default([]),
  rootCause: z.string().nullable().default(null),
  fixes: z.array(suggestedFixSchema).default([]),
  confidence: z.number().min(0).max(1),
});
export type Diagnosis = z.infer<typeof diagnosisSchema>;

// ---------------------------------------------------------------------------
// Assistant chat
// ---------------------------------------------------------------------------

export const chatRoleSchema = z.enum(['user', 'assistant']);

export const chatMessageSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  role: chatRoleSchema,
  content: z.string(),
  /** Structured attachments the assistant produced alongside prose. */
  proposal: provisionProposalSchema.nullable().default(null),
  diagnosis: diagnosisSchema.nullable().default(null),
  createdAt: isoDateSchema,
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const chatRequestSchema = z.object({
  message: z.string().min(1).max(8000),
  conversationId: idSchema.optional(),
  /** Let the assistant read the recent console buffer for this turn. */
  includeLogs: z.boolean().default(true),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

export const conversationSchema = z.object({
  id: idSchema,
  serverId: idSchema.nullable(),
  title: z.string(),
  messageCount: z.number().int(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
});
export type Conversation = z.infer<typeof conversationSchema>;

/** Advertised to the UI so AI affordances hide cleanly when no key is configured. */
export const aiStatusSchema = z.object({
  enabled: z.boolean(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  features: z.object({
    provisioning: z.boolean(),
    diagnosis: z.boolean(),
    chat: z.boolean(),
  }),
});
export type AiStatus = z.infer<typeof aiStatusSchema>;
