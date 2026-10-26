/** Context Library page entry: iframe-local selection state routing to the editor or the skills navigator. */

import { useCallback, useState } from "react";
import { SkillsNavigatorPage } from "../skills/SkillsNavigatorPage";
import { CollectionEditor } from "./CollectionEditor";

export default function ContextLibraryPage() {
  // Iframe-local selection state (no router/URL).
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);

  const goToCollection = useCallback((id: string | null) => {
    setSelectedCollection(id);
    setSelectedDoc(null);
  }, []);
  const goToDoc = useCallback((path: string | null) => {
    setSelectedDoc(path);
  }, []);

  if (selectedCollection) {
    return (
      <div className="h-full bg-kumo-base">
        <CollectionEditor
          collectionId={selectedCollection}
          selectedPath={selectedDoc}
          onSelectPath={goToDoc}
          onBack={() => {
            goToCollection(null);
          }}
        />
      </div>
    );
  }

  return (
    <SkillsNavigatorPage
      onSelectSkill={(collectionId, manifestPath) => {
        setSelectedCollection(collectionId);
        setSelectedDoc(manifestPath);
      }}
      onOpenCollection={goToCollection}
    />
  );
}
