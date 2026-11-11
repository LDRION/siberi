'use strict';
/**
 * Screen-text editing (<SCREEN_TEXT screen="…">…</SCREEN_TEXT>)
 * Covers the deterministic apply core in AiService._applyScreenTextEdits:
 *   1) tag parsing (single/multiple, HTML & newlines preserved, emoji screen);
 *   2) screen resolution — /start aliases → welcomeMessage; named command
 *      matched exactly and emoji-insensitively; unknown screen → no change.
 * Faithful logic mirror (same self-contained style as the other tests — no DB).
 * This locks the behavior that "edit the named tab from anywhere" relies on.
 * Run: node --test tests/screenTextEdit.test.js
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// ── Mirror of AiService._applyScreenTextEdits parse regex (line ~4429) ────────
function parseScreenEdits(rawResponse) {
  const edits = [];
  const re = /<SCREEN_?TEXT\s+screen\s*=\s*["']([^"']+)["']\s*>([\s\S]*?)<\/SCREEN_?TEXT>/gi;
  let m;
  while ((m = re.exec(rawResponse)) !== null) edits.push({ screen: m[1].trim(), text: m[2].trim() });
  return edits;
}

// ── Mirror of the apply/match logic (lines ~4437-4453) ────────────────────────
const norm = (s) => (s || '').toString().trim().toLowerCase();
const stripLead = (s) => norm(s).replace(/^[^\p{L}\p{N}]+/u, '').trim();
const isStart = (s) => ['/start', 'start', 'главное меню', 'главное', 'приветствие', 'welcome', 'стартовое меню', 'главный экран', 'старт'].includes(norm(s));

// Apply edits onto a profile-like {welcomeMessage, commands:[{command,response}]}
// and return the list of applied screen names (mirrors the real method's result).
function applyScreenEdits(rawResponse, profile) {
  const edits = parseScreenEdits(rawResponse);
  const commands = profile.commands || [];
  const applied = [];
  for (const e of edits) {
    if (!e.text) continue;
    if (isStart(e.screen)) {
      profile.welcomeMessage = e.text;
      const startCmd = commands.find((c) => norm(c.command) === '/start');
      if (startCmd) startCmd.response = e.text;
      applied.push('Главное меню');
    } else {
      let cmd = commands.find((c) => norm(c.command) === norm(e.screen));
      if (!cmd) cmd = commands.find((c) => stripLead(c.command) === stripLead(e.screen));
      if (cmd) { cmd.response = e.text; applied.push(cmd.command); }
    }
  }
  return applied;
}

function makeProfile() {
  return {
    welcomeMessage: '<b>Привет</b>, добро пожаловать!',
    commands: [
      { command: '/start', response: '<b>Привет</b>, добро пожаловать!' },
      { command: '🍔 Бургеры', response: 'Старое описание бургеров' },
      { command: 'Доставка', response: 'Старый текст доставки' },
    ],
  };
}

describe('SCREEN_TEXT — parsing', () => {
  test('single tag, HTML + newlines preserved', () => {
    const raw = '<SCREEN_TEXT screen="/start"><b>Привет</b>\n\nЧем помочь?</SCREEN_TEXT>';
    const edits = parseScreenEdits(raw);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].screen, '/start');
    assert.equal(edits[0].text, '<b>Привет</b>\n\nЧем помочь?');
  });

  test('multiple tags in one response', () => {
    const raw = 'бла <SCREEN_TEXT screen="Доставка">A</SCREEN_TEXT> и <SCREEN_TEXT screen="🍔 Бургеры">B</SCREEN_TEXT>';
    const edits = parseScreenEdits(raw);
    assert.equal(edits.length, 2);
    assert.deepEqual(edits.map(e => e.screen), ['Доставка', '🍔 Бургеры']);
  });

  test('emoji screen name captured verbatim', () => {
    const edits = parseScreenEdits('<SCREEN_TEXT screen="🍔 Бургеры">x</SCREEN_TEXT>');
    assert.equal(edits[0].screen, '🍔 Бургеры');
  });
});

describe('SCREEN_TEXT — screen resolution & apply', () => {
  test('/start alias updates welcomeMessage AND the /start command response', () => {
    const p = makeProfile();
    const applied = applyScreenEdits('<SCREEN_TEXT screen="главное меню">Новое приветствие</SCREEN_TEXT>', p);
    assert.deepEqual(applied, ['Главное меню']);
    assert.equal(p.welcomeMessage, 'Новое приветствие');
    assert.equal(p.commands[0].response, 'Новое приветствие');
  });

  test('named screen edited from anywhere (exact match, emoji included)', () => {
    const p = makeProfile();
    const applied = applyScreenEdits('<SCREEN_TEXT screen="🍔 Бургеры">Сочные бургеры на гриле</SCREEN_TEXT>', p);
    assert.deepEqual(applied, ['🍔 Бургеры']);
    assert.equal(p.commands[1].response, 'Сочные бургеры на гриле');
  });

  test('named screen matched emoji-insensitively (AI dropped the emoji)', () => {
    const p = makeProfile();
    const applied = applyScreenEdits('<SCREEN_TEXT screen="Бургеры">Новый текст</SCREEN_TEXT>', p);
    assert.deepEqual(applied, ['🍔 Бургеры']);
    assert.equal(p.commands[1].response, 'Новый текст');
  });

  test('formatting carried over by the model survives apply verbatim', () => {
    // The model preserves <b>Акция!</b>; the deterministic apply stores it as-is.
    const p = makeProfile();
    p.commands.push({ command: 'Акции', response: '<b>Акция!</b> Скидка 10%' });
    applyScreenEdits('<SCREEN_TEXT screen="Акции"><b>Акция!</b> Скидка 20% до конца недели</SCREEN_TEXT>', p);
    assert.equal(p.commands.find(c => c.command === 'Акции').response, '<b>Акция!</b> Скидка 20% до конца недели');
  });

  test('unknown screen leaves everything untouched', () => {
    const p = makeProfile();
    const before = JSON.stringify(p);
    const applied = applyScreenEdits('<SCREEN_TEXT screen="Несуществующий">x</SCREEN_TEXT>', p);
    assert.deepEqual(applied, []);
    assert.equal(JSON.stringify(p), before);
  });

  test('only the targeted screen changes — others intact', () => {
    const p = makeProfile();
    applyScreenEdits('<SCREEN_TEXT screen="Доставка">Доставим за 60 минут</SCREEN_TEXT>', p);
    assert.equal(p.commands[2].response, 'Доставим за 60 минут');
    assert.equal(p.commands[1].response, 'Старое описание бургеров'); // Бургеры не тронуты
    assert.equal(p.welcomeMessage, '<b>Привет</b>, добро пожаловать!'); // welcome не тронут
  });
});
