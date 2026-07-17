import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VIGIL",
  description:
    "A zero-knowledge dead man's switch on Midnight. While the owner keeps their vigil, the vault is sealed.",
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
