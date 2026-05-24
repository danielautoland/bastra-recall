/**
 * Env-Var-Helper mit Legacy-Fallback.
 *
 * Migration `NEXUS_*` → `BASTRA_*`: jeder Daemon-Read greift erst auf den
 * neuen Namen zu, dann auf den alten als Backwards-Compat (für Daniels
 * Shell-RC, Mac-App-Configs und gespawnte Subprocesses, die noch die alte
 * Familie schicken). Wenn der Legacy-Name greift, schreiben wir genau
 * einmal pro Prozess eine Warnung nach stderr — damit der User weiß, dass
 * er auf den neuen Namen umstellen sollte.
 */
const warned = new Set<string>();

export function envFirst(...names: string[]): string | undefined {
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const value = process.env[name];
    if (value !== undefined && value !== "") {
      if (i > 0 && !warned.has(name)) {
        warned.add(name);
        console.error(
          `[bastra-recall] legacy env var ${name} in use — please rename to ${names[0]}.`,
        );
      }
      return value;
    }
  }
  return undefined;
}

export function envInt(name: string, fallback: number, legacyName?: string): number {
  const raw = legacyName ? envFirst(name, legacyName) : process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function envFloat(name: string, fallback: number, legacyName?: string): number {
  const raw = legacyName ? envFirst(name, legacyName) : process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(name: string, fallback: boolean, legacyName?: string): boolean {
  const raw = legacyName ? envFirst(name, legacyName) : process.env[name];
  if (raw == null || raw === "") return fallback;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}
