import { useEffect, useState } from 'react';
import './ThinkingText.css';

const DEFAULT_PHRASES = [
  'Обрабатываю запрос',
  'Думаю',
  'Составляю план действий',
  'Учитываю данные из ваших схем',
  'Формулирую ответ',
  'Подготавливаю результат',
  'Ещё немного',
];

export default function ThinkingText({ phrases } = {}) {
  const PHRASES = phrases || DEFAULT_PHRASES;
  const [text, setText] = useState('');
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [phase, setPhase] = useState('typing');

  useEffect(() => {
    const phrase = PHRASES[phraseIdx % PHRASES.length];

    if (phase === 'typing') {
      if (text.length < phrase.length) {
        const t = setTimeout(() => setText(phrase.slice(0, text.length + 1)), 45);
        return () => clearTimeout(t);
      }
      const t = setTimeout(() => setPhase('erasing'), 1800);
      return () => clearTimeout(t);
    }

    if (phase === 'erasing') {
      if (text.length > 0) {
        const t = setTimeout(() => setText(prev => prev.slice(0, -1)), 22);
        return () => clearTimeout(t);
      }
      setPhraseIdx(i => (i + 1) % PHRASES.length);  // eslint-disable-line react-hooks/exhaustive-deps
      setPhase('typing');
    }
  }, [text, phase, phraseIdx]);

  return (
    <span className="thinking-text">
      {text}
      <span className="thinking-cursor" />
    </span>
  );
}
