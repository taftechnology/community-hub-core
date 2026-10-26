import { Component, type ReactNode } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  hasError: boolean;
};

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(): void {
    // Intentionally empty: no console logging or error reporting
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return <h1>Something went wrong. Reload the page.</h1>;
    }
    return this.props.children;
  }
}
