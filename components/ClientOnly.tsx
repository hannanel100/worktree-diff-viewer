'use client';

import { useEffect, useState, type ReactNode } from 'react';

/**
 * Renders children only in the browser. Every screen here is driven by the
 * local API and localStorage, so there is nothing useful to prerender and
 * skipping SSR avoids hydration mismatches.
 */
export function ClientOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <>{children}</> : <>{fallback}</>;
}
