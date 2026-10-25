/**
 * Shape of the `ui` RpcTarget (`ComposioAppUi`) the host frame mints per open, per the
 * package contract in `src/app-ui.ts`. The frame is sandboxed with no network access: every
 * piece of data below crosses the MessagePort RPC boundary, never fetch.
 */

export type KeyMode = "deployment" | "own";

export interface ToolkitSummary {
  slug: string;
  name: string;
  description?: string;
  logo?: string;
}

export interface CatalogEntry extends ToolkitSummary {
  toolCount: number;
}

export interface ConnectedAccountInfo {
  id: string;
  toolkitSlug: string;
  alias?: string;
  status: string;
  clientUniqueId?: string;
  createdAt?: string;
}

export interface QuotaCounters {
  reserved: number;
  settled: number;
  refused: number;
}

export interface SearchResult {
  entries: CatalogEntry[];
  connected: ConnectedAccountInfo[];
}

export interface ConnectAttempt {
  redirectUrl: string;
  connectedAccountId: string;
}

export interface Usage {
  deployment: QuotaCounters;
  own: QuotaCounters;
  limit: number;
}

/**
 * The owner-authenticated `ui` capability. Method names are fixed by the contract; the paste-in
 * key and every mutation ride the same owner fence that hosts this frame.
 */
export type ComposioAppUiClient = {
  searchToolkits(query: string): Promise<SearchResult>;
  connectToolkit(slug: string, alias?: string): Promise<ConnectAttempt>;
  pollConnectAttempt(connectedAccountId: string): Promise<{ status: string } | null>;
  disconnectToolkit(connectedAccountId: string): Promise<void>;
  getKeyMode(): Promise<{ keyMode: KeyMode }>;
  setOwnKey(key: string): Promise<void>;
  clearOwnKey(): Promise<void>;
  getSharing(): Promise<{ enabled: boolean }>;
  setSharing(on: boolean): Promise<void>;
  getUsage(): Promise<Usage>;
};
