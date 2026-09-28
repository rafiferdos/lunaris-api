import { z } from 'zod';
import type { Mode } from '../questions/schema.js';
export const eventSchema = z.strictObject({
  sequence: z.number().int().min(0).max(2147483647),
  type: z.enum([
    'TAB_HIDDEN',
    'WINDOW_BLUR',
    'FULLSCREEN_EXIT',
    'FULLSCREEN_ENTER',
    'SPEECH_ACTIVITY',
    'MICROPHONE_UNAVAILABLE',
    'INTEGRITY_HEARTBEAT',
  ]),
  clientTimestamp: z.iso.datetime().optional(),
  durationMs: z.number().int().min(0).max(600000).optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type IntegrityEvent = z.infer<typeof eventSchema> & { serverReceivedAt: string };
export const integrityPolicy = {
  version: 'integrity/v1',
  coalesceMs: 1500,
  sustainedMs: 3000,
  speechAutoSubmitCount: 3,
  penalties: { WINDOW_BLUR: 3, TAB_HIDDEN: 8, FULLSCREEN_EXIT: 10, SPEECH_ACTIVITY: 10 },
  competitiveTabAutoSubmit: true,
};
export function assessIntegrity(events: IntegrityEvent[], mode: Mode) {
  let score = 100,
    speech = 0,
    autoSubmit = false,
    critical = false,
    lastFocus = -Infinity,
    lastSpeech = -Infinity;
  const sequences = new Set<number>();
  for (const event of [...events].sort(
    (a, b) =>
      Date.parse(a.serverReceivedAt) - Date.parse(b.serverReceivedAt) || a.sequence - b.sequence,
  )) {
    if (sequences.has(event.sequence)) continue;
    sequences.add(event.sequence);
    const at = Date.parse(event.serverReceivedAt);
    if (
      event.type === 'TAB_HIDDEN' &&
      mode === 'COMPETITIVE' &&
      integrityPolicy.competitiveTabAutoSubmit
    ) {
      autoSubmit = true;
      critical = true;
    }
    if (
      event.type === 'WINDOW_BLUR' ||
      event.type === 'TAB_HIDDEN' ||
      event.type === 'FULLSCREEN_EXIT'
    ) {
      if (at - lastFocus > integrityPolicy.coalesceMs) {
        score -= integrityPolicy.penalties[event.type];
        lastFocus = at;
      }
    }
    if (
      event.type === 'SPEECH_ACTIVITY' &&
      (event.durationMs ?? 0) >= integrityPolicy.sustainedMs &&
      at - lastSpeech > integrityPolicy.coalesceMs
    ) {
      speech++;
      score -= integrityPolicy.penalties.SPEECH_ACTIVITY * Math.min(speech, 3);
      lastSpeech = at;
      if (mode === 'COMPETITIVE' && speech >= integrityPolicy.speechAutoSubmitCount) {
        autoSubmit = true;
        critical = true;
      }
    }
  }
  return {
    version: integrityPolicy.version,
    score: Math.max(0, score),
    eligible: score >= 60 && !critical,
    autoSubmit,
    reason: critical ? 'CRITICAL_INTEGRITY' : null,
    warning: score < 90,
  };
}
