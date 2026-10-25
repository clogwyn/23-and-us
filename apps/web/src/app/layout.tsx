import type { Metadata, Viewport } from "next";
import "@/styles/base.css";
import "@/styles/views.css";
import "@/styles/app.css";

export const metadata: Metadata = {
  title: { default: "23 & Us", template: "%s · 23 & Us" },
  description: "Plan, schedule and budget the renovation of number 23.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#7f5130" },
    { media: "(prefers-color-scheme: dark)", color: "#5e3b22" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,300..800&family=Caprasimo&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
