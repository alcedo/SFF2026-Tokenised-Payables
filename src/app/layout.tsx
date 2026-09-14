import type { Metadata, Viewport } from 'next';

import { Shell } from '@/components/Shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'ADATA Tokenised Payables',
  description:
    'Clickable demo of the ADATA tokenised payables programme. Project BLOOM, StraitsX with ADATA and BaaS Innovations. Simulated data, no real funds.',
  robots: { index: false, follow: false },
};

/**
 * PRD §14: "Desktop first, usable down to iPad." The layout never scales below
 * a readable figure size, so the viewport is left at its natural scale.
 */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * The world is shared and the clock can move under an open tab, so nothing here
 * is statically rendered. PRD §14 requires changes to be reflected in other
 * sessions without a manual reset.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        {/*
          PRD §11: 'The "Demo environment — no real funds" ribbon is always
          visible.' It lives in the root layout so no route can render without it.
        */}
        <div
          role="status"
          className="sticky top-0 z-50 border-b border-caution/30 bg-caution-soft px-3 py-1 text-center text-[11px] font-medium tracking-wide text-caution"
        >
          Demo environment — no real funds. All balances, wallets, grades and transactions are simulated.
        </div>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
