import type { Metadata } from "next";
import { Inter } from "next/font/google";

import "./wine.css";

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-inter",
  display: "swap",
});

import "./globals.css";

export const metadata: Metadata = {
  title: "Nightcap",
  description: "Night-out itineraries for New York.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.variable}>
      <body>{children}</body>
    </html>
  );
}
