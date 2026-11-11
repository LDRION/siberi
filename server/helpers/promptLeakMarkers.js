'use strict';

// sendPromptWithSystem()/QwenService.process() paste systemPrompt+userPrompt as
// ONE message — there's no separate "system" role in Mistral/Qwen's web UI, so
// our OWN sent bubble contains the full prompt verbatim. If a browser-automation
// scraper ever grabs that bubble instead of the real new AI reply (race
// condition, layout quirk, etc.), these are strings that prove it — none could
// plausibly appear in a genuine AI answer. Checked with .includes(), not
// .startsWith(), shared by both AiService.js (Mistral) and QwenService.js so a
// fix here closes the leak for both browser-automation providers at once.
//
// IMPORTANT: do NOT add studio output-tag names here (BOT_SETTINGS,
// BOT_COMMANDS, WELCOME_MESSAGE, DB_COMMAND, NOTIF_COMMAND, etc.) — the studio
// system prompt (routes/studio.js) explicitly instructs the AI to emit those
// exact tag names in every legitimate, complete answer. They used to be on
// this list and caused every real studio response with actual bot changes to
// be misdetected as a "prompt leak" and discarded/retried (confirmed live:
// two full, correct ~17k/~8k char Qwen answers rejected back-to-back for a
// barbershop-bot build on 2026-06-28, burning the whole timeout budget before
// a third, genuinely truncated attempt slipped through as the final result).
// Only phrases that are specific to the PROMPT TEMPLATE's own wording belong
// here — text the model would echo only if the scraper grabbed our sent
// bubble instead of its real reply.
const PROMPT_LEAK_MARKERS = [
  'ПРАВИЛА ФОРМАТИРОВАНИЯ',
  'Ты — Помощник',
  'СИСТЕМНЫЙ ПРИОРИТЕТ',
  '[ТЕКУЩИЙ КОНФИГ]',
  '[ДАННЫЕ ПОЛЬЗОВАТЕЛЯ]',
  '[ЗАПРОС]',
  'АВТОМАТИЧЕСКИЕ УВЕДОМЛЕНИЯ',
  'РАБОТА С ДАННЫМИ (СХЕМЫ',
  'ФОРМАТ РАБОТЫ С ДАННЫМИ',
  'ТЕКУЩИЙ ЗАПРОС ПОЛЬЗОВАТЕЛЯ',
  'ПРЕДЫДУЩИЙ ДИАЛОГ (для контекста)',
];

module.exports = { PROMPT_LEAK_MARKERS };
