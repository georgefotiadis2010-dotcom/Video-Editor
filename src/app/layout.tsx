import type { Metadata } from "next";
import { Inter, Permanent_Marker, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
});

const permanentMarker = Permanent_Marker({
  variable: "--font-permanent-marker",
  subsets: ["latin"],
  weight: "400",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
});

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const metadata: Metadata = {
  title: "LXG | Batch Short-Form Video Renderer",
  description:
    "Local FFmpeg.wasm batch renderer in lxgmusic.com style. Upload one background loop, paste 20 proven hooks, and render 20 unique MP4s in minutes.",
  icons: {
    icon: `${basePath}/lxg-favicon.png`,
    apple: `${basePath}/lxg-favicon.png`,
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${permanentMarker.variable} ${jetbrainsMono.variable} h-full dark antialiased`}
    >
      <body className="min-h-full flex flex-col bg-surface text-on-surface selection:bg-accent selection:text-white">
        {children}
      </body>
    </html>
  );
}
