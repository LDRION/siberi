'use strict';
/*
  Доступ к AiConstructor: владелец + те, кого он лично пригласил.

  Зачем: «лавочка» была закрыта наглухо флагом BOTS_DISABLED (см. index.js).
  Теперь она открыта, но не для всех — конструктором пользуется владелец, а
  остальные только по приглашению. Это заодно гейтит и КЛИЕНТСКИЕ боты: если
  вебхук чужого бота придёт на сервер, он не должен обрабатываться, пока его
  владелец не в списке.

  Владелец задаётся TGLB_OWNER_ID в server/.env (числовой Telegram ID).
*/
const TglbInvite = require('../models/TglbInvite');
const User = require('../models/User');

const OWNER_ID = String(process.env.TGLB_OWNER_ID || '').trim();

const normHandle = (raw) => String(raw || '').trim().replace(/^@+/, '').toLowerCase();

function isOwner(telegramId) {
  return !!OWNER_ID && String(telegramId) === OWNER_ID;
}

/**
 * Есть ли у человека доступ к конструктору.
 * Заодно «доклеивает» telegramId к приглашению, выданному по @логину: до
 * первого сообщения мы его не знали.
 */
async function hasAccess(fromUser = {}) {
  const id = String(fromUser.id || '');
  if (!id) return false;
  if (isOwner(id)) return true;

  const uname = normHandle(fromUser.username);
  const or = [{ telegramId: id }];
  if (uname) or.push({ username: uname });

  const invite = await TglbInvite.findOne({ $or: or });
  if (!invite) return false;

  const patch = {};
  if (!invite.telegramId) patch.telegramId = id;
  if (uname && !invite.username) patch.username = uname;
  if (!invite.firstSeenAt) patch.firstSeenAt = new Date();
  if (Object.keys(patch).length) await TglbInvite.updateOne({ _id: invite._id }, { $set: patch }).catch(() => {});
  return true;
}

/** Пригласить по @логину или числовому id. Возвращает текст для ответа владельцу. */
async function invite(rawHandle, byTelegramId) {
  const raw = String(rawHandle || '').trim();
  if (!raw) return 'Как звать? Пришли <b>@логин</b> или числовой Telegram ID.';

  const byId = /^\d{5,}$/.test(raw);
  const uname = byId ? '' : normHandle(raw);
  if (!byId && !uname) return 'Не разобрал. Нужен <b>@логин</b> или числовой Telegram ID.';

  const query = byId ? { telegramId: raw } : { username: uname };
  const exists = await TglbInvite.findOne(query);
  if (exists) return `Уже в списке: <b>${byId ? raw : '@' + uname}</b>.`;

  // Если человек уже писал конструктору — подтянем вторую половину пары.
  let telegramId = byId ? raw : '';
  let username = uname;
  const known = byId
    ? await User.findOne({ telegramId: raw }).lean()
    : await User.findOne({ telegramUsername: new RegExp(`^${uname}$`, 'i') }).lean();
  if (known) {
    telegramId = telegramId || String(known.telegramId || '');
    username = username || normHandle(known.telegramUsername);
  }

  await TglbInvite.create({ telegramId, username, invitedBy: String(byTelegramId || '') });
  const who = username ? `@${username}` : telegramId;
  return known || byId
    ? `Готово, <b>${who}</b> получил доступ. Пусть напишет /start.`
    : `Готово, <b>${who}</b> в списке. Доступ включится, как только он напишет боту.`;
}

/** Забрать доступ. */
async function revoke(rawHandle) {
  const raw = String(rawHandle || '').trim();
  if (!raw) return 'Кого убираем? Пришли <b>@логин</b> или числовой Telegram ID.';
  const byId = /^\d{5,}$/.test(raw);
  const q = byId ? { telegramId: raw } : { username: normHandle(raw) };
  const r = await TglbInvite.deleteOne(q);
  return r.deletedCount
    ? `Доступ отозван: <b>${byId ? raw : '@' + normHandle(raw)}</b>.`
    : `Такого в списке нет: <b>${byId ? raw : '@' + normHandle(raw)}</b>.`;
}

/** Список приглашённых — для владельца. */
async function list() {
  const all = await TglbInvite.find().sort({ createdAt: 1 }).lean();
  if (!all.length) return 'Пока никого не приглашал. Конструктор доступен только тебе.';
  const rows = all.map((x, i) => {
    const who = x.username ? `@${x.username}` : (x.telegramId || '—');
    const id = x.telegramId ? ` <code>${x.telegramId}</code>` : ' <i>(ещё не писал)</i>';
    return `${i + 1}. ${who}${id}`;
  });
  return `<b>Приглашённые (${all.length}):</b>\n${rows.join('\n')}`;
}

/**
 * Кому из владельцев ботов разрешено обрабатывать вебхуки — множество User._id.
 * Дёргается на каждом апдейте клиентских ботов, поэтому держим короткий кэш:
 * список меняется редко, а ходить в базу на каждое сообщение незачем.
 */
let cache = { at: 0, ids: new Set() };
const CACHE_MS = 60000;

async function allowedUserIds() {
  if (Date.now() - cache.at < CACHE_MS) return cache.ids;

  const telegramIds = [];
  if (OWNER_ID) telegramIds.push(OWNER_ID);
  const invites = await TglbInvite.find({ telegramId: { $ne: '' } }, { telegramId: 1 }).lean();
  invites.forEach((i) => telegramIds.push(String(i.telegramId)));

  const users = telegramIds.length
    ? await User.find({ telegramId: { $in: telegramIds } }, { _id: 1 }).lean()
    : [];
  cache = { at: Date.now(), ids: new Set(users.map((u) => String(u._id))) };
  return cache.ids;
}

// Список поменялся — сбрасываем кэш, чтобы доступ включался сразу, а не через минуту.
function resetCache() { cache = { at: 0, ids: new Set() }; }

module.exports = { isOwner, hasAccess, invite, revoke, list, allowedUserIds, resetCache, OWNER_ID };
