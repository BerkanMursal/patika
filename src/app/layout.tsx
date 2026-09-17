import type { Metadata } from 'next';
import { DM_Sans, Manrope } from 'next/font/google';
import './atlas.css';
const sans=DM_Sans({subsets:['latin','latin-ext'],variable:'--font-sans',display:'swap'});
const heading=Manrope({subsets:['latin','latin-ext'],variable:'--font-heading',display:'swap'});
export const metadata: Metadata = {
  title: 'Patika — Mimari atlası',
  description: 'Patika mobil uygulamasının sistem mimarisi, veri ilişkileri ve besleme akışının görsel haritası.',
  robots: { index: false, follow: false },
  icons: { icon: '/favicon.svg' },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="tr" className={`${sans.variable} ${heading.variable}`}><body>{children}</body></html>;
}
