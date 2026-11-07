declare module 'memdown' {
  /** In-memory LevelDOWN store (abstract-leveldown 7). */
  const MemDown: new () => import('abstract-leveldown').AbstractLevelDOWN;
  export default MemDown;
}
