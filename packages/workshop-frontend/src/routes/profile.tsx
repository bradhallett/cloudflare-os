import { createFileRoute } from '@tanstack/react-router'
import SettingsPage from '../SettingsPage'

type ProfileSearch = {
  // The org whose billing tab the settings page opens on (the org switcher and the upgrade
  // prompt link with it); absent means the first org.
  org?: string
}

export const Route = createFileRoute('/profile')({
  component: ProfileRoute,
  validateSearch: (search: Record<string, unknown>): ProfileSearch => ({
    org: typeof search.org === 'string' && search.org !== '' ? search.org : undefined,
  }),
})

// The search flows in as a prop rather than being read once at mount: a search-only change
// re-renders — never remounts — this route, so reading it live is what lets the org billing
// tabs follow ?org=.
function ProfileRoute() {
  return <SettingsPage org={Route.useSearch().org} />
}
