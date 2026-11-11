// Аутентификация БЕЗ требования активного тарифа.
// Для маршрутов, доступных и без покупки (чат /app с дневным лимитом 10/сутки).
// Ставит req.user (Mongoose-документ, чтобы можно было менять/сохранять счётчики).
// Всё платное (интеграции/данные/студия) по-прежнему за checkAccess.
const User = require('../models/User');
const EmbedToken = require('../models/EmbedToken');

module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'API key is missing' });

    const key = authHeader.replace('Bearer ', '').trim();
    if (!key || key.length < 16 || key.length > 128) {
      return res.status(401).json({ error: 'Invalid API key format' });
    }

    let user = await User.findOne({ apiKey: key });
    if (!user) {
      const embedToken = await EmbedToken.findOne({ token: key, expiresAt: { $gt: new Date() } });
      if (embedToken) user = await User.findById(embedToken.userId);
    }
    if (!user) return res.status(403).json({ error: 'Invalid API Key' });

    req.user = user;
    // lastActiveAt обновляем отдельным запросом (НЕ user.save()) — иначе гонка с
    // сохранением счётчика чата в обработчике /send («parallel save» у Mongoose).
    User.updateOne({ _id: user._id }, { $set: { lastActiveAt: new Date() } }).catch(() => {});
    next();
  } catch (err) {
    console.error('❌ authOnly error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
