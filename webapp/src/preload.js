// Прогрев картинок: декодируем все изображения экранов заранее, пока
// пользователь на приветственном экране. Иначе первый заход на вкладку
// декодирует PNG прямо во время fade-перехода → «дёрганый» первый переход.
import robotHero from './assets/robot-hero.webp'
import botOnline from './assets/bot_online.webp'
import botOffline from './assets/bot_offline.webp'
import botNotcreated from './assets/bot_notcreated.webp'

const ASSETS = [robotHero, botOnline, botOffline, botNotcreated]

export function preloadImages() {
  for (const src of ASSETS) {
    const img = new Image()
    img.src = src
    // decode() форсирует декодирование вне основного кадра отрисовки
    if (img.decode) img.decode().catch(() => {})
  }
}
