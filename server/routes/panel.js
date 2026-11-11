'use strict';
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { MongoClient } = require('mongodb');

const Task = require('../models/Task');
const BlockedEndUser = require('../models/BlockedEndUser');
const UserRecordSnapshot = require('../models/UserRecordSnapshot');
const Lead = require('../models/Lead');

// ── GET /history ──────────────────────────────────────────────────────────────
// Полная история запросов конечных пользователей (пагинация)
router.get('/history', async (req, res) => {
  try {
    const page    = Math.max(1, parseInt(req.query.page)  || 1);
    const limit   = Math.min(50, Math.max(5, parseInt(req.query.limit) || 20));
    const skip    = (page - 1) * limit;
    const platform  = req.query.platform  || null;
    const profileId = req.query.profileId || null;

    const filter = { userId: req.user._id };
    if (platform)  filter['endUser.platform'] = platform;
    if (profileId) filter.profileId = require('mongoose').Types.ObjectId.isValid(profileId) ? new (require('mongoose').Types.ObjectId)(profileId) : null;

    const [tasks, total] = await Promise.all([
      Task.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Task.countDocuments(filter),
    ]);

    // Помечаем задачи, у которых есть изменения данных (для кнопки «Откатить»)
    const taskIds = tasks.map((t) => t.taskId);
    const snapshotTaskIds = await UserRecordSnapshot.distinct('taskId', {
      ownerId: req.user._id,
      taskId: { $in: taskIds },
    });
    const snapshotSet = new Set(snapshotTaskIds);

    const result = tasks.map((t) => ({
      ...t,
      hasDataChanges: snapshotSet.has(t.taskId),
    }));

    res.json({ success: true, tasks: result, total, page, limit, pages: Math.ceil(total / limit) });
  } catch (err) {
    console.error('Panel history error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /users ────────────────────────────────────────────────────────────────
// Сводка по уникальным конечным пользователям
router.get('/users', async (req, res) => {
  try {
    const profileId = req.query.profileId || null;
    const matchStage = { userId: req.user._id, 'endUser.platformUserId': { $ne: '' }, 'endUser.platform': { $ne: 'studio' } };
    if (profileId && mongoose.Types.ObjectId.isValid(profileId)) {
      matchStage.profileId = new mongoose.Types.ObjectId(profileId);
    }

    const users = await Task.aggregate([
      {
        $match: matchStage,
      },
      {
        $group: {
          _id: {
            platform: '$endUser.platform',
            platformUserId: '$endUser.platformUserId',
          },
          count:       { $sum: 1 },
          lastActive:  { $max: '$createdAt' },
          ip:          { $last: '$endUser.ip' },
          username:    { $last: '$endUser.username' },
          displayName: { $last: '$endUser.displayName' },
        },
      },
      { $sort: { lastActive: -1 } },
      { $limit: 500 },
    ]);

    // Подставляем статус блокировки
    const blockedDocs = await BlockedEndUser.find({ blockedBy: req.user._id }).lean();
    const blockedMap  = new Map(blockedDocs.map((b) => [`${b.platform}:${b.platformUserId}`, b]));

    const result = users.map((u) => ({
      platform:       u._id.platform,
      platformUserId: u._id.platformUserId,
      username:       u.username || '',
      displayName:    u.displayName || '',
      count:          u.count,
      lastActive:     u.lastActive,
      ip:             u.ip,
      blockedDoc:     blockedMap.get(`${u._id.platform}:${u._id.platformUserId}`) || null,
    }));

    res.json({ success: true, users: result });
  } catch (err) {
    console.error('Panel users error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /blocked ──────────────────────────────────────────────────────────────
// Список заблокированных пользователей
router.get('/blocked', async (req, res) => {
  try {
    const blocked = await BlockedEndUser.find({ blockedBy: req.user._id })
      .sort({ blockedAt: -1 })
      .lean();
    res.json({ success: true, blocked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /block ───────────────────────────────────────────────────────────────
// Заблокировать конечного пользователя
router.post('/block', async (req, res) => {
  try {
    const { platform, platformUserId, reason, isGlobal } = req.body;
    if (!platform || !platformUserId) {
      return res.status(400).json({ error: 'platform и platformUserId обязательны' });
    }

    const existing = await BlockedEndUser.findOne({
      platform,
      platformUserId,
      blockedBy: req.user._id,
    });
    if (existing) {
      return res.status(409).json({ error: 'Пользователь уже заблокирован' });
    }

    const block = await BlockedEndUser.create({
      platform,
      platformUserId,
      blockedBy: req.user._id,
      isGlobal:  !!isGlobal,
      reason:    (reason || '').trim().slice(0, 200),
    });

    res.json({ success: true, block });
  } catch (err) {
    console.error('Panel block error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /block/:id ─────────────────────────────────────────────────────────
// Разблокировать пользователя
router.delete('/block/:id', async (req, res) => {
  try {
    const deleted = await BlockedEndUser.findOneAndDelete({
      _id: req.params.id,
      blockedBy: req.user._id,
    });
    if (!deleted) return res.status(404).json({ error: 'Запись о блокировке не найдена' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /snapshots/:taskId ────────────────────────────────────────────────────
// Перечень изменений данных в конкретной задаче
router.get('/snapshots/:taskId', async (req, res) => {
  try {
    const task = await Task.findOne({ taskId: req.params.taskId, userId: req.user._id }).lean();
    if (!task) return res.status(404).json({ error: 'Задача не найдена' });

    const snapshots = await UserRecordSnapshot.find({
      taskId: req.params.taskId,
      ownerId: req.user._id,
    }).lean();

    res.json({ success: true, snapshots });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /rollback/:taskId ────────────────────────────────────────────────────
// Откатить все изменения данных начиная с этой задачи
router.post('/rollback/:taskId', async (req, res) => {
  try {
    const pivotTask = await Task.findOne({
      taskId: req.params.taskId,
      userId: req.user._id,
    });
    if (!pivotTask) return res.status(404).json({ error: 'Задача не найдена' });

    // Все снапшоты начиная с момента этой задачи
    const snapshots = await UserRecordSnapshot.find({
      ownerId:   req.user._id,
      createdAt: { $gte: pivotTask.createdAt },
    })
      .sort({ createdAt: -1 }) // обрабатываем в обратном порядке (сначала свежие)
      .lean();

    if (snapshots.length === 0) {
      return res.json({ success: true, rolledBack: 0, message: 'Нет изменений данных для отката' });
    }

    let client;
    try {
      client = new MongoClient('mongodb://localhost:27017');
      await client.connect();
      const db         = client.db('siberiai_api');
      const collection = db.collection('userrecords');
      const userIdObj  = new mongoose.Types.ObjectId(req.user._id.toString());

      let rolledBack = 0;
      for (const snap of snapshots) {
        try {
          const recId = new mongoose.Types.ObjectId(snap.recordId.toString());

          if (snap.operation === 'create') {
            // Отмена создания — удаляем запись
            const targetId = snap.createdRecordId
              ? new mongoose.Types.ObjectId(snap.createdRecordId.toString())
              : recId;
            await collection.deleteOne({ _id: targetId, userId: userIdObj });
          } else if (snap.operation === 'update') {
            // Отмена изменения — восстанавливаем полный документ до изменения
            if (snap.fullDocBefore) {
              const docToRestore = { ...snap.fullDocBefore };
              delete docToRestore._id;
              await collection.replaceOne(
                { _id: recId, userId: userIdObj },
                { _id: recId, ...docToRestore },
              );
            }
          } else if (snap.operation === 'delete') {
            // Отмена удаления — восстанавливаем запись
            if (snap.fullDocBefore) {
              const exists = await collection.findOne({ _id: recId });
              if (!exists) {
                await collection.insertOne({ ...snap.fullDocBefore, _id: recId });
              }
            }
          }
          rolledBack++;
        } catch (stepErr) {
          console.warn('Rollback step error:', stepErr.message);
        }
      }

      // Удаляем откатанные снапшоты
      await UserRecordSnapshot.deleteMany({
        ownerId:   req.user._id,
        createdAt: { $gte: pivotTask.createdAt },
      });

      res.json({
        success: true,
        rolledBack,
        message: `Откат выполнен: ${rolledBack} изменени${rolledBack === 1 ? 'е' : 'й'} отменено`,
      });
    } finally {
      if (client) await client.close();
    }
  } catch (err) {
    console.error('Panel rollback error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /stats ────────────────────────────────────────────────────────────────
// Сводная статистика для шапки панели
router.get('/stats', async (req, res) => {
  try {
    const [totalTasks, uniqueUsers, blockedCount] = await Promise.all([
      Task.countDocuments({ userId: req.user._id }),
      Task.aggregate([
        { $match: { userId: req.user._id, 'endUser.platformUserId': { $ne: '' }, 'endUser.platform': { $ne: 'studio' } } },
        { $group: { _id: { platform: '$endUser.platform', platformUserId: '$endUser.platformUserId' } } },
        { $count: 'total' },
      ]),
      BlockedEndUser.countDocuments({ blockedBy: req.user._id }),
    ]);

    res.json({
      success: true,
      totalTasks,
      uniqueUsers: uniqueUsers[0]?.total || 0,
      blockedCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Заявки с лендинга («Сделаем за вас») ────────────────────────────────────────
// Видит только администратор сайта. Обычные пользователи с валидным API-ключом сюда
// не попадают — заявки это внутренняя воронка продаж, не их данные.
function requireSiteAdmin(req, res, next) {
  if (!req.user?.isSiteAdmin) return res.status(403).json({ error: 'Только для администратора сайта' });
  next();
}

// GET /leads — последние заявки (пагинация, фильтр по статусу)
router.get('/leads', requireSiteAdmin, async (req, res) => {
  try {
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, Math.max(5, parseInt(req.query.limit) || 50));
    const skip   = (page - 1) * limit;
    const status = req.query.status || null;

    const filter = {};
    if (status && ['new', 'contacted', 'won', 'lost'].includes(status)) filter.status = status;

    const [leads, total, newCount] = await Promise.all([
      Lead.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Lead.countDocuments(filter),
      Lead.countDocuments({ status: 'new' }),
    ]);

    res.json({
      success: true,
      leads,
      newCount,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /leads/:id/status — сменить статус заявки (new → contacted → won/lost)
router.patch('/leads/:id/status', requireSiteAdmin, async (req, res) => {
  try {
    const { status } = req.body || {};
    if (!['new', 'contacted', 'won', 'lost'].includes(status)) {
      return res.status(400).json({ error: 'Недопустимый статус' });
    }
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Неверный id' });
    }
    const lead = await Lead.findByIdAndUpdate(req.params.id, { status }, { new: true }).lean();
    if (!lead) return res.status(404).json({ error: 'Заявка не найдена' });
    res.json({ success: true, lead });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
