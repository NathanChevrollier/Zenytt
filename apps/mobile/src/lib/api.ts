// Enveloppes typées des commandes Rust de `src-tauri/src` (un appel = une commande).
import { Channel, invoke } from "@tauri-apps/api/core";

export type AuthKind = "password" | "key" | "agent";

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: AuthKind;
  keyPath?: string | null;
  group?: string | null;
  /** De quoi se connecter est présent sur ce téléphone. */
  authReady: boolean;
}

export interface ServerInput {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authKind: AuthKind;
  /** Secrets : `undefined` = inchangé, `""` = supprimé. */
  password?: string;
  privateKey?: string;
  passphrase?: string;
  sudoPassword?: string;
}

export interface Disk {
  mount: string;
  device: string;
  total: number;
  used: number;
  readOnly: boolean;
  ignored: boolean;
}

export interface Metrics {
  cpuPercent: number;
  cpuCount: number;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  load: [number, number, number];
  uptimeSecs: number;
  disks: Disk[];
}

export interface AgentAlert {
  key: string;
  title: string;
  message: string;
  /** Horodatage (ms) du déclenchement. */
  since: number;
}

export interface Summary {
  connected: boolean;
  error: string | null;
  metrics: Metrics | null;
  agent: boolean;
  alerts: AgentAlert[];
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  condition: string;
  composeProject: string | null;
}

export interface Jail {
  name: string;
  currentlyBanned: number;
  totalBanned: number;
  banned: string[];
}

export interface Fail2banState {
  installed: boolean;
  running: boolean;
  jails: Jail[];
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "dir" | "file" | "symlink" | "other";
  targetIsDir: boolean;
  size: number;
  modified: number | null;
}

export interface SyncConfig {
  mode: "off" | "file" | "server";
  tunnel?: { serverId: string; port: number } | null;
  lastSync?: number | null;
}

export type TermEvent = { type: "data"; data: string } | { type: "exit"; code: number | null };

export const api = {
  servers: () => invoke<Server[]>("servers_list"),
  saveServer: (input: ServerInput) => invoke<string>("server_save", { input }),
  deleteServer: (id: string) => invoke<void>("server_delete", { id }),
  retry: (id: string) => invoke<void>("server_retry", { id }),
  trustHost: (id: string, fingerprint: string) => invoke<void>("host_trust", { id, fingerprint }),

  syncConfig: () => invoke<SyncConfig | null>("sync_get"),
  syncNow: () => invoke<unknown>("sync_now"),
  syncJoin: (code: string, passphrase: string) => invoke<unknown>("sync_join", { code, passphrase }),

  summary: (serverId: string) => invoke<Summary>("dashboard_summary", { serverId }),
  containers: (serverId: string) => invoke<{ available: boolean; containers: Container[] }>("docker_list", { serverId }),
  containerAction: (serverId: string, container: string, action: "start" | "stop" | "restart") =>
    invoke<void>("docker_action", { serverId, container, action }),
  containerLogs: (serverId: string, container: string, tail = 150) => invoke<string>("docker_logs", { serverId, container, tail }),
  fail2ban: (serverId: string) => invoke<Fail2banState>("f2b_state", { serverId }),
  unban: (serverId: string, jail: string, ip: string) => invoke<void>("f2b_unban", { serverId, jail, ip }),
  reboot: (serverId: string) => invoke<void>("server_reboot", { serverId }),

  files: (serverId: string, path?: string) => invoke<{ path: string; entries: FileEntry[] }>("files_list", { serverId, path }),
  download: (serverId: string, path: string) => invoke<string>("files_download", { serverId, path }),
  upload: (serverId: string, dir: string, name: string, data: string) => invoke<void>("files_upload", { serverId, dir, name, data }),
  removeFile: (serverId: string, path: string) => invoke<void>("files_remove", { serverId, path }),
  renameFile: (serverId: string, from: string, to: string) => invoke<void>("files_rename", { serverId, from, to }),

  termOpen: (serverId: string, cols: number, rows: number, onEvent: (e: TermEvent) => void) => {
    const channel = new Channel<TermEvent>();
    channel.onmessage = onEvent;
    return invoke<number>("term_open", { serverId, cols, rows, onEvent: channel });
  },
  termWrite: (id: number, data: string) => invoke<void>("term_write", { id, data }),
  termResize: (id: number, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows }),
  termClose: (id: number) => invoke<void>("term_close", { id }),
};

/** Message lisible d'une erreur renvoyée par Rust (une chaîne) ou levée par le pont. */
export function errorMessage(e: unknown): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
}
