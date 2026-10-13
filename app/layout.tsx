import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Nightcap",
  description: "Night-out itineraries for New York.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
