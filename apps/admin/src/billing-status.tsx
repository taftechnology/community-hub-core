import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { type BillingStatus, post } from "./api";
import { useCommunity } from "./community";

export type BillingStatusContextValue = {
  status: BillingStatus | null;
  refresh: () => Promise<void>;
  returnMessage: string | null;
};

export const BillingStatusContext = createContext<BillingStatusContextValue>({
  status: null,
  refresh: async () => {},
  returnMessage: null,
});

export function useBillingStatus(): BillingStatusContextValue {
  return useContext(BillingStatusContext);
}

function isBillingStatus(value: unknown): value is BillingStatus {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return typeof candidate.state === "string";
}

export function BillingStatusProvider({ children }: { children: ReactNode }) {
  const { slug, version } = useCommunity();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [returnMessage, setReturnMessage] = useState<string | null>(null);
  const slugRef = useRef(slug);

  useEffect(() => {
    slugRef.current = slug;
  }, [slug]);

  const loadStatus = useCallback(
    async (
      communitySlug: string,
      isCurrent: () => boolean = () => true,
    ): Promise<void> => {
      const response = await post("/v1/billing/status", { communitySlug });
      if (!isCurrent()) {
        return;
      }
      if (response === "unavailable" || response.status !== 200) {
        if (!isCurrent()) {
          return;
        }
        setStatus(null);
        return;
      }
      try {
        const body: unknown = await response.json();
        if (!isCurrent()) {
          return;
        }
        if (isBillingStatus(body)) {
          setStatus(body);
        } else {
          setStatus(null);
        }
      } catch {
        if (!isCurrent()) {
          return;
        }
        setStatus(null);
      }
    },
    [],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const currentSlug = slugRef.current;
    if (!currentSlug) {
      return;
    }
    await loadStatus(currentSlug);
  }, [loadStatus]);

  useEffect(() => {
    let current = true;
    setStatus(null);
    setReturnMessage(null);
    if (!slug) {
      return;
    }
    void loadStatus(slug, () => current);
    return () => {
      current = false;
    };
  }, [slug, version, loadStatus]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.has("billing")) {
        const billing = url.searchParams.get("billing");
        url.searchParams.delete("billing");
        const nextSearch = url.searchParams.toString();
        const nextUrl =
          url.pathname + (nextSearch ? `?${nextSearch}` : "") + url.hash;
        window.history.replaceState(window.history.state, "", nextUrl);

        if (billing === "done") {
          setReturnMessage("Payment received, your plan will appear shortly");
          const timer = setTimeout(() => {
            void refresh();
          }, 5000);
          return () => clearTimeout(timer);
        }
        if (billing === "cancelled") {
          setReturnMessage("Checkout was cancelled");
          return;
        }
        if (billing === "portal") {
          void refresh();
          return;
        }
        // Unknown billing values are ignored and never rendered (Pin 18)
      }
    } catch {
      // Ignore URL parsing errors
    }
  }, [refresh]);

  return (
    <BillingStatusContext.Provider value={{ status, refresh, returnMessage }}>
      {children}
    </BillingStatusContext.Provider>
  );
}
