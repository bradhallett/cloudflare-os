import { useCallback, useEffect, useRef, useState } from "react";
import CatalogSection from "./CatalogSection";
import DisclosureSection from "./DisclosureSection";
import KeyModeSection from "./KeyModeSection";
import SharingSection from "./SharingSection";
import UsageSection from "./UsageSection";
import type {
  ComposioAppUiClient,
  KeyMode,
  SearchResult,
  Usage,
} from "./types";

export type { ComposioAppUiClient } from "./types";

type Props = {
  ui: ComposioAppUiClient;
};

export default function ComposioPage({ ui }: Props) {
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [searching, setSearching] = useState(true);
  const [searchError, setSearchError] = useState<string>();
  const [keyMode, setKeyMode] = useState<KeyMode>();
  const [sharingEnabled, setSharingEnabled] = useState<boolean>();
  const [usage, setUsage] = useState<Usage>();
  const searchEpoch = useRef(0);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const search = useCallback(async () => {
    const epoch = ++searchEpoch.current;
    setSearching(true);
    setSearchError(undefined);
    try {
      const next = await ui.searchToolkits(debouncedQuery);
      if (epoch !== searchEpoch.current) return;
      setResult(next);
    } catch (caught) {
      if (epoch === searchEpoch.current)
        setSearchError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (epoch === searchEpoch.current) setSearching(false);
    }
  }, [ui, debouncedQuery]);

  useEffect(() => {
    void search();
  }, [search]);

  const refreshKeyMode = useCallback(async () => {
    try {
      setKeyMode((await ui.getKeyMode()).keyMode);
    } catch {
      // The section renders an unknown-mode notice; retry rides the next refresh.
    }
  }, [ui]);

  const refreshSharing = useCallback(async () => {
    try {
      setSharingEnabled((await ui.getSharing()).enabled);
    } catch {
      // Same posture as the key mode: absence renders as unknown, never as consent.
    }
  }, [ui]);

  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await ui.getUsage());
    } catch {
      // Usage is informational; a failed read leaves the section hidden.
    }
  }, [ui]);

  useEffect(() => {
    void refreshKeyMode();
    void refreshSharing();
    void refreshUsage();
  }, [refreshKeyMode, refreshSharing, refreshUsage]);

  // Stable identity: the catalog's connect-poll effect depends on this callback, and an inline
  // arrow here would restart its interval on every render.
  const handleConnectedChanged = useCallback(() => {
    void search();
    void refreshUsage();
  }, [search, refreshUsage]);

  return (
    <main className="mx-auto min-h-full w-full max-w-5xl px-5 py-10 sm:px-8 sm:py-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Composio</h1>
        <p className="mt-1 text-sm text-kumo-subtle">
          Connect apps through the Composio catalog and manage how this account uses them.
        </p>
      </header>

      <CatalogSection
        ui={ui}
        query={query}
        onQueryChange={setQuery}
        result={result}
        searching={searching}
        error={searchError}
        onRetrySearch={() => void search()}
        onConnectedChanged={handleConnectedChanged}
      />

      <KeyModeSection ui={ui} keyMode={keyMode} onKeyModeChanged={refreshKeyMode} />
      <SharingSection ui={ui} enabled={sharingEnabled} onSharingChanged={refreshSharing} />
      <UsageSection usage={usage} />
      <DisclosureSection />
    </main>
  );
}
