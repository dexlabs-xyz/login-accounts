/**
 * Node.js globals the Railgun SDK expects, provided for the browser worker.
 * Must be imported before the SDK.
 */
import { Buffer } from 'buffer';

const g = globalThis as unknown as { Buffer?: typeof Buffer; global?: unknown; process?: { env: Record<string, string>; version: string; browser: boolean } };
g.Buffer ??= Buffer;
g.global ??= globalThis;
g.process ??= { env: {}, version: '', browser: true };
