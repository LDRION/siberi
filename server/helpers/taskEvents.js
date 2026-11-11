'use strict';
/*
  События задач внутри siberi-api: Task.post('save') → 'saved'.

  Зачем: воркер раньше подбирал новые задачи опросом раз в 300 мс, а маршруты
  /api/v1/ai/* ждали результат, опрашивая базу раз в 700 мс. Теперь новая задача
  будит воркер сразу, а готовый ответ отдаётся в момент сохранения. Задачи, которые
  сохраняет другой процесс (siberi-bot), сюда не попадают — для них остаётся обычный
  опрос; события его только ускоряют, не заменяют.
*/
const { EventEmitter } = require('events');

const taskEvents = new EventEmitter();
taskEvents.setMaxListeners(0);

const isFinal = (t) => !!t && (t.status === 'completed' || t.status === 'error');

/**
 * Ждёт, пока задача не станет «интересной» (по умолчанию — завершённой), но не дольше
 * timeoutMs. Слушатель ставится ДО чтения из базы, поэтому сохранение между чтением и
 * ожиданием не теряется. recheckMs — страховочное перечитывание базы (на случай задач
 * из другого процесса). Возвращает свежий lean-документ; null — задачи нет.
 */
async function waitForTask(Task, taskId, { timeoutMs = 120000, until = isFinal, recheckMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let hit = false;
  let wake = null;
  const onSaved = (d) => {
    if (d && d.taskId === taskId && until(d)) { hit = true; if (wake) wake(); }
  };
  taskEvents.on('saved', onSaved);
  try {
    for (;;) {
      const doc = await Task.findOne({ taskId }).lean();
      if (!doc || until(doc) || Date.now() >= deadline) return doc;
      if (!hit) {
        await new Promise((resolve) => {
          wake = resolve;
          setTimeout(resolve, Math.max(0, Math.min(recheckMs, deadline - Date.now())));
        });
      }
      wake = null;
      hit = false;
    }
  } finally {
    taskEvents.off('saved', onSaved);
  }
}

module.exports = { taskEvents, waitForTask, isFinal };
