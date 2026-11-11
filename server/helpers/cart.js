'use strict';
// Серверная корзина без AI — чистые функции над массивом позиций.
// Позиция: { id, title, price, qty }. Хранится в эфемерной сессии чата.
// Смысл: простую детерминированную логику (добавить/убрать/сумма/оформить)
// делаем сами, а не гоняем Mistral ради фразы «товар добавлен».

function cartAdd(cart, item, delta = 1) {
  const list = Array.isArray(cart) ? cart.map((x) => ({ ...x })) : [];
  const found = list.find((x) => String(x.id) === String(item.id));
  if (found) found.qty += delta;
  else list.push({ id: String(item.id), title: item.title, price: Number(item.price) || 0, qty: delta });
  return list.filter((x) => x.qty > 0);
}

function cartTotal(cart) {
  return (cart || []).reduce((s, x) => s + (Number(x.price) || 0) * (x.qty || 0), 0);
}

function cartCount(cart) {
  return (cart || []).reduce((s, x) => s + (x.qty || 0), 0);
}

function fmtMoney(n, currency = '₽') {
  return `${Math.round(Number(n) || 0).toLocaleString('ru-RU')} ${currency}`.trim();
}

// Из записи БД достаём заголовок (первое содержательное поле) и цену
// (поле с «ценой» в имени/подписи, иначе первое числовое).
function extractItem(record, schemaFields) {
  const fields = (schemaFields || []).filter((f) => !f.name.startsWith('_') && f.type !== 'image' && f.type !== 'file');
  const titleField = fields[0];
  const priceField = fields.find((f) => /цена|price|cost|стоим|сумм|amount/i.test(`${f.name} ${f.label || ''}`))
    || fields.find((f) => f.type === 'number');
  const data = record.data || {};
  return {
    id: String(record._id),
    title: String(data[titleField?.name] ?? 'Товар'),
    price: priceField ? Number(String(data[priceField.name]).replace(/[^\d.]/g, '')) || 0 : 0,
  };
}

const isCartLabel = (label) => /^(?:🛒\s*)?(?:корзин|cart|моя\s+корзина)/i.test((label || '').trim());

// Убирает кнопки-дубли «Корзина»/cart из клавиатуры команды: свою counted-кнопку
// корзины движок добавляет сам, иначе выходит две одинаковые кнопки.
function stripCartButtons(keyboard) {
  if (!Array.isArray(keyboard)) return keyboard;
  return keyboard
    .map((row) => (Array.isArray(row) ? row.filter((it) => !isCartLabel(typeof it === 'string' ? it : it?.text)) : row))
    .filter((row) => !Array.isArray(row) || row.length);
}

// Ставит counted-кнопку корзины НА МЕСТО пользовательской кнопки «Корзина» в
// клавиатуре команды — сохраняя её ряд и позицию (чтобы «Корзина» и «Меню»
// остались в одной строке, если владелец так задал). Возвращает { keyboard,
// placed }. Если своей кнопки «Корзина» в клавиатуре нет — placed:false (тогда
// вызывающий добавит counted-кнопку отдельной строкой, как раньше). countedBtn —
// уже готовый объект кнопки в нужном формате (callback_data или data).
function placeCountedCart(keyboard, countedBtn) {
  if (!Array.isArray(keyboard)) return { keyboard, placed: false };
  let placed = false;
  const kb = keyboard.map((row) => (Array.isArray(row)
    ? row.map((it) => {
        const label = typeof it === 'string' ? it : it?.text;
        if (!placed && isCartLabel(label)) { placed = true; return countedBtn; }
        return it;
      })
    : row));
  return { keyboard: kb, placed };
}

module.exports = { cartAdd, cartTotal, cartCount, fmtMoney, extractItem, stripCartButtons, placeCountedCart };
