'use strict';
/*
  Приглашение в AiConstructor. «Лавочка» закрыта для всех, кроме владельца, и
  вход теперь только по личному приглашению — владелец выдаёт его командой
  /invite прямо в чате с конструктором.

  Приглашать можно двумя способами, поэтому оба поля необязательные:
    • по числовому id  → сразу знаем telegramId;
    • по @логину       → id узнаём при первом сообщении приглашённого и
                          дописываем сюда (bindTelegramId), чтобы дальше
                          проверять по id, даже если человек сменит ник.
*/
const mongoose = require('mongoose');

const tglbInviteSchema = new mongoose.Schema({
  telegramId: { type: String, default: '', index: true },
  // Всегда в нижнем регистре и без «@» — сравнение регистронезависимое.
  username: { type: String, default: '', index: true },
  invitedBy: { type: String, default: '' },   // telegramId того, кто пригласил
  note: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  firstSeenAt: { type: Date, default: null },  // когда приглашённый впервые написал
});

module.exports = mongoose.model('TglbInvite', tglbInviteSchema);
