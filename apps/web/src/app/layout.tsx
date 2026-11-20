import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Tax Operations", template: "%s · Tax Operations" },
  description: "AI-assisted tax data collection and validation for enterprise tax teams.",
  robots: { index: false, follow: false },
};
// Every page is rendered per request so each response carries a fresh script nonce (see src/proxy.ts).
export const dynamic = "force-dynamic";

export const viewport: Viewport = { colorScheme: "light dark" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">Skip to content</a>
        {children}
      </body>
    </html>
  );
}
