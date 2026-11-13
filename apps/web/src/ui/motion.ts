/** Motion preferences. Animations use the Motion library (motion.dev, MIT, pinned in apps/web/package.json). */
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
