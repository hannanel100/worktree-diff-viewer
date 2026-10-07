import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import 'diff2html/bundles/css/diff2html.min.css';
import './hljs.css';
import './globals.css';

import { ClientOnly } from '@/components/ClientOnly';
import { RepoProvider } from '@/components/RepoProvider';
import { TopBar } from '@/components/TopBar';

export const metadata: Metadata = {
  title: 'Worktree Diff',
  description: 'What each worktree of this repository changed against a base branch.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <RepoProvider>
          <ClientOnly fallback={<header className="topbar" />}>
            <TopBar />
          </ClientOnly>
          <main id="main">{children}</main>
        </RepoProvider>
      </body>
    </html>
  );
}
