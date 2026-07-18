import type { Metadata } from "next";
import "./globals.css";

const SITE_URL = "https://vigil-midnight.vercel.app";
const DESCRIPTION =
  "A zero-knowledge dead man's switch on Midnight. Keep your vigil and the vault stays sealed; miss it and your heir can claim with a ZK proof. Identities, balances, and the legacy note never touch the chain in the clear.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "VIGIL: a zero-knowledge dead man's switch on Midnight",
    template: "%s · VIGIL",
  },
  description: DESCRIPTION,
  keywords: [
    "Midnight Network",
    "zero-knowledge proofs",
    "dead man's switch",
    "digital inheritance",
    "Compact smart contract",
    "privacy",
    "ZK",
  ],
  openGraph: {
    title: "VIGIL: a zero-knowledge dead man's switch on Midnight",
    description: DESCRIPTION,
    url: SITE_URL,
    siteName: "VIGIL",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "VIGIL: a zero-knowledge dead man's switch on Midnight",
    description:
      "Keep your vigil and the vault stays sealed; miss it and your heir claims with a ZK proof. Live on Midnight Preprod.",
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
