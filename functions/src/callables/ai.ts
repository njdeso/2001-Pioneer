import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions';
import { z } from 'zod';
import { DEFAULT_AI_MODEL, diagnoseAnthropic } from '@asm/shared';
import { audit, db, parse, requireRole } from '../lib/core.js';
import { ANTHROPIC_API_KEY } from './statements.js';

const input = z.object({
  /** Test a model before saving it in Settings; defaults to the saved model. */
  model: z.string().trim().regex(/^[a-z0-9.-]{3,60}$/).optional(),
  /** Only the free checks (key + model lookup); no tokens used. */
  skipRequest: z.boolean().optional().default(false),
});

/**
 * Settings → "Test AI connection". Read-only: it changes no statements, clients or policies.
 * It records one audit entry and returns what Anthropic said; the key itself is never returned
 * (only its length and last four characters, so you can confirm which secret version is live).
 */
export const checkAiConnection = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120 }, async (req) => {
  const actor = requireRole(req);
  const { model: requested, skipRequest } = parse(input, req.data ?? {});
  const settings = (await db.collection('settings').doc('app').get()).data() ?? {};
  const model = requested || (typeof settings.aiModel === 'string' && settings.aiModel ? settings.aiModel : DEFAULT_AI_MODEL);
  let apiKey = '';
  try { apiKey = ANTHROPIC_API_KEY.value(); } catch { apiKey = ''; }
  try {
    const d = await diagnoseAnthropic({ apiKey, model, skipRequest });
    logger.info('AI connection check', { ok: d.ok, model, key: d.key.state, auth: d.auth.state, modelState: d.model_.state, request: d.request.state, httpStatus: d.request.error?.status ?? d.auth.error?.status ?? null, requestId: d.request.requestId ?? null });
    const b = db.batch();
    audit(b, actor, { action: 'ai_connection_check', entityType: 'settings', entityId: 'app', summary: `AI connection check for ${model}: ${d.ok ? 'passed' : 'failed'}` });
    await b.commit();
    return d;
  } catch (err) {
    logger.error('AI connection check crashed', { message: String((err as Error)?.message ?? err).slice(0, 300) });
    throw new HttpsError('internal', 'The connection check could not run.');
  }
});
