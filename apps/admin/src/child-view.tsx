import { Button } from "@community-hub/ui";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { type ChildViewTarget, viewChildField } from "./api";
import { useCommunity } from "./community";
import { readErrorCode } from "./duplicate-deleted";
import { FreshCheck, useFreshCheckCalls } from "./fresh-check";
import { MESSAGES, NoticeAlert, readJson, useAttempt } from "./second-factor";

// The Community Admin's View of a child (ADR 0017). Every field of a child is hidden until it is
// asked for, one field at a time. A View needs a fresh second-factor check ("Confirm it's you") and
// uses it up, so the next View asks again.
//
// What a View answers lives in one place only: the state of the section that shows it, for that one
// field. It is never written to the address, to storage, to a log, to the console or to an error
// message, and no request is cached: a View is a POST, sent as it is needed. Asking for another
// field hides the first. Closing the family, or leaving the page, unmounts the section and drops the
// value with it.

export type { ChildViewTarget } from "./api";

const TEXT = {
  recovery: "Sign in again with your authenticator app or passkey to view children's details",
  notAllowed: "Not allowed",
  signedOut: "Your sign-in has ended. Sign in again.",
  reason: "Do this before you view a child's details.",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function viewKey(target: ChildViewTarget): string {
  const event = "lifeEventId" in target ? target.lifeEventId : "";
  return `${target.personId}|${event}|${target.field}`;
}

// What the service answers for one field: its text, or null when nothing is recorded. The name comes
// as its two parts. Anything else is not an answer, and shows nothing.
function readValue(
  field: ChildViewTarget["field"],
  body: unknown,
): { text: string | null } | undefined {
  if (!isRecord(body) || !("value" in body)) {
    return undefined;
  }
  const value = body.value;
  if (field === "name") {
    if (!isRecord(value)) {
      return undefined;
    }
    const parts: string[] = [];
    for (const part of [value.given, value.family]) {
      if (part === null) {
        continue;
      }
      if (typeof part !== "string") {
        return undefined;
      }
      if (part !== "") {
        parts.push(part);
      }
    }
    return { text: parts.length === 0 ? null : parts.join(" ") };
  }
  if (value === null) {
    return { text: null };
  }
  return typeof value === "string" ? { text: value } : undefined;
}

type Slot =
  | { key: string; phase: "loading" }
  | { key: string; phase: "shown"; text: string | null }
  | { key: string; phase: "not_found" }
  | undefined;

type ChildViewApi = {
  slot: Slot;
  // True while a View is on its way or the "Confirm it's you" panel is open: two Views at once would
  // race for one fresh check.
  busy: boolean;
  begin: (target: ChildViewTarget, trigger: HTMLElement) => void;
  hide: () => void;
};

const ChildViewContext = createContext<ChildViewApi | undefined>(undefined);

export function useChildView(): ChildViewApi | undefined {
  return useContext(ChildViewContext);
}

function ViewFreshCheck({ onPassed, onCancel }: { onPassed: () => void; onCancel: () => void }) {
  const calls = useFreshCheckCalls();
  return (
    <FreshCheck
      level={4}
      reason={TEXT.reason}
      loading={calls.loading}
      hasApp={calls.hasApp}
      passkeyUsable={calls.passkeyUsable}
      onCode={async (code) => {
        const outcome = await calls.onCode(code);
        if (outcome === "passed") {
          onPassed();
        }
        return outcome;
      }}
      onPasskey={async () => {
        const outcome = await calls.onPasskey();
        if (outcome === "passed") {
          onPassed();
        }
        return outcome;
      }}
      onCancel={onCancel}
    />
  );
}

// Why the page is told to read the family again: a child or a life event is gone, or the caller is
// not a Community Admin here (any more). The page keeps the "Not allowed" where it is read again.
export type StaleReason = "gone" | "not_allowed";

// Holds the one value on screen, runs a View, and opens the "Confirm it's you" panel when the
// service asks for it. `onStale` is called when the service says the child or the caller's role has
// changed since the page was read, so the page can read it again.
export function ChildViewProvider({
  onStale,
  children,
}: {
  onStale?: ((reason: StaleReason) => void) | undefined;
  children: ReactNode;
}) {
  const { slug } = useCommunity();
  const attempt = useAttempt();
  const [slot, setSlot] = useState<Slot>(undefined);
  const [panel, setPanel] = useState<ChildViewTarget | null>(null);

  // False once the section has gone, so a late answer changes nothing.
  const alive = useRef(true);
  // Counts the Views asked for; only the newest answer is used.
  const asked = useRef(0);
  const returnTo = useRef<HTMLElement | null>(null);
  const focusBack = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // When the panel closes, the focus goes back to the button that asked for the View.
  useLayoutEffect(() => {
    if (panel !== null || !focusBack.current) {
      return;
    }
    focusBack.current = false;
    const element = returnTo.current;
    if (element?.isConnected) {
      element.focus();
    }
  }, [panel]);

  async function perform(target: ChildViewTarget, retried: boolean): Promise<void> {
    const key = viewKey(target);
    const mine = ++asked.current;
    const current = () => alive.current && asked.current === mine;
    setSlot({ key, phase: "loading" });

    const response = await viewChildField(slug, target);
    if (!current()) {
      return;
    }
    if (response === "unavailable") {
      setSlot(undefined);
      attempt.showNotice(MESSAGES.generic);
      return;
    }
    if (response.status === 200) {
      const value = readValue(target.field, await readJson(response));
      if (!current()) {
        return;
      }
      if (value === undefined) {
        setSlot(undefined);
        attempt.showNotice(MESSAGES.generic);
        return;
      }
      setSlot({ key, phase: "shown", text: value.text });
      return;
    }

    if (response.status === 404) {
      // The child, or the life event, is not there any more: say so, and read the family again.
      setSlot({ key, phase: "not_found" });
      onStale?.("gone");
      return;
    }

    setSlot(undefined);
    if (response.status === 403) {
      const code = await readErrorCode(response);
      if (!current()) {
        return;
      }
      if (code === "fresh_required" && !retried) {
        // Asked for once. A second answer like this, straight after a check that passed, is an
        // error and not a reason to ask again.
        setPanel(target);
        return;
      }
      if (code === "recovery_session") {
        attempt.showNotice(TEXT.recovery);
        return;
      }
      if (code === null) {
        // The caller is not a Community Admin here (any more). The page says so, and reads the
        // family again; a section with no page to tell says so itself.
        if (onStale === undefined) {
          attempt.showNotice(TEXT.notAllowed);
        } else {
          onStale("not_allowed");
        }
        return;
      }
      attempt.showNotice(MESSAGES.generic);
      return;
    }
    attempt.showNotice(response.status === 401 ? TEXT.signedOut : MESSAGES.generic);
  }

  function begin(target: ChildViewTarget, element: HTMLElement): void {
    if (attempt.busy || panel !== null) {
      return;
    }
    returnTo.current = element;
    void attempt.run(() => perform(target, false));
  }

  function hide(): void {
    asked.current += 1;
    setSlot(undefined);
  }

  function passed(target: ChildViewTarget): void {
    focusBack.current = true;
    setPanel(null);
    void attempt.run(() => perform(target, true));
  }

  function cancel(): void {
    focusBack.current = true;
    setSlot(undefined);
    setPanel(null);
  }

  const api: ChildViewApi = {
    slot,
    busy: attempt.busy || panel !== null,
    begin,
    hide,
  };

  return (
    <ChildViewContext.Provider value={api}>
      <NoticeAlert notice={attempt.notice} />
      {panel === null ? null : (
        <ViewFreshCheck
          onPassed={() => {
            passed(panel);
          }}
          onCancel={cancel}
        />
      )}
      {children}
    </ChildViewContext.Provider>
  );
}

// One field of a child, as the screen shows it: hidden, with a View button that names the field and
// the child, or the one value that has been asked for, with a Hide button. `format` only changes
// how a value is written, such as a life event's type.
export function ChildValue({
  target,
  fieldName,
  subject,
  format,
}: {
  target: ChildViewTarget;
  // What the field is called, in the words of a button name: "date of birth".
  fieldName: string;
  // Whose it is: "Child 1".
  subject: string;
  format?: (text: string) => string;
}) {
  const view = useChildView();
  const key = viewKey(target);
  const mine = view?.slot?.key === key ? view.slot : undefined;
  const shown = mine?.phase === "shown" || mine?.phase === "not_found";

  let content: ReactNode;
  if (mine?.phase === "shown") {
    content =
      mine.text === null ? (
        <span className="text-muted-foreground">Not recorded</span>
      ) : (
        <span>{format ? format(mine.text) : mine.text}</span>
      );
  } else if (mine?.phase === "not_found") {
    content = <span className="text-muted-foreground">Not found</span>;
  } else {
    content = <span className="text-muted-foreground">Hidden</span>;
  }

  if (view === undefined) {
    // Outside a section that can run a View there is nothing to ask for, and nothing to show.
    return <span className="text-muted-foreground">Hidden</span>;
  }

  return (
    <span className="flex flex-wrap items-center gap-2">
      <span aria-live="polite">{content}</span>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label={`${shown ? "Hide" : "View"} ${fieldName} for ${subject}`}
        disabled={view.busy}
        focusableWhenDisabled
        onClick={(event) => {
          if (shown) {
            view.hide();
          } else {
            view.begin(target, event.currentTarget);
          }
        }}
      >
        {shown ? "Hide" : "View"}
      </Button>
    </span>
  );
}
