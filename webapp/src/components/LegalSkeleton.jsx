// Скелетон документа: показывается, пока подгружается чанк с юр-текстами (legal.jsx).
// Мерцающие строки сразу дают понять, что контент грузится, а не завис.

// [тип, ширина в %] — имитируем структуру документа: заголовок + абзацы.
const LINES = [
  ['t', 46],
  ['p', 97], ['p', 93], ['p', 80],
  ['t', 38],
  ['p', 95], ['p', 89], ['p', 96], ['p', 62],
  ['t', 43],
  ['p', 92], ['p', 85], ['p', 70],
]

export default function LegalSkeleton() {
  return (
    <div className="legal-skel" role="status" aria-busy="true" aria-label="Загружаем документ">
      {LINES.map(([type, w], i) => (
        <span
          key={i}
          className={`legal-skel__line legal-skel__line--${type}`}
          style={{ width: `${w}%`, animationDelay: `${(i % 6) * 0.08}s` }}
        />
      ))}
    </div>
  )
}
