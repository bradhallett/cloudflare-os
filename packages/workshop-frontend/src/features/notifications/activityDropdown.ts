// The activity dropdown exists in one workspace's header at a time, so it reports the workspace
// it is open in. Like visibleChat, it reports a getter, read when a notification arrives so it
// reflects the layout at that moment.

let getOpenDropdownWorkspace = (): string | null => null

/** Reports the workspace whose activity dropdown is open; returns the cleanup that withdraws the report. */
export const reportActivityDropdown = (get: () => string | null) => {
  getOpenDropdownWorkspace = get
  return () => {
    if (getOpenDropdownWorkspace === get) getOpenDropdownWorkspace = () => null
  }
}

/** Whether the activity dropdown is open over the workspace's pending requests. */
export const isActivityDropdownOpen = (workspaceId: string) =>
  getOpenDropdownWorkspace() === workspaceId
