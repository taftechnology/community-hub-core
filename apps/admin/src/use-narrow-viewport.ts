import { useEffect, useState } from "react";

export const NARROW_VIEWPORT_QUERY = "(max-width: 639.98px)";

export function useNarrowViewport(query: string = NARROW_VIEWPORT_QUERY): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(query);
    } catch {
      return;
    }

    setMatches(mql.matches);

    const onChange = (event: MediaQueryListEvent | Event) => {
      if ("matches" in event && typeof (event as MediaQueryListEvent).matches === "boolean") {
        setMatches((event as MediaQueryListEvent).matches);
      } else {
        setMatches(mql.matches);
      }
    };

    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => {
        mql.removeEventListener("change", onChange);
      };
    }

    if (
      typeof (mql as unknown as { addListener?: (cb: (e: Event) => void) => void }).addListener ===
      "function"
    ) {
      const legacyMql = mql as unknown as {
        addListener: (cb: (e: Event) => void) => void;
        removeListener: (cb: (e: Event) => void) => void;
      };
      legacyMql.addListener(onChange);
      return () => {
        legacyMql.removeListener(onChange);
      };
    }
  }, [query]);

  return matches;
}
