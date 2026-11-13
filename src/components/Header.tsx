"use client";

import Image from "next/image";
import { ExternalLink } from "lucide-react";

export function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-white/10 bg-[#0D0E12]/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2.5">
          <Image
            src="/lxg-logo.png"
            alt="LXG"
            width={28}
            height={28}
            className="h-7 w-auto object-contain"
            priority
          />
          <span className="font-[var(--font-permanent-marker)] text-lg tracking-wide text-[#F5F5F2]">
            LXG
          </span>
        </div>

        <a
          href="https://www.lxgmusic.com"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-mono text-xs text-[#8B8F9C] transition hover:text-[#F5F5F2]"
        >
          <span>lxgmusic.com</span>
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </header>
  );
}
