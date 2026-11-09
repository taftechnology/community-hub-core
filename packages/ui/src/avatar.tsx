import type * as React from "react";

import { cn } from "./lib/utils.js";

export const AVATAR_TONES = [
  "blue",
  "green",
  "orange",
  "violet",
  "pink",
  "fuchsia",
  "teal",
  "amber",
  "rose",
  "cyan",
] as const;

export type AvatarTone = (typeof AVATAR_TONES)[number];

const TONE_CLASSES: Record<AvatarTone, string> = {
  blue: "bg-tone-blue-tint text-tone-blue-ink",
  green: "bg-tone-green-tint text-tone-green-ink",
  orange: "bg-tone-orange-tint text-tone-orange-ink",
  violet: "bg-tone-violet-tint text-tone-violet-ink",
  pink: "bg-tone-pink-tint text-tone-pink-ink",
  fuchsia: "bg-tone-fuchsia-tint text-tone-fuchsia-ink",
  teal: "bg-tone-teal-tint text-tone-teal-ink",
  amber: "bg-tone-amber-tint text-tone-amber-ink",
  rose: "bg-tone-rose-tint text-tone-rose-ink",
  cyan: "bg-tone-cyan-tint text-tone-cyan-ink",
};

export interface AvatarProps {
  name: string;
  className?: string;
}

function getInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "";
  }
  const parts = trimmed.split(/\s+/);
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first) {
    return "";
  }
  if (parts.length === 1 || !last) {
    return (first[0] ?? "").toUpperCase();
  }
  return `${first[0] ?? ""}${last[0] ?? ""}`.toUpperCase();
}

function getTone(name: string): AvatarTone {
  let h = 0;
  for (const ch of name) {
    h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  }
  return AVATAR_TONES[h % AVATAR_TONES.length] ?? "blue";
}

export function Avatar({ name, className }: AvatarProps) {
  const initials = getInitials(name);
  const tone = getTone(name);

  return (
    <span
      data-slot="avatar"
      data-tone={tone}
      aria-hidden="true"
      className={cn(
        "size-8 rounded-full inline-grid place-items-center font-bold text-[13px] leading-none flex-none select-none",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {initials}
    </span>
  );
}
