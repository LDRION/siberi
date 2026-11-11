'use strict';
// ── Раскладка inline-клавиатур меню: ОДНА кнопка в ряд (вертикальный столбик) ──
// На мобилке несколько inline-кнопок в одном ряду делят ширину поровну и текст
// ОБРЕЗАЕТСЯ («Бургеры» → «Бурге…», «Напитки» → «Напит…»). Пользователь не видит
// подписи целиком → клацает наугад → конверсия падает. Поэтому раскладку меню
// приводим к одной кнопке на ряд — каждая кнопка на всю ширину экрана.
//
// Важно: короткие парные ряды (−/+ у добавок, счётчик корзины) движок РИСУЕТ САМ
// в карточке/каталоге и НЕ хранит в keyboard команды — стек их не задевает.

// Одна кнопка = один ряд. Пустые ячейки отбрасываем. Форму кнопки (строка/объект)
// сохраняем как есть.
function stackKeyboard(kb) {
  if (!Array.isArray(kb)) return kb;
  const out = [];
  for (const row of kb) {
    const cells = Array.isArray(row) ? row : [row];
    for (const cell of cells) {
      if (cell == null) continue;
      if (typeof cell === 'string' && !cell.trim()) continue;
      if (typeof cell === 'object' && !cell.text) continue;
      out.push([cell]);
    }
  }
  return out;
}

// Пробегает массив команд и вертикализует keyboard у каждой (не мутирует вход).
function stackCommands(commands) {
  if (!Array.isArray(commands)) return commands;
  return commands.map((c) => (c && c.keyboard ? { ...c, keyboard: stackKeyboard(c.keyboard) } : c));
}

module.exports = { stackKeyboard, stackCommands };
