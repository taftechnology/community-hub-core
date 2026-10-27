import { useEffect } from "react";
import { useLocation } from "react-router";

export function useFocusHeading(key?: unknown): void {
  const location = useLocation();

  useEffect(() => {
    const h1 = document.querySelector<HTMLHeadingElement>("h1");
    if (h1) {
      h1.focus();
    }
  }, [location.pathname, location.hash, key]);
}
