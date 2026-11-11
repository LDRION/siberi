import { createContext, useCallback, useContext, useState } from 'react';

const Ctx = createContext(null);

export function TutorialProvider({ children }) {
  const [enabled, setEnabledState] = useState(() => {
    const v = localStorage.getItem('tutorialEnabled');
    return v === null ? true : v === 'true';
  });
  const [steps, setSteps] = useState([]);
  const [idx, setIdx] = useState(-1);
  const [originPath, setOriginPath] = useState(null);
  const [skipped, setSkipped] = useState(false);
  const [completedPaths, setCompletedPaths] = useState(new Set());

  const setEnabled = useCallback((val) => {
    setEnabledState(val);
    localStorage.setItem('tutorialEnabled', String(val));
    if (!val) {
      setIdx(-1);
      setSteps([]);
      setOriginPath(null);
    } else {
      setSkipped(false);
      setCompletedPaths(new Set());
    }
  }, []);

  const startTutorial = useCallback((newSteps, path) => {
    if (window.matchMedia('(hover: none) and (pointer: coarse)').matches) return;
    setSteps(newSteps);
    setIdx(0);
    setOriginPath(path || null);
    setSkipped(false);
  }, []);

  const next = useCallback(() => {
    const isLast = idx + 1 >= steps.length;
    if (isLast) {
      setCompletedPaths(prev => {
        const s = new Set(prev);
        if (originPath) s.add(originPath);
        return s;
      });
      setSteps([]);
      setIdx(-1);
      setOriginPath(null);
      setSkipped(false);
    } else {
      setIdx(i => i + 1);
    }
  }, [idx, steps.length, originPath]);

  const skip = useCallback(() => {
    setIdx(-1);
    setSteps([]);
    setOriginPath(null);
    setSkipped(true); // explicitly skipped → block auto-starts for this session
  }, []);

  const isActive = idx >= 0 && idx < steps.length;
  const currentStep = isActive ? steps[idx] : null;

  return (
    <Ctx.Provider value={{
      enabled, setEnabled,
      startTutorial,
      currentStep, idx, total: steps.length,
      next, skip,
      isActive,
      originPath,
      skipped,
      completedPaths,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export const useTutorial = () => useContext(Ctx);
