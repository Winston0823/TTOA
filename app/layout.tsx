import type { Metadata, Viewport } from "next";
import { Bungee } from "next/font/google";
import "./globals.css";

/**
 * The HUD face.
 *
 * The rest of the chrome runs on `font-display` — a rounded UI stack that
 * resolves to SF Rounded on iOS and Roboto/Helvetica everywhere else. That is
 * fine for a caption on a dark panel and wrong for the two numbers that have to
 * survive being composited over an arbitrary camera frame: it reads as OS
 * furniture next to hand-inked lettering, and the numerals differ by device.
 *
 * Bungee is a signage face — uniform, near-black strokes and simple counters,
 * which is exactly what holds up small and outlined. Self-hosted by `next/font`
 * at build time, so there is no runtime request and nothing to fall back to.
 */
const bungee = Bungee({
  weight: "400",
  subsets: ["latin"],
  display: "swap",
  variable: "--font-hud",
});

export const metadata: Metadata = {
  title: "Fisherman’s Nose",
  description: "A face-tracked fishing toy. Move your nose to aim, open your mouth to sink.",
  // The tab icon itself is `app/icon.png`, which the App Router finds and links
  // by convention — it needs no entry here. This is the SHARE card, which does:
  // the same art letterboxed onto the deep navy it already sits on, because a
  // square crops badly at 1.91:1.
  openGraph: {
    title: "Fisherman’s Nose",
    description: "A face-tracked fishing toy. Move your nose to aim, open your mouth to sink.",
    images: [{ url: "/og.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/og.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#0d0722",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${bungee.variable} font-display antialiased`}>{children}</body>
    </html>
  );
}
