// Tipos do hook do Cursor (hook.mjs), para o instalador e os testes.
export const DEFAULT_PORT: number;
export const CONFIG_FILE: string;
export const OBSERVED: string[];
export function readPort(env?: NodeJS.ProcessEnv): number;
export function pickEvent(input: unknown): Record<string, string | string[]>;
export function passThrough(event: string): string;
