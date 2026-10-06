import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Ledger — Personal Finance', description: 'A clear view of your spending, powered by your private finance agent.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }
