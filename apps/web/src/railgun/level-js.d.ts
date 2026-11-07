// level-js ships no types. The Railgun engine only needs it as an AbstractLevelDOWN store.
declare module 'level-js' {
  import type { AbstractLevelDOWN } from 'abstract-leveldown';
  const LevelJS: new (location: string) => AbstractLevelDOWN;
  export default LevelJS;
}
