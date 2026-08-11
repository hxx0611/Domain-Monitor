import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Domain Monitor",
  description: "A lightweight, modern, self-hostable domain lifecycle monitoring platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
