import {
  createContext,
  forwardRef,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

export interface ScreenTitleContextValue {
  title: string;
  setTitle: (title: string) => void;
  titleRef: RefObject<HTMLHeadingElement | null>;
}

export const ScreenTitleContext = createContext<ScreenTitleContextValue | null>(null);

export function useScreenTitleContext(): ScreenTitleContextValue | null {
  return useContext(ScreenTitleContext);
}

export function ScreenTitleProvider({
  children,
  initialTitle = "",
}: {
  children: ReactNode;
  initialTitle?: string;
}) {
  const [title, setTitle] = useState(initialTitle);
  const titleRef = useRef<HTMLHeadingElement | null>(null);

  const value = useMemo(() => ({ title, setTitle, titleRef }), [title]);

  return <ScreenTitleContext.Provider value={value}>{children}</ScreenTitleContext.Provider>;
}

export interface ScreenTitleProps {
  children: string;
}

export const ScreenTitle = forwardRef<HTMLHeadingElement, ScreenTitleProps>(function ScreenTitle(
  { children },
  ref,
) {
  const context = useContext(ScreenTitleContext);

  useLayoutEffect(() => {
    if (!context) {
      return;
    }
    if (context.title !== children) {
      context.setTitle(children);
    }
    const heading = context.titleRef.current;
    if (ref) {
      if (typeof ref === "function") {
        ref(heading);
      } else {
        (ref as React.MutableRefObject<HTMLHeadingElement | null>).current = heading;
      }
    }
    return () => {
      if (ref) {
        if (typeof ref === "function") {
          ref(null);
        } else {
          (ref as React.MutableRefObject<HTMLHeadingElement | null>).current = null;
        }
      }
    };
  }, [context, children, ref]);

  if (context) {
    return null;
  }

  return (
    <h1 ref={ref} tabIndex={-1}>
      {children}
    </h1>
  );
});
