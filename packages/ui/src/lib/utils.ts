// Copied from shadcn/ui base-nova (CLI 4.21.0). MIT License. See THIRD_PARTY_NOTICES.

import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
