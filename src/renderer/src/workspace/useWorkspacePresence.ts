import { useEffect, useState } from 'react'

export const WORKSPACE_MOTION_MS = 220

/** Keep the existing content mounted while its closing animation finishes. */
export function useWorkspacePresence(open: boolean): boolean {
  const [present, setPresent] = useState(open)
  useEffect(() => {
    if (open) { setPresent(true); return }
    const timer = setTimeout(() => setPresent(false), WORKSPACE_MOTION_MS)
    return () => clearTimeout(timer)
  }, [open])
  return open || present
}
