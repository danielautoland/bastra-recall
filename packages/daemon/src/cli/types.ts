export interface InstallOpts {
  dryRun: boolean;
  vaultPath: string | null;
}

export interface InstallResult {
  status: "installed" | "already-installed" | "would-install" | "error" | "not-implemented";
  message: string;
  configPath?: string;
  backupPath?: string;
}

export interface UninstallResult {
  status: "removed" | "not-present" | "would-remove" | "error" | "not-implemented";
  message: string;
  configPath?: string;
  backupPath?: string;
}

export interface DoctorResult {
  status: "ok" | "missing" | "broken" | "not-implemented";
  message: string;
  details?: Record<string, string>;
}

export interface Adapter {
  surface: string;
  description: string;
  configPath: string;
  install(opts: InstallOpts): Promise<InstallResult>;
  uninstall(opts: { dryRun: boolean }): Promise<UninstallResult>;
  doctor(): Promise<DoctorResult>;
}

export interface ParsedArgs {
  command: string | null;
  surface: string | null;
  dryRun: boolean;
  vaultPath: string | null;
  showHelp: boolean;
  showVersion: boolean;
}
